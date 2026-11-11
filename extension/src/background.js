'use strict';
/*
 * background.js - the service worker. Owns the capture run, so the run
 * survives each chapter's page navigation.
 *
 * A run starts from the link pasted into the app page (app.html), which
 * stays where it is and shows the run. The first chapter opens in a
 * background tab next to it, is captured and closed, and then it follows the
 * next button:
 * when it's a link, the following chapters load several at a time in
 * background tabs that close once read, and go into the book in order; when
 * it isn't, it clicks it and waits, one chapter at a time.
 *
 * It stops on its own when:
 *   - the next button is gone or disabled (the last chapter),
 *   - the next link goes back to a chapter already read,
 *   - pressing next doesn't change the chapter within the timeout,
 *   - the chapter that appears is one it already has,
 *   - the new page has no chapter text at all (a "book complete" page, a
 *     store page, a login),
 *   - it hits the chapter cap, or you press Stop.
 *
 * What to read and what to press comes from the config in use (shared.js).
 */
importScripts('shared.js');

var settings = EG.withDefaults();
var run = { status: 'idle', tabId: null, count: 0, message: '', log: [] };
var stopRequested = false;
var bookTabId = null;       // the tab the pickers and the run work on
var lastWebTab = null;      // most recent active tab in a normal window
var ports = new Set();

var ready = chrome.storage.local.get(EG.SETTINGS_KEY).then(function (got) {
  settings = EG.withDefaults(got[EG.SETTINGS_KEY]);
}).then(function () {
  // Duplicates never get in now, but a book from before might have some.
  return ensureLibrary().then(dedupe);
}).then(function () {
  return chrome.storage.session.get(['eg.bookTab', EG.RUN_KEY]);
}).then(function (got) {
  if (got['eg.bookTab'] != null) bookTabId = got['eg.bookTab'];
  var saved = got[EG.RUN_KEY];
  if (saved) {
    run.log = saved.log || [];
    // The worker was shut down mid-run. The run's position is the chapters
    // in storage, so picking it back up is starting again from the last
    // chapter read: it's recognised as the last one stored and it carries on.
    if (saved.status === 'running' && (saved.lastUrl || saved.startUrl)) {
      log('picking the run back up after the browser paused it');
      // Chapter tabs from before can't be trusted to be read in order any
      // more: close them and start again from the last chapter stored.
      (saved.workers || []).forEach(function (id) { chrome.tabs.remove(id).catch(function () {}); });
      startRun(saved.tabId, saved.lastUrl || saved.startUrl, { resumed: true, windowId: saved.windowId });
    }
  }
}).catch(function () {});

// ------------------------------------------------------------------ utils --

var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

function log(message) {
  var line = { at: Date.now(), message: message };
  run.log.push(line);
  if (run.log.length > 200) run.log.splice(0, run.log.length - 200);
  broadcast();
}

function publicRun() {
  return {
    status: run.status, tabId: run.tabId, count: run.count,
    message: run.message, log: run.log.slice(-60),
    // For the overview page.
    startedAt: run.startedAt || 0, endedAt: run.endedAt || 0, config: run.config || '', startUrl: run.startUrl || '',
    pipeline: run.pipeline || [], words: run.words || 0, kind: run.kind || ''
  };
}

function persistRun() {
  var o = {};
  o[EG.RUN_KEY] = {
    status: run.status, tabId: run.tabId, windowId: run.windowId, log: run.log.slice(-60),
    workers: run.workers || [], lastUrl: run.lastUrl || '', startUrl: run.startUrl || ''
  };
  chrome.storage.session.set(o).catch(function () {});
}

var broadcastQueued = false;
function broadcast() {
  if (broadcastQueued) return;
  broadcastQueued = true;
  setTimeout(function () {
    broadcastQueued = false;
    stateForPanel().then(function (s) {
      ports.forEach(function (p) { try { p.postMessage({ t: 'state', state: s }); } catch (e) {} });
    });
    persistRun();
  }, 30);
}

function stateForPanel() {
  return Promise.resolve({ api: EG.API, settings: settings, run: publicRun() });
}

function saveSettings(patch) {
  settings = EG.withDefaults(Object.assign({}, settings, patch));
  var o = {};
  o[EG.SETTINGS_KEY] = settings;
  return chrome.storage.local.set(o).then(broadcast);
}

function setBookTab(id) {
  bookTabId = id;
  chrome.storage.session.set({ 'eg.bookTab': id }).catch(function () {});
}

/** Change the config in use: fn(config) edits it in place. */
function editActiveConfig(fn) {
  var configs = settings.configs.map(function (c) {
    if (c.id !== EG.activeConfig(settings).id) return c;
    var copy = JSON.parse(JSON.stringify(c));
    fn(copy);
    return copy;
  });
  return saveSettings({ configs: configs });
}

/** Add, rename, delete or switch configs. */
function editConfigs(msg) {
  var configs = settings.configs.slice();
  switch (msg.op) {
    case 'select':
      if (!configs.some(function (c) { return c.id === msg.id; })) return Promise.resolve({ ok: false });
      return saveSettings({ activeConfig: msg.id }).then(function () { return { ok: true }; });
    case 'add': {
      var n = configs.length + 1;
      var names = configs.map(function (c) { return c.name; });
      while (names.indexOf('Config ' + n) !== -1) n++;
      var id = 'config-' + Date.now().toString(36);
      configs.push(EG.emptyConfig(id, String(msg.name || '').trim() || 'Config ' + n));
      return saveSettings({ configs: configs, activeConfig: id }).then(function () { return { ok: true, id: id }; });
    }
    case 'rename': {
      var name = String(msg.name || '').trim().slice(0, 60);
      if (!name) return Promise.resolve({ ok: false });
      configs = configs.map(function (c) { return c.id === msg.id ? Object.assign({}, c, { name: name }) : c; });
      return saveSettings({ configs: configs }).then(function () { return { ok: true }; });
    }
    case 'delete': {
      if (configs.length < 2) return Promise.resolve({ ok: false, error: 'There has to be at least one config.' });
      configs = configs.filter(function (c) { return c.id !== msg.id; });
      var active = settings.activeConfig === msg.id ? configs[0].id : settings.activeConfig;
      return saveSettings({ configs: configs, activeConfig: active }).then(function () { return { ok: true }; });
    }
  }
  return Promise.resolve({ ok: false });
}

// ------------------------------------------------------ talking to the tab --

/**
 * Message the content script on a tab, injecting it if it isn't there.
 *
 * It isn't there on a tab that was already open when the extension was
 * installed or reloaded, and it briefly isn't there while a chapter page is
 * navigating - in which case this resolves null and the caller retries.
 */
function send(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg).catch(function (err) {
    return chrome.tabs.get(tabId).then(function (tab) {
      if (!tab || tab.status !== 'complete' || !EG.isHttp(tab.url) && !/^file:/.test(tab.url)) return null;
      return chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['src/shared.js', 'src/capture.js', 'src/content.js']
      }).then(function () {
        return chrome.tabs.sendMessage(tabId, msg);
      });
    }).catch(function () { return null; });
  });
}

function sel() {
  var c = EG.activeConfig(settings);
  return {
    next: c.selectors.next,
    nextText: c.picks.next && c.picks.next.text,
    text: c.selectors.text,
    exclude: c.selectors.exclude
  };
}

// --------------------------------------------------------------- chapters --

function sha256(text) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
    return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  });
}

// One writer at a time, so two quick captures can't both read the old book
// and each write back a copy missing the other's chapter.
var bookLock = Promise.resolve();
function withBook(fn) {
  var next = bookLock.then(function () {
    return chrome.storage.local.get(EG.BOOK_KEY).then(function (got) {
      return fn(EG.bookWithDefaults(got[EG.BOOK_KEY]));
    });
  });
  bookLock = next.catch(function () {});
  return next;
}

/**
 * The same chapter as `meta`, give or take a word: the same first line and
 * nearly the same length. Sites change a line here and there between visits
 * (or post a chapter twice), so the text isn't always identical.
 */
function nearlySame(meta, firstLine, words) {
  var a = String(meta.firstLine || '').trim().toLowerCase(), b = String(firstLine || '').trim().toLowerCase();
  if (!a || a !== b) return false;
  var w1 = meta.words || 0, w2 = words || 0;
  return Math.abs(w1 - w2) <= Math.max(3, 0.03 * Math.max(w1, w2));
}

/**
 * Store a captured chapter.
 *
 * resolves { added } | { duplicate, of } | { same } - `same` meaning it is the
 * chapter already stored last (what you get when you start on the page you
 * stopped on, or when a site posts a chapter twice in a row); it isn't added.
 */
function addChapter(cap, opts) {
  opts = opts || {};
  return sha256(EG.normalizeText(cap.text)).then(function (hash) {
    return withBook(function (book) {
      var idx = -1;
      for (var i = 0; i < book.chapters.length; i++) if (book.chapters[i].hash === hash) { idx = i; break; }
      var last = book.chapters[book.chapters.length - 1];
      if (idx !== -1) {
        if (opts.allowSameAsLast && idx === book.chapters.length - 1) return { same: true, number: idx + 1 };
        return { duplicate: true, of: idx + 1 };
      }
      // (The address only counts when starting: a page that swaps chapters
      // in place keeps the same one throughout.)
      var sameUrl = opts.allowSameAsLast && last && urlKey(last.url) === urlKey(cap.url);
      if (last && (sameUrl || nearlySame(last, firstLineOf(cap.blocks), cap.words))) {
        return { same: true, number: book.chapters.length };
      }
      if (!book.title && cap.pageTitle) book.title = guessBookTitle(cap.pageTitle);
      return chrome.storage.local.get(EG.LIBRARY_KEY).then(function (got) {
        // Chapter ids are unique across every book on the shelf, since their
        // bodies all live side by side in storage.
        var lib = got[EG.LIBRARY_KEY] || { books: {} };
        var id = Math.max(book.nextId, lib.nextChapterId || 1);
        book.nextId = id + 1;
        lib.nextChapterId = id + 1;
        lib.activeId = book.id || lib.activeId;
        var meta = {
          id: id,
          url: cap.url,
          firstLine: firstLineOf(cap.blocks),
          words: cap.words,
          hash: hash
        };
        book.chapters.push(meta);
        var o = {};
        o[EG.CHAPTER_PREFIX + id] = { id: id, url: cap.url, blocks: cap.blocks, capturedAt: Date.now() };
        o[EG.BOOK_KEY] = book;
        o[EG.LIBRARY_KEY] = lib;
        return chrome.storage.local.set(o).then(function () {
          return { added: true, number: book.chapters.length, meta: meta };
        });
      });
    });
  });
}

function firstLineOf(blocks) {
  for (var i = 0; i < blocks.length; i++) if (blocks[i].tag !== 'hr' && blocks[i].text) return blocks[i].text.slice(0, 200);
  return '';
}

// "Chapter 12 - The Long Road | Some Site" -> "The Long Road" is not knowable,
// but the site name usually comes last; the part before it is a decent start
// that you'll want to edit anyway.
function guessBookTitle(pageTitle) {
  var parts = String(pageTitle).split(/\s+[|\-–—:]\s+/).map(function (s) { return s.trim(); }).filter(Boolean);
  var nonChapter = parts.filter(function (p) { return !/^(chapter|ch\.?|part|episode|ep\.?)\s*\d+/i.test(p); });
  return (nonChapter[0] || parts[0] || '').slice(0, 120);
}

// ------------------------------------------------------------------- undo --
//
// Removing or reordering chapters can be undone, newest first, even after the
// page is closed: each change saves the chapter list as it was under its own
// key (eg.undo.<n>), and the book keeps the list of those keys. A removed
// chapter's text stays in storage until the change that removed it falls off
// the end of the list (or its book is deleted).

var UNDO_LIMIT = 30;
var UNDO_PREFIX = 'eg.undo.';

function undoKey() { return UNDO_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

/**
 * Note `before` (the chapter list before a change) on the book's undo list.
 * Resolves the storage writes and removals to make along with the change.
 */
function pushUndo(book, before, label, removedIds) {
  var key = undoKey();
  var o = {}, remove = [];
  o[key] = { label: label, chapters: before, removed: removedIds || [] };
  book.undo = (Array.isArray(book.undo) ? book.undo : []).concat([key]);
  var expired = book.undo.length > UNDO_LIMIT ? book.undo.splice(0, book.undo.length - UNDO_LIMIT) : [];
  if (!expired.length) return Promise.resolve({ set: o, remove: remove });
  // Changes that can no longer be undone: the text they kept can go, unless
  // the chapter is back in the book.
  return chrome.storage.local.get(expired).then(function (got) {
    var inBook = {};
    book.chapters.forEach(function (c) { inBook[c.id] = 1; });
    expired.forEach(function (k) {
      ((got[k] || {}).removed || []).forEach(function (id) {
        if (!inBook[id]) remove.push(EG.CHAPTER_PREFIX + id);
      });
      remove.push(k);
    });
    return { set: o, remove: remove };
  });
}

/** Everything a book keeps in storage besides itself: chapter text, undo. */
function storageOf(book) {
  var keys = (Array.isArray(book.undo) ? book.undo : []).slice();
  return chrome.storage.local.get(keys).then(function (got) {
    var ids = {};
    book.chapters.forEach(function (c) { ids[c.id] = 1; });
    keys.forEach(function (k) { ((got[k] || {}).removed || []).forEach(function (id) { ids[id] = 1; }); });
    return keys.concat(Object.keys(ids).map(function (id) { return EG.CHAPTER_PREFIX + id; }));
  });
}

/** Put `ids` in this order (anything not listed keeps its place at the end). */
function inOrder(chapters, ids) {
  var byId = {};
  chapters.forEach(function (c) { byId[c.id] = c; });
  var out = [];
  ids.forEach(function (id) { if (byId[id]) { out.push(byId[id]); delete byId[id]; } });
  chapters.forEach(function (c) { if (byId[c.id]) out.push(c); });
  return out;
}

/**
 * Every change to the book goes through here, under the same lock the run
 * uses, so an edit on the page can't race a chapter being added.
 */
function editBook(msg) {
  return withBook(async function (book) {
    var before = book.chapters.map(function (c) { return Object.assign({}, c); });
    var undoLabel = null, removed = [], removeNow = [], o = {}, remove = [];
    var i = book.chapters.findIndex(function (c) { return c.id === msg.id; });
    switch (msg.op) {
      case 'meta':
        ['title', 'author', 'titleMode', 'lastUrl', 'nextUrl'].forEach(function (k) {
          if (typeof msg[k] === 'string') book[k] = msg[k];
        });
        break;
      case 'rename':
        if (i !== -1) {
          if (msg.title && msg.title.trim()) book.chapters[i].title = msg.title;
          else delete book.chapters[i].title;
        }
        break;
      case 'delete':
      case 'remove': {
        // One chapter (id), several (ids), or all of them (all).
        var gone = {};
        (msg.all ? book.chapters.map(function (c) { return c.id; }) : msg.ids || [msg.id]).forEach(function (id) { gone[id] = 1; });
        book.chapters = book.chapters.filter(function (c) {
          if (gone[c.id]) { removed.push(c.id); return false; }
          return true;
        });
        if (!removed.length) return { ok: true, removed: 0 };
        undoLabel = 'remove';
        break;
      }
      case 'order': {
        var next = inOrder(book.chapters, msg.ids || []);
        if (next.every(function (c, k) { return c === book.chapters[k]; })) return { ok: true };
        book.chapters = next;
        undoLabel = 'reorder';
        break;
      }
      case 'move': {
        var j = i + (msg.by || 0);
        if (i !== -1 && j >= 0 && j < book.chapters.length) {
          var c = book.chapters.splice(i, 1)[0];
          book.chapters.splice(j, 0, c);
          undoLabel = 'reorder';
        }
        break;
      }
      case 'dedupe': {
        var seen = {};
        book.chapters = book.chapters.filter(function (c) {
          if (seen[c.hash]) { removed.push(c.id); return false; }
          seen[c.hash] = 1;
          return true;
        });
        if (!removed.length) return { ok: true, removed: 0 };
        undoLabel = 'dedupe';
        break;
      }
      case 'undo': {
        var keys = Array.isArray(book.undo) ? book.undo : [];
        if (!keys.length) return { ok: false, error: 'Nothing to undo.' };
        var key = keys[keys.length - 1];
        var got = await chrome.storage.local.get(key);
        var entry = got[key];
        book.undo = keys.slice(0, -1);
        remove.push(key);
        if (entry) {
          // The list as it was, plus any chapter added since (a run going on).
          var had = {};
          entry.chapters.forEach(function (c) { had[c.id] = 1; });
          book.chapters = entry.chapters.concat(book.chapters.filter(function (c) { return !had[c.id]; }));
        }
        break;
      }
    }
    if (undoLabel) {
      var u = await pushUndo(book, before, undoLabel, removed);
      Object.assign(o, u.set);
      remove = remove.concat(u.remove);
    }
    o[EG.BOOK_KEY] = book;
    await chrome.storage.local.set(o);
    remove = remove.concat(removeNow).filter(function (k) { return !(k in o); });
    if (remove.length) await chrome.storage.local.remove(remove);
    return { ok: true, removed: removed.length, undo: (book.undo || []).length };
  });
}

// ---------------------------------------------------------------- library --
//
// One book is worked on at a time and lives at eg.book, as it always has. The
// others are put aside on the shelf (eg.shelf.<id>) with a summary in the
// library, and swapped back in when you pick them. Chapter bodies stay where
// they are (eg.ch.<chapter id>), so swapping a 3000-chapter book is cheap.

function newBookId() { return 'book-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function summaryOf(book) {
  return {
    id: book.id, title: book.title, author: book.author, count: book.chapters.length,
    words: book.chapters.reduce(function (n, c) { return n + (c.words || 0); }, 0),
    updatedAt: Date.now()
  };
}

function withLibrary(fn) {
  return withBook(function (book) {
    return chrome.storage.local.get(EG.LIBRARY_KEY).then(function (got) {
      var lib = got[EG.LIBRARY_KEY] || {};
      lib.books = lib.books || {};
      return fn(book, lib);
    });
  });
}

/** Give the current book an id and the library its first entry. */
function ensureLibrary() {
  return withLibrary(function (book, lib) {
    if (book.id && lib.activeId === book.id && lib.nextChapterId) return;
    if (!book.id) book.id = newBookId();
    lib.activeId = book.id;
    lib.nextChapterId = Math.max(lib.nextChapterId || 1, book.nextId);
    var o = {};
    o[EG.BOOK_KEY] = book;
    o[EG.LIBRARY_KEY] = lib;
    return chrome.storage.local.set(o);
  });
}

/** New book, switch to a shelved one, or delete one (and its chapters). */
function libraryOp(msg) {
  if (run.status === 'running') return Promise.resolve({ ok: false, error: 'Stop the capture first.' });
  return withLibrary(async function (book, lib) {
    var o = {}, remove = [], next = null;

    function shelve() {
      o[EG.SHELF_PREFIX + book.id] = book;
      lib.books[book.id] = summaryOf(book);
    }
    async function takeOffShelf(id) {
      var got = await chrome.storage.local.get(EG.SHELF_PREFIX + id);
      var b = got[EG.SHELF_PREFIX + id];
      if (!b) return null;
      remove.push(EG.SHELF_PREFIX + id);
      delete lib.books[id];
      return EG.bookWithDefaults(b);
    }
    function fresh() {
      return EG.bookWithDefaults({ id: newBookId(), nextId: lib.nextChapterId || book.nextId });
    }

    switch (msg.op) {
      case 'new':
        shelve();
        next = fresh();
        break;
      case 'switch':
        if (msg.id === book.id) return { ok: true };
        next = await takeOffShelf(msg.id);
        if (!next) return { ok: false, error: 'That book isn\'t there any more.' };
        shelve();
        break;
      case 'delete':
        if (msg.id === book.id) {
          remove = remove.concat(await storageOf(book));
          // Carry on with the book worked on most recently, or a new one.
          var ids = Object.keys(lib.books).sort(function (a, b) { return lib.books[b].updatedAt - lib.books[a].updatedAt; });
          next = (ids.length && await takeOffShelf(ids[0])) || fresh();
        } else {
          var got = await chrome.storage.local.get(EG.SHELF_PREFIX + msg.id);
          var gone = got[EG.SHELF_PREFIX + msg.id];
          if (!gone) return { ok: false, error: 'That book isn\'t there any more.' };
          remove = remove.concat(await storageOf(EG.bookWithDefaults(gone)), [EG.SHELF_PREFIX + msg.id]);
          delete lib.books[msg.id];
        }
        break;
      default:
        return { ok: false };
    }

    if (next) {
      lib.activeId = next.id;
      o[EG.BOOK_KEY] = next;
    }
    lib.nextChapterId = Math.max(lib.nextChapterId || 1, book.nextId, next ? next.nextId : 1);
    o[EG.LIBRARY_KEY] = lib;
    await chrome.storage.local.set(o);
    // Never remove something that was just written (a book coming off the
    // shelf is written to eg.book, not back to its shelf key).
    remove = remove.filter(function (k) { return !(k in o); });
    if (remove.length) await chrome.storage.local.remove(remove);
    if (next) await saveSettings({ startUrl: next.nextUrl || next.lastUrl || '' });
    return { ok: true, id: next ? next.id : book.id };
  });
}

// ------------------------------------------------------------------- run --

function setRun(patch) {
  Object.assign(run, patch);
  broadcast();
}

function finish(message, kind) {
  setRun({ status: 'idle', message: message, kind: kind || '', endedAt: Date.now(), pipeline: [] });
  log((kind === 'error' ? '⚠ ' : '■ ') + message);
  chrome.action.setBadgeText({ text: '' }).catch(function () {});
  // The link box gets where to carry on from next time. At the end of the
  // book that's the last chapter read (Start sees it's already in, and
  // follows its next button if there's a new chapter by then). When the run
  // was stopped partway, it's the chapter after the last one read, so
  // nothing is read twice.
  var partway = message === 'Stopped.' || kind === 'error';
  var carryOn = (partway && run.nextUrl) || run.lastUrl;
  if (carryOn) {
    saveSettings({ startUrl: carryOn });
    editBook({ op: 'meta', lastUrl: run.lastUrl || '', nextUrl: partway ? run.nextUrl || '' : '' }).catch(function () {});
  }
  dedupe();
}

/** Drop any chapter whose text is already in the book. */
function dedupe() {
  return editBook({ op: 'dedupe' }).then(function (r) {
    if (r && r.removed) log('removed ' + r.removed + ' duplicate chapter' + (r.removed === 1 ? '' : 's'));
  }).catch(function () {});
}

function startRun(homeTabId, url, opts) {
  opts = opts || {};
  if (run.status === 'running') return { ok: false, error: 'already capturing' };
  var cfg = EG.activeConfig(settings);
  if (!cfg.selectors.text.length) return { ok: false, error: 'Pick the chapter text area for ' + cfg.name + ' first.' };
  if (!cfg.selectors.next.length && !settings.fallbackNext) return { ok: false, error: 'Pick the next chapter button for ' + cfg.name + ' first.' };
  if (!EG.isHttp(url)) return { ok: false, error: 'Paste the link to the chapter you want to start from.' };
  stopRequested = false;
  setRun({
    status: 'running', tabId: homeTabId, windowId: opts.windowId, count: 0, message: 'opening the first chapter',
    workers: [], lastUrl: '', nextUrl: '', startUrl: url, startedAt: Date.now(), endedAt: 0, config: cfg.name,
    pipeline: [{ n: 0, state: 'loading' }], words: 0, kind: ''
  });
  if (!opts.resumed) log('▶ started on ' + url + ' with ' + cfg.name);
  runLoop(homeTabId, url).catch(function (e) {
    finish('Something went wrong: ' + (e && e.message || e), 'error');
  });
  return { ok: true };
}

function badge() {
  chrome.action.setBadgeText({ text: String(run.count) }).catch(function () {});
  chrome.action.setBadgeBackgroundColor({ color: '#16a34a' }).catch(function () {});
}

/** Count a chapter that just went into the book. */
function counted(r) {
  setRun({ count: run.count + 1, words: (run.words || 0) + (r.meta.words || 0) });
  log('chapter ' + r.number + ': ' + label(r.meta));
  badge();
}

/**
 * Open the first chapter in a background tab next to the overview, read it,
 * close it, and carry on from its next button.
 */
async function runLoop(homeTabId, url) {
  await dedupe();
  var home = homeTabId != null ? await chrome.tabs.get(homeTabId).catch(function () { return null; }) : null;
  var windowId = home ? home.windowId : run.windowId;
  if (windowId == null) {
    var w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(function () { return null; });
    windowId = w && w.id;
  }
  run.windowId = windowId;
  var first = await chrome.tabs.create(Object.assign(
    { windowId: windowId, url: url, active: false }, home ? { index: home.index + 1 } : {}
  )).catch(function () { return null; });
  if (!first) return finish('Couldn\'t open a tab for the first chapter.', 'error');
  chrome.tabs.update(first.id, { autoDiscardable: false }).catch(function () {});
  setRun({ workers: [first.id] });

  try {
    var cap = await captureWhenReady(first.id, settings.timeout * 1000);
    if (stopRequested) return finish('Stopped.');
    if (cap && cap.limited) return finish('The first chapter: ' + LIMITED_MSG, 'error');
    if (!cap) {
      return finish('Couldn\'t find the chapter text on that page. Is ' + EG.activeConfig(settings).name + ' the right config for this site?', 'error');
    }
    setRun({ lastUrl: cap.url });
    var r = await addChapter(cap, { allowSameAsLast: true });
    if (r.duplicate) {
      return finish('That link is chapter ' + r.of + ', which is already captured. Paste the link to the chapter after the last one you have, or remove chapters to recapture them.', 'error');
    }
    if (r.added) counted(r);
    else log('that link is chapter ' + r.number + ', already captured - carrying on from there');
    badge();

    // A next button that's a link: open the chapters at its address, several
    // at a time. Anything else (a button that loads the chapter in place,
    // say): click it, one chapter at a time, in this tab.
    var p = await send(first.id, { t: 'probe', sel: sel(), allowGuess: settings.fallbackNext, phrases: settings.refreshPhrases });
    if (p && p.nextFound && !p.nextDisabled && p.nextHref) {
      chrome.tabs.remove(first.id).catch(function () {});
      return await runLinked(windowId, homeTabId, url, cap, p);
    }
    return await runClicking(first.id, cap);
  } finally {
    chrome.tabs.remove(first.id).catch(function () {});
  }
}

function urlKey(u) { return String(u || '').split('#')[0]; }

/**
 * Link mode. Chapter N's page says where chapter N+1 is, so as soon as a page
 * is far enough along to show its next link, the next chapter opens in a
 * background tab - up to `parallel` loading at once, `delay` seconds apart.
 * Each tab is read once its text has settled and closed straight after.
 *
 * Tabs finish in whatever order the site serves them; chapters go into the
 * book strictly in order (a finished chapter waits for the ones before it).
 *
 * The end is the first chapter that has no next link (or a disabled one), or
 * whose next link goes back to a page already read; or a page with no
 * chapter text on it, or a chapter that repeats one already in the book -
 * in which case everything from there on is dropped.
 */
async function runLinked(windowId, homeTabId, startUrl, firstCap, firstProbe) {
  var startTotal = await chapterTotal();
  var timeoutMs = settings.timeout * 1000;
  var K = settings.parallel;
  var gapMs = settings.delay * 1000;
  var room = Math.max(0, settings.maxChapters - startTotal);

  var visited = new Set([urlKey(startUrl), urlKey(firstCap.url)]);
  var frontier = [];                 // {seq, url} waiting to be opened
  var open = new Map();              // seq -> tab state
  var done = new Map();              // seq -> captured chapter
  var commit = 1;                    // next seq to go into the book
  var endSeq = room;                 // last seq that belongs in the book
  var endWhy = { msg: 'Hit the ' + settings.maxChapters + '-chapter limit.', limit: true };
  var lastOpen = 0;
  var lastUrl = firstCap.url;
  var pauseUntil = 0;                // no new tabs while the site wants a breather

  log('next is a link - loading up to ' + K + ' chapter' + (K === 1 ? '' : 's') + ' at once in background tabs');

  function setEnd(seq, why) {
    if (seq > endSeq || (seq === endSeq && !endWhy.limit)) return;   // an earlier end stands
    endSeq = seq;
    endWhy = why;
    frontier = frontier.filter(function (f) { return f.seq <= endSeq; });
    open.forEach(function (o, k) { if (k > endSeq) closeTab(o); });
    done.forEach(function (_, k) { if (k > endSeq) done.delete(k); });
  }

  function closeTab(o) {
    open.forEach(function (v, k) { if (v === o) open.delete(k); });
    chrome.tabs.remove(o.tabId).catch(function () {});
  }

  function follow(seq, probe) {
    // probe is chapter `seq`'s page; it decides what chapter seq+1 is.
    if (probe.nextDisabled) return setEnd(seq, { msg: 'The next chapter button is disabled - that\'s the end of the book.' });
    if (!probe.nextHref) return setEnd(seq, { msg: 'The next button on chapter ' + (startTotal + seq) + ' isn\'t a link, so the run stops there. Start again from that chapter to carry on by clicking.', kind: 'error' });
    var key = urlKey(probe.nextHref);
    if (visited.has(key)) return setEnd(seq, { msg: 'The next chapter link goes back to a chapter already read - that\'s the end of the book.' });
    visited.add(key);
    urlOf[seq + 1] = probe.nextHref;
    if (seq + 1 <= endSeq) frontier.push({ seq: seq + 1, url: probe.nextHref });
  }

  // Where each chapter is, so a stopped run knows where the next one starts.
  var urlOf = {};
  follow(0, firstProbe);
  run.nextUrl = urlOf[1] || '';
  var workerIds = function () { return Array.from(open.values()).map(function (o) { return o.tabId; }); };

  try {
    for (;;) {
      if (stopRequested) { endWhy = { msg: 'Stopped.' }; break; }
      var win = await chrome.windows.get(windowId).catch(function () { return null; });
      if (!win) { endWhy = { msg: 'The window was closed.', kind: 'error' }; break; }
      // Chapter tabs go just after the overview, when it's still open.
      var home = homeTabId != null ? await chrome.tabs.get(homeTabId).catch(function () { return null; }) : null;

      // Open whatever is due.
      while (frontier.length && open.size < K && Date.now() - lastOpen >= gapMs && Date.now() >= pauseUntil) {
        var f = frontier.shift();
        var t = await chrome.tabs.create({
          windowId: windowId, index: home && home.windowId === windowId ? home.index + 1 + open.size : undefined,
          url: f.url, active: false
        }).catch(function () { return null; });
        if (!t) { endWhy = { msg: 'Couldn\'t open a tab for the next chapter.', kind: 'error' }; break; }
        chrome.tabs.update(t.id, { autoDiscardable: false }).catch(function () {});
        open.set(f.seq, { tabId: t.id, url: f.url, seq: f.seq, openedAt: Date.now(), last: null, streak: 0, followed: false, reloads: 0, completeAt: 0, limited: false, retryAt: 0, graceUntil: 0, limitHits: 0 });
        lastOpen = Date.now();
      }
      run.workers = workerIds();

      // Look at every loading chapter at once.
      await Promise.all(Array.from(open.values()).map(async function (o) {
        var tab = await chrome.tabs.get(o.tabId).catch(function () { return null; });
        if (!tab) { o.gone = true; return; }
        if (tab.status === 'complete' && !o.completeAt) o.completeAt = Date.now();
        var pr = await send(o.tabId, { t: 'probe', sel: sel(), allowGuess: settings.fallbackNext, phrases: settings.refreshPhrases });
        if (!pr) return;
        // Just refreshed: the old "rate limited" page can linger a moment.
        if (pr.limited && Date.now() >= o.graceUntil) o.limited = true;
        if (pr.limited) return;
        if (!o.followed && pr.nextFound) { o.followed = true; follow(o.seq, pr); }
        if (pr.textFound) {
          if (pr.sig === o.last) o.streak++;
          else { o.last = pr.sig; o.streak = 1; }
          if (o.streak >= 3 && !o.cap) {
            var c = await captureNow(o.tabId);
            if (c && c.sig === pr.sig) o.cap = c;
            else o.streak = 0;
          }
        } else {
          o.last = null; o.streak = 0;
        }
      }));
      if (stopRequested) { endWhy = { msg: 'Stopped.' }; break; }

      // Settle each tab: read, ended, or given up on.
      Array.from(open.values()).forEach(function (o) {
        if (o.gone) { open.delete(o.seq); setEnd(o.seq - 1, { msg: 'A chapter tab was closed - stopping before it.', kind: 'error' }); return; }
        if (o.limited) {
          // The site is rate limiting or showing a browser check: stop before
          // this chapter instead of retrying.
          setEnd(o.seq - 1, { msg: 'Chapter ' + (startTotal + o.seq) + ': ' + LIMITED_MSG, kind: 'error' });
          closeTab(o);
          return;
        }
        if (o.cap) {
          if (!o.followed) {
            // Text settled and no next button. Give a slow page a moment to
            // draw one; if it doesn't, this is the last chapter.
            o.capAt = o.capAt || Date.now();
            if (!o.completeAt && Date.now() - o.capAt < 3000) return;
            setEnd(o.seq, { msg: 'No next chapter button on the last page - that\'s the end of the book.' });
          }
          if (o.seq <= endSeq) done.set(o.seq, o.cap);
          closeTab(o);
          return;
        }
        var age = Date.now() - o.openedAt;
        // Finished loading 3s ago and never showed any text: not a chapter.
        var loadedNoText = o.completeAt && Date.now() - o.completeAt > 3000 && !o.last;
        if (!loadedNoText && age <= timeoutMs) return;
        if (!loadedNoText && !o.last && o.reloads === 0) {
          // Timed out without ever showing text - maybe a hiccup. One more go.
          o.reloads++; o.openedAt = Date.now(); o.completeAt = 0;
          chrome.tabs.reload(o.tabId).catch(function () {});
          return;
        }
        if (!o.last) {
          setEnd(o.seq - 1, { msg: 'The page after chapter ' + (startTotal + o.seq - 1) + ' has no chapter text - looks like the end of the book (or the site changed its layout).' });
        } else {
          setEnd(o.seq - 1, { msg: 'Chapter ' + (startTotal + o.seq) + ' kept changing and never settled - stopping before it.', kind: 'error' });
        }
        closeTab(o);
      });

      // Into the book, in order.
      while (done.has(commit) && commit <= endSeq) {
        var cap = done.get(commit);
        done.delete(commit);
        var r = await addChapter(cap);
        if (r.duplicate) { setEnd(commit - 1, { msg: 'Chapter ' + (startTotal + commit) + ' repeats chapter ' + r.of + ' - that\'s the end of the book.' }); break; }
        lastUrl = cap.url;
        run.lastUrl = lastUrl;
        run.nextUrl = urlOf[commit + 1] || '';
        if (r.added) counted(r);
        else log('skipped a page that repeats chapter ' + r.number);
        commit++;
        startTotal -= r.added ? 0 : 1;
      }
      var waiting = Math.ceil((pauseUntil - Date.now()) / 1000);
      // What each chapter in flight is doing, for the overview's lanes.
      var lanes = [];
      open.forEach(function (o) {
        lanes.push({
          n: startTotal + o.seq,
          state: o.limited || o.retryAt ? 'limited' : o.cap ? 'read' : o.last ? 'reading' : 'loading',
          retryIn: o.retryAt ? Math.max(0, Math.ceil((o.retryAt - Date.now()) / 1000)) : 0
        });
      });
      done.forEach(function (_, k) { lanes.push({ n: startTotal + k, state: 'waiting' }); });
      lanes.sort(function (a, b) { return a.n - b.n; });
      setRun({
        message: (waiting > 0 ? 'rate limited - refreshing in ' + waiting + 's · ' : '') +
          open.size + ' loading' + (done.size ? ', ' + done.size + ' waiting their turn' : ''),
        lastUrl: lastUrl,
        pipeline: lanes
      });

      if (commit > endSeq) break;
      if (!open.size && !frontier.length && !done.size) {
        if (endWhy.limit) endWhy = { msg: 'Ran out of chapters to open.', kind: 'error' };
        break;
      }
      await sleep(200);
    }
  } finally {
    open.forEach(function (o) { chrome.tabs.remove(o.tabId).catch(function () {}); });
    open.clear();
    run.workers = [];
  }

  var total = await chapterTotal();
  finish(endWhy.msg + (endWhy.msg === 'Stopped.' ? '' : ' ' + total + ' chapters.'), endWhy.kind);
}

/**
 * Click mode, for a next button that isn't a link: press it where it is,
 * wait for the next chapter, repeat - one at a time, in the book tab.
 */
async function runClicking(tabId, cap) {
  log('next isn\'t a link - clicking it, one chapter at a time');
  for (;;) {
    if (stopRequested) return finish('Stopped.');
    var total = await chapterTotal();
    if (total >= settings.maxChapters) return finish('Hit the ' + settings.maxChapters + '-chapter limit.');

    if (settings.delay > 0) {
      setRun({ message: 'waiting ' + settings.delay + 's' });
      await sleep(settings.delay * 1000);
      if (stopRequested) return finish('Stopped.');
    }

    setRun({ message: 'pressing next', pipeline: [{ n: total + 1, state: 'loading' }] });
    var click = await send(tabId, { t: 'clickNext', sel: sel(), allowGuess: settings.fallbackNext });
    if (!click) return finish('Lost the book tab (closed, or it went somewhere the extension can\'t run).', 'error');
    if (!click.found) return finish('No next chapter button on this page - that\'s the end of the book. ' + total + ' chapters.');
    if (click.disabled) return finish('The next chapter button is disabled - that\'s the end of the book. ' + total + ' chapters.');
    if (click.guessed) log('the picked next button wasn\'t on this page; pressed "' + click.label + '" instead');

    setRun({ message: 'waiting for the next chapter' });
    var tab = await chrome.tabs.get(tabId).catch(function () { return null; });
    if (!tab) return finish('The book tab was closed.', 'error');
    var res = await waitForNewChapter(tabId, cap.sig, settings.timeout * 1000);
    if (stopRequested) return finish('Stopped.');
    if (res.end) return finish(res.end + ' ' + total + ' chapters.');
    if (!res.ok) return finish(res.reason + ' ' + total + ' chapters.', res.kind);
    cap = res.cap;

    var added = await addChapter(cap);
    if (added.duplicate) {
      return finish('This chapter repeats chapter ' + added.of + ' - that\'s the end of the book. ' + total + ' chapters.');
    }
    setRun({ lastUrl: cap.url });
    if (added.added) counted(added);
    else log('skipped a page that repeats chapter ' + added.number);
  }
}

function label(meta) {
  var t = (meta.firstLine || '').slice(0, 60);
  return (t ? '"' + t + '"' : '(no text)') + ' · ' + meta.words.toLocaleString() + ' words';
}

function chapterTotal() {
  return chrome.storage.local.get(EG.BOOK_KEY).then(function (got) {
    return EG.bookWithDefaults(got[EG.BOOK_KEY]).chapters.length;
  });
}

/** The chapter on screen, once its text is there and has stopped changing. */
async function captureWhenReady(tabId, timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  var last = null;
  while (Date.now() < deadline && !stopRequested) {
    var p = await send(tabId, { t: 'probe', sel: sel(), phrases: settings.refreshPhrases });
    if (p && p.limited) return { limited: true };
    if (p && p.textFound) {
      if (p.sig === last) return captureNow(tabId);
      last = p.sig;
    }
    await sleep(350);
  }
  return null;
}

var LIMITED_MSG = 'the site is rate limiting or showing a browser check, so the run stopped. Wait a while, then press Start to carry on.';

async function captureNow(tabId) {
  var c = await send(tabId, { t: 'capture', sel: sel() });
  return c && c.ok ? c : null;
}

/**
 * After a click: wait until the chapter text is there, is a different chapter
 * from the one before, and has held still for three looks in a row (sites
 * that load the text in pieces would otherwise get captured half done).
 *
 * It deliberately doesn't wait for the tab to say it's finished loading:
 * chapter sites full of ads and trackers often never do.
 */
async function waitForNewChapter(tabId, beforeSig, timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  var last = null, streak = 0, sawNew = false, sawText = false;
  await sleep(300);
  while (Date.now() < deadline) {
    if (stopRequested) return { ok: false, reason: 'Stopped.' };
    var tab = await chrome.tabs.get(tabId).catch(function () { return null; });
    if (!tab) return { ok: false, reason: 'The book tab was closed.', kind: 'error' };
    var p = await send(tabId, { t: 'probe', sel: sel(), phrases: settings.refreshPhrases });
    if (p && p.limited) return { ok: false, reason: 'The next page: ' + LIMITED_MSG, kind: 'error' };
    if (!p || !p.textFound) {
      last = null;
    } else {
      sawText = true;
      if (p.sig === beforeSig) {
        last = null;
      } else {
        sawNew = true;
        if (p.sig === last) streak++;
        else { last = p.sig; streak = 1; }
        if (streak >= 3) {
          var cap = await captureNow(tabId);
          if (cap && cap.sig === p.sig) return { ok: true, cap: cap };
          last = null;
        }
      }
    }
    await sleep(250);
  }
  if (!sawNew && sawText) {
    return { ok: false, end: 'Pressing next didn\'t change the chapter - that\'s the end of the book.' };
  }
  if (!sawText) {
    return { ok: false, end: 'The page after pressing next has no chapter text - looks like the end of the book (or the site changed its layout).' };
  }
  return { ok: false, reason: 'The next chapter kept changing and never settled.', kind: 'error' };
}

// ------------------------------------------------------------------ picks --

/**
 * The page to pick on or highlight: the chapter page opened for picking
 * (from the link in the link box), else the last web page you looked at.
 */
var pickTabId = null;
var pickTabUrl = '';

async function targetTab() {
  if (pickTabId != null) {
    var t = await chrome.tabs.get(pickTabId).catch(function () { return null; });
    if (t) return t;
    pickTabId = null;
  }
  return lastWebTab ? chrome.tabs.get(lastWebTab.id).catch(function () { return null; }) : null;
}

/** Open (or reuse) a tab on the pasted chapter link, to pick on. */
async function pickTab() {
  var url = settings.startUrl;
  if (!EG.isHttp(url)) return null;
  var t = pickTabId != null ? await chrome.tabs.get(pickTabId).catch(function () { return null; }) : null;
  if (t && pickTabUrl === url) return t;
  var app = await appTab();
  if (t) {
    t = await chrome.tabs.update(t.id, { url: url });
  } else {
    t = await chrome.tabs.create(Object.assign({ url: url, active: true },
      app ? { windowId: app.windowId, index: app.index + 1 } : {}));
  }
  pickTabId = t.id;
  pickTabUrl = url;
  return t;
}

async function startPicker(slot) {
  var tab = await pickTab();
  if (!tab) {
    return { ok: false, error: 'Can\'t select the ' + (slot === 'next' ? 'next chapter button' : 'chapter text area') +
      ' without a chapter link. Paste one in the starting chapter link box first.' };
  }
  setBookTab(tab.id);
  await chrome.windows.update(tab.windowId, { focused: true }).catch(function () {});
  await chrome.tabs.update(tab.id, { active: true }).catch(function () {});
  // A tab that was just opened needs a moment before it can be picked on.
  var deadline = Date.now() + 15000, r = null;
  while (!r && Date.now() < deadline) {
    r = await send(tab.id, { t: 'startPicker', slot: slot });
    if (!r) await sleep(300);
  }
  return r ? { ok: true } : { ok: false, error: 'That page can\'t be picked on - check the link and try again.' };
}

function applyPick(msg, tab) {
  var cands = (msg.candidates || []).map(function (c) { return { type: c.type, value: c.value }; });
  if (!cands.length) { log('couldn\'t build a selector for that element - try one around it'); return; }
  if (tab) setBookTab(tab.id);
  editActiveConfig(function (c) {
    if (msg.slot === 'exclude') {
      c.selectors.exclude.push({
        type: cands[0].type, value: cands[0].value, label: msg.label, text: (msg.text || '').slice(0, 50)
      });
      log('leaving out ' + cands[0].value);
    } else {
      // The best few, so a chapter page laid out a little differently still
      // finds it by the next one down the list.
      c.selectors[msg.slot] = cands.slice(0, 4);
      c.picks[msg.slot] = {
        tag: msg.tag, label: msg.label, text: msg.text, words: msg.words,
        firstLine: msg.firstLine, url: msg.url, selector: cands[0].value
      };
      log(c.name + ': ' + (msg.slot === 'next' ? 'next button' : 'chapter text') + ' set to ' + cands[0].value);
    }
  });
  focusApp();
}

// ---------------------------------------------------------------- the app --
//
// Everything lives on one page (app.html), opened by the toolbar icon.

var APP_URL = chrome.runtime.getURL('src/app.html');

function appTab() {
  return chrome.tabs.query({ url: APP_URL }).then(function (tabs) { return tabs[0] || null; }).catch(function () { return null; });
}

async function openApp() {
  var tab = await appTab();
  if (tab) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(function () {});
    return chrome.tabs.update(tab.id, { active: true });
  }
  return chrome.tabs.create({ url: APP_URL, active: true });
}

function focusApp() {
  appTab().then(function (tab) {
    if (!tab) return;
    chrome.windows.update(tab.windowId, { focused: true }).catch(function () {});
    chrome.tabs.update(tab.id, { active: true }).catch(function () {});
  });
}

chrome.action.onClicked.addListener(function () { openApp(); });

// Remember the last web page you were looking at, for "use the tab in front".
function noteActive(tabId) {
  chrome.tabs.get(tabId).then(function (tab) {
    if (!tab || !(EG.isHttp(tab.url) || /^file:/.test(tab.url || ''))) return;
    return chrome.windows.get(tab.windowId).then(function (win) {
      if (win.type !== 'normal') return;
      lastWebTab = { id: tab.id, title: tab.title, url: tab.url };
    });
  }).catch(function () {});
}
chrome.tabs.onActivated.addListener(function (info) { noteActive(info.tabId); });
chrome.tabs.onUpdated.addListener(function (tabId, change, tab) {
  if (tab.active && (change.status === 'complete' || change.title)) noteActive(tabId);
});
chrome.tabs.onRemoved.addListener(function (tabId) {
  if (tabId === pickTabId) pickTabId = null;
  if (lastWebTab && lastWebTab.id === tabId) lastWebTab = null;
  if (tabId === bookTabId) setBookTab(null);
});

// --------------------------------------------------------------- messages --

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== 'panel') return;
  ports.add(port);
  ready.then(function () { return stateForPanel(); }).then(function (s) {
    try { port.postMessage({ t: 'state', state: s }); } catch (e) {}
  });
  // The app page pings to keep this worker awake for the length of a run.
  port.onMessage.addListener(function () {});
  port.onDisconnect.addListener(function () { ports.delete(port); });
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.t !== 'string') return;
  ready.then(function () {
    switch (msg.t) {
      case 'picked':
        applyPick(msg, sender.tab);
        return sendResponse({ ok: true });
      case 'startPicker':
        return startPicker(msg.slot).then(sendResponse);
      case 'highlight': {
        var colors = { next: '#f59e0b', text: '#38bdf8', exclude: '#ef4444' };
        return targetTab().then(function (tab) {
          if (!tab) return null;
          setBookTab(tab.id);
          return chrome.windows.update(tab.windowId, { focused: true }).then(function () {
            return chrome.tabs.update(tab.id, { active: true });
          }).then(function () {
            return send(tab.id, {
              t: 'highlight', selectors: EG.activeConfig(settings).selectors[msg.slot] || [],
              all: msg.slot === 'exclude', color: colors[msg.slot]
            });
          });
        }).then(function (r) { sendResponse(r || { ok: false }); }).catch(function () { sendResponse({ ok: false }); });
      }
      case 'clearPick': {
        if (bookTabId != null) chrome.tabs.sendMessage(bookTabId, { t: 'unhighlight' }).catch(function () {});
        return editActiveConfig(function (c) {
          if (msg.slot === 'exclude') {
            c.selectors.exclude = msg.index == null ? [] : c.selectors.exclude.filter(function (_, i) { return i !== msg.index; });
          } else {
            c.selectors[msg.slot] = [];
            c.picks[msg.slot] = null;
          }
        }).then(function () { sendResponse({ ok: true }); });
      }
      case 'config':
        return editConfigs(msg).then(sendResponse);
      case 'library':
        return libraryOp(msg).then(sendResponse, function (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        });
      case 'saveSettings':
        return saveSettings(msg.patch || {}).then(function () { sendResponse({ ok: true }); });
      case 'start': {
        // The run is watched from the page that started it; chapter tabs
        // open next to it. The tab used for picking isn't needed any more.
        if (run.status !== 'running' && pickTabId != null) {
          chrome.tabs.remove(pickTabId).catch(function () {});
          pickTabId = null;
        }
        var home = sender.tab || null;
        return sendResponse(startRun(home && home.id, msg.url, { windowId: home && home.windowId }));
      }
      case 'stop':
        stopRequested = true;
        if (run.status === 'running') setRun({ message: 'stopping' });
        return sendResponse({ ok: true });
      case 'book':
        return editBook(msg).then(sendResponse, function (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        });
    }
  });
  return true;
});
