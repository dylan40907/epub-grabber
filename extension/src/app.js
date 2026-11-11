'use strict';
/*
 * app.js - the whole extension on one page (app.html), opened by the
 * toolbar icon. Run state comes from the worker over a port; the book is read
 * straight from storage and redrawn as chapters land in it. Every change goes
 * back to the worker, which is the only thing that writes.
 */
(function () {

  var $ = function (s) { return document.querySelector(s); };
  var state = null;
  var book = EG.bookWithDefaults();
  var library = { books: {} };

  function ask(msg) {
    return chrome.runtime.sendMessage(msg).catch(function () { return null; });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function num(n) { return Number(n || 0).toLocaleString(); }

  function hint(text, bad) {
    var h = $('#pickHint');
    h.hidden = !text;
    h.textContent = text || '';
    h.className = 'hint' + (bad ? ' bad' : '');
  }

  // A line under the Start button, for anything that went wrong.
  function say(text) {
    $('#runText').textContent = text;
    $('.runline').classList.add('error');
  }

  // -------------------------------------------------------------- the port --

  var port = null;
  function connect() {
    port = chrome.runtime.connect({ name: 'panel' });
    port.onMessage.addListener(function (m) {
      if (!m || m.t !== 'state') return;
      // A worker from before an update (the browser keeps the old one
      // running until the extension is reloaded) speaks an older language.
      var stale = !m.state || m.state.api !== EG.API;
      $('#stale').hidden = !stale;
      if (stale) return;
      state = m.state;
      render();
    });
    port.onDisconnect.addListener(function () { setTimeout(connect, 300); });
  }
  connect();
  // Holding the port open and talking on it keeps the worker awake for the
  // length of a long run.
  setInterval(function () { try { port.postMessage({ t: 'ping' }); } catch (e) {} }, 20000);

  /**
   * Set a <select>'s options, but only touch them when they've changed, so a
   * list you have open isn't rebuilt under you.
   */
  function fillSelect(el, items, value) {
    var key = JSON.stringify(items);
    if (el.dataset.key !== key) {
      el.innerHTML = items.map(function (it) {
        return '<option value="' + esc(it[0]) + '">' + esc(it[1]) + '</option>';
      }).join('');
      el.dataset.key = key;
    }
    if (el.value !== value) el.value = value;
  }

  // ---------------------------------------------------------------- counter --

  // The big number rolls up to its new value rather than jumping.
  var shownCount = 0, countTarget = 0, countRaf = 0;
  function rollTo(n) {
    if (n === countTarget) return;
    var from = shownCount, start = performance.now(), dur = Math.min(600, 120 + Math.abs(n - from) * 40);
    countTarget = n;
    cancelAnimationFrame(countRaf);
    if (n > from) {
      var big = $('#bigCount');
      big.classList.remove('bump');
      void big.offsetWidth;
      big.classList.add('bump');
    }
    (function step(t) {
      var k = Math.min(1, Math.max(0, (t - start) / dur));
      shownCount = Math.round(from + (n - from) * (1 - Math.pow(1 - k, 3)));
      $('#bigCount').textContent = num(shownCount);
      if (k < 1) countRaf = requestAnimationFrame(step);
    })(start);
  }

  // ------------------------------------------------------------------ clock --

  function elapsedMs(run) {
    if (!run.startedAt) return 0;
    return (run.status === 'running' ? Date.now() : (run.endedAt || Date.now())) - run.startedAt;
  }

  function clock(ms) {
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    s %= 60;
    var mm = (m < 10 ? '0' : '') + m, ss = (s < 10 ? '0' : '') + s;
    return h ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  function tick() {
    if (!state) return;
    var run = state.run, ms = elapsedMs(run);
    $('#clock').textContent = clock(ms);
    var min = ms / 60000;
    $('#sPace').textContent = run.count && min > 0.05 ? (run.count / min).toFixed(run.count / min < 10 ? 1 : 0) : '-';
  }
  setInterval(tick, 1000);

  // ----------------------------------------------------------------- render --

  var sawRunning = false, flashedAt = null;

  function render() {
    if (!state) return;
    var s = state.settings, run = state.run;
    var cfg = EG.activeConfig(s);
    var running = run.status === 'running';
    var ended = !running && run.startedAt && run.endedAt;
    // Pressing Stop isn't announced: the page just goes back to ready.
    var userStopped = ended && run.message === 'Stopped.';
    var failed = ended && run.kind === 'error';
    var bound = ended && !userStopped && !failed;

    // status
    var st = $('#status');
    st.className = 'status ' + (running ? 'running' : failed ? 'error' : bound ? 'done' : 'idle');
    st.querySelector('b').textContent = running ? 'Capturing' : failed ? 'Stopped' : bound ? 'Done' : 'Idle';
    rollTo(run.count || 0);
    tick();

    // capture bar
    var cfgItems = s.configs.map(function (c) { return [c.id, c.name]; });
    fillSelect($('#configSel'), cfgItems, cfg.id);
    fillSelect($('#cfgEditSel'), cfgItems, cfg.id);
    $('#cfgEditSel').disabled = running;
    $('#configSel').disabled = running;
    var shownUrl = $('#startUrl').dataset.applied;
    if (s.startUrl !== shownUrl && document.activeElement !== $('#startUrl')) {
      $('#startUrl').value = s.startUrl;
      $('#startUrl').dataset.applied = s.startUrl;
    }
    $('#startUrl').disabled = running;
    $('#go').textContent = running ? 'Stop' : 'Start capturing';
    $('#go').className = 'go' + (running ? ' stop' : '');
    $('#go').disabled = !running && !cfg.selectors.text.length;
    $('#dot').className = 'dot' + (running ? ' on' : '');
    $('#runText').textContent = running
      ? run.count + ' chapter' + (run.count === 1 ? '' : 's') + ' this run · ' + (run.message || '')
      : ((!userStopped && run.message) || (cfg.selectors.text.length ? 'Ready. Paste the link to a chapter and press Start.' : 'Pick the chapter text area for ' + cfg.name + ' first.'));
    $('.runline').classList.toggle('error', !running && run.kind === 'error');

    renderPhrases(s.refreshPhrases);

    // stats
    $('#sWords').textContent = num(run.words);

    // site config
    if ($('#configName').hidden) $('#configTitle').textContent = cfg.name;
    $('#delCfg').disabled = running || s.configs.length < 2;
    $('#addCfg').disabled = running;
    $('#renameCfg').disabled = running;
    renderPick('next', cfg.picks.next, cfg.selectors.next, function (p) {
      return '"' + esc(p.text || p.label) + '"';
    });
    renderPick('text', cfg.picks.text, cfg.selectors.text, function (p) {
      return esc(p.label) + (p.words ? ' · ' + num(p.words) + ' words' : '') +
        (p.firstLine ? ' · starts "' + esc(p.firstLine.slice(0, 50)) + '"' : '');
    });
    document.querySelectorAll('[data-pick], [data-clear]').forEach(function (b) { b.disabled = running; });

    renderLanes(run, s.parallel);
    // The build button lights up when a run reaches the end of the book.
    if (bound && sawRunning && run.endedAt !== flashedAt) {
      flashedAt = run.endedAt;
      $('#build').classList.remove('ready');
      void $('#build').offsetWidth;
      $('#build').classList.add('ready');
    }
    if (running) sawRunning = true;
    renderShelf();
    document.title = running ? '(' + num(run.count) + ') Capturing · EPUB Grabber' : 'EPUB Grabber' + (book.title ? ' · ' + book.title : '');
  }

  function renderPick(slot, pick, selectors, describe) {
    var row = document.querySelector('.pick[data-slot="' + slot + '"]');
    row.classList.toggle('done', !!selectors.length);
    var what = $('#' + slot + 'What');
    if (!selectors.length) {
      what.innerHTML = slot === 'next'
        ? 'not picked yet <span class="dim">- a link labelled "Next" is used instead</span>'
        : 'not picked yet';
    } else {
      what.innerHTML = (pick ? describe(pick) : 'picked') +
        '<span class="mono">' + esc(selectors[0].value) + '</span>';
    }
  }

  // ------------------------------------------------------------- in flight --

  var LANE_WORDS = { loading: 'loading', reading: 'reading', read: 'read', waiting: 'in line', limited: 'rate limited' };

  function renderLanes(run, parallel) {
    var list = $('#lanes');
    var running = run.status === 'running';
    var all = running ? run.pipeline || [] : [];
    // One row per tab loading; chapters already read and waiting for an
    // earlier one only show in the note.
    var waiting = all.filter(function (l) { return l.state === 'waiting'; }).length;
    var lanes = all.filter(function (l) { return l.state !== 'waiting'; });
    var busy = lanes.length;
    // Always one row per tab that can load: empty ones say so.
    for (var i = busy; i < parallel; i++) lanes.push({ idle: true, key: 'idle' + i });
    // Keep a row per chapter, so its animation carries on as it changes state.
    var keep = {};
    Array.from(list.children).forEach(function (li) { keep[li.dataset.key] = li; });
    var rows = lanes.map(function (l) {
      var key = l.idle ? l.key : 'n' + l.n;
      var li = keep[key] || document.createElement('li');
      delete keep[key];
      li.dataset.key = key;
      var cls = 'lane ' + (l.idle ? 'idle' : l.state);
      if (li.className !== cls) li.className = cls;
      var label = l.idle ? '-' : l.n ? 'CH ' + num(l.n) : 'FIRST';
      var what = l.idle ? (running ? 'free' : 'idle') : l.state === 'limited' && l.retryIn ? 'retry ' + l.retryIn + 's' : LANE_WORDS[l.state] || l.state;
      var html = '<span class="n mono">' + label + '</span><span class="bar"></span><span class="what">' + what + '</span>';
      if (li.dataset.html !== html) { li.innerHTML = html; li.dataset.html = html; }
      return li;
    });
    Object.keys(keep).forEach(function (k) { keep[k].remove(); });
    rows.forEach(function (li, i) { if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null); });

    $('#flightNote').textContent = running && waiting ? waiting + ' read, waiting their turn' : '';
  }

  // ------------------------------------------------------------------ books --

  function bookLabel(b) {
    return (b.title || 'Untitled book') + ' · ' + num(b.count) + ' ch';
  }

  function renderShelf() {
    var running = !!(state && state.run.status === 'running');
    var shelved = Object.keys(library.books || {}).map(function (k) { return library.books[k]; })
      .filter(function (b) { return b.id !== book.id; })
      .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    var items = [[book.id || '', bookLabel({ title: book.title, count: book.chapters.length })]]
      .concat(shelved.map(function (b) { return [b.id, bookLabel(b)]; }));
    fillSelect($('#bookSel'), items, book.id || '');
    $('#bookSel').disabled = running || items.length < 2;
    $('#newBook').disabled = running;
    $('#delBook').disabled = running;
  }

  function renderBookText() {
    if (document.activeElement !== $('#bookTitle')) $('#bookTitle').value = book.title || '';
    if (document.activeElement !== $('#bookAuthor')) $('#bookAuthor').value = book.author || '';
    $('#titleMode').value = book.titleMode;

    var words = book.chapters.reduce(function (n, c) { return n + (c.words || 0); }, 0);
    $('#chapCount').textContent = num(book.chapters.length) + ' chapter' + (book.chapters.length === 1 ? '' : 's') +
      ' · ' + num(words) + ' words';
    $('#sTotal').textContent = num(book.chapters.length);
    $('#sTotalSub').textContent = num(words) + ' words';
    $('#emptyMsg').hidden = book.chapters.length > 0;
    $('#build').disabled = !book.chapters.length || building;
  }

  // ---------------------------------------------------------- chapter list --
  //
  // Tick rows to work on several at once (shift-click ticks everything in
  // between). Drag a row, or the ticked rows, to move them: rows that weren't
  // next to each other keep the same gaps between them. Removing and moving
  // can be undone (Ctrl+Z or the undo button), even after a reload.

  var rowSig = [];
  var selected = new Set();
  var anchorId = null;

  var TRASH_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2.5 4h11M6 4V2h4v2M4 4l.7 10h6.6L12 4M6.6 6.5v5M9.4 6.5v5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></svg>';

  function rowHtml(c, i) {
    return '<button class="tick" data-act="tick" role="checkbox" aria-checked="' + selected.has(c.id) + '" title="Select (shift-click selects a range)"></button>' +
      '<span class="num">' + (i + 1) + '</span>' +
      '<input class="ttl' + (c.title ? ' override' : '') + '" value="' + esc(EGBook.titleOf(book, c, i)) + '" title="Rename">' +
      '<span class="w">' + num(c.words) + 'w</span>' +
      '<button class="mini" data-act="view" title="Read">👁</button>' +
      '<button class="mini del" data-act="del" title="Remove">' + TRASH_SVG + '</button>';
  }

  function renderList(animate) {
    var list = $('#chapters');
    var sig = book.chapters.map(function (c) { return c.id + ':' + (c.title || ''); });
    sig.mode = book.titleMode;
    var appendOnly = sig.mode === rowSig.mode && sig.length >= rowSig.length &&
      rowSig.every(function (k, i) { return sig[i] === k; });
    var atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
    var keepScroll = list.scrollTop;
    // Ticks on chapters that are gone go with them.
    var ids = {};
    book.chapters.forEach(function (c) { ids[c.id] = 1; });
    selected.forEach(function (id) { if (!ids[id]) selected.delete(id); });
    if (!appendOnly) { list.innerHTML = ''; rowSig = []; rowSig.mode = sig.mode; animate = false; }
    var frag = document.createDocumentFragment();
    for (var i = rowSig.length; i < book.chapters.length; i++) {
      var li = document.createElement('li');
      li.className = 'chapter' + (animate ? ' arrive' : '') + (selected.has(book.chapters[i].id) ? ' selected' : '');
      li.dataset.id = book.chapters[i].id;
      li.innerHTML = rowHtml(book.chapters[i], i);
      frag.appendChild(li);
    }
    list.appendChild(frag);
    rowSig = sig;
    // Follow along at the bottom during a run; otherwise stay put.
    list.scrollTop = atBottom && appendOnly ? list.scrollHeight : keepScroll;
    renderListTools();
  }

  function renderListTools() {
    var n = selected.size;
    var trash = $('#trashBtn');
    trash.classList.toggle('picked', n > 0);
    trash.title = n ? 'Remove the ' + num(n) + ' selected chapter' + (n === 1 ? '' : 's') : 'Remove all chapters';
    trash.disabled = !book.chapters.length;
    $('#undoBtn').disabled = !(book.undo && book.undo.length);
    $('#listNote').textContent = n ? num(n) + ' selected · Esc clears' : 'rename, drag to reorder, read or remove';
  }

  function setTicked(id, on) {
    if (on) selected.add(id); else selected.delete(id);
    var li = $('#chapters').querySelector('.chapter[data-id="' + id + '"]');
    if (li) {
      li.classList.toggle('selected', on);
      li.querySelector('.tick').setAttribute('aria-checked', String(on));
    }
  }

  function tickRow(id, shift) {
    var on = !selected.has(id);
    var ids = book.chapters.map(function (c) { return c.id; });
    var a = anchorId != null ? ids.indexOf(anchorId) : -1, b = ids.indexOf(id);
    if (shift && a !== -1 && b !== -1) {
      // Everything between the last row ticked and this one.
      on = selected.has(anchorId);
      for (var i = Math.min(a, b); i <= Math.max(a, b); i++) setTicked(ids[i], on);
    } else {
      setTicked(id, on);
    }
    anchorId = id;
    renderListTools();
  }

  function clearTicks() {
    Array.from(selected).forEach(function (id) { setTicked(id, false); });
    anchorId = null;
    renderListTools();
  }

  function removeChapters(msg) {
    return ask(Object.assign({ t: 'book', op: 'remove' }, msg)).then(function (r) {
      if (r && !r.ok && r.error) say(r.error);
      return r;
    });
  }

  function undo() {
    if (!(book.undo && book.undo.length)) return;
    ask({ t: 'book', op: 'undo' });
  }

  $('#undoBtn').addEventListener('click', undo);
  $('#trashBtn').addEventListener('click', function () {
    if (selected.size) {
      var ids = Array.from(selected);
      clearTicks();
      removeChapters({ ids: ids });
    } else if (book.chapters.length) {
      removeChapters({ all: true });
    }
  });

  document.addEventListener('keydown', function (e) {
    var el = document.activeElement;
    var typing = el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'checkbox') || el.isContentEditable);
    var dialogs = document.querySelector('.eg-modal') || !$('#reader').hidden || !$('#cfgDialog').hidden;
    // Text boxes keep their own Ctrl+Z.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z' && !typing && !dialogs) {
      e.preventDefault();
      undo();
    } else if (e.key === 'Escape' && selected.size && !typing && !dialogs) {
      clearTicks();
    }
  });

  /**
   * Move the chapters at positions `picked` (ascending) by `d` places. The
   * rest fill the gaps in their own order, so picked rows that weren't next
   * to each other keep their spacing.
   */
  function movedOrder(ids, picked, d) {
    var out = new Array(ids.length);
    var isPicked = {};
    picked.forEach(function (p) { out[p + d] = ids[p]; isPicked[p] = 1; });
    var k = 0;
    ids.forEach(function (id, p) {
      if (isPicked[p]) return;
      while (out[k] !== undefined) k++;
      out[k] = id;
    });
    return out;
  }

  // Dragging.
  var drag = null;

  $('#chapters').addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    var li = e.target.closest('.chapter');
    if (!li || e.target.closest('button')) return;
    drag = { li: li, pointerId: e.pointerId, y0: e.clientY, y: e.clientY, started: false };
  });

  function startDrag() {
    var list = $('#chapters');
    var id = Number(drag.li.dataset.id);
    var ids = book.chapters.map(function (c) { return c.id; });
    var moving = selected.has(id) ? ids.filter(function (x) { return selected.has(x); }) : [id];
    drag.ids = ids;
    drag.picked = moving.map(function (x) { return ids.indexOf(x); });
    drag.rows = Array.from(list.children);
    drag.h = drag.li.offsetHeight;
    drag.scroll0 = list.scrollTop;
    drag.d = 0;
    drag.moved = {};
    drag.started = true;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    window.getSelection().removeAllRanges();
    list.classList.add('dragging');
    drag.picked.forEach(function (p) { drag.rows[p].classList.add('lifted'); });
    try { list.setPointerCapture(drag.pointerId); } catch (err) {}
    drag.timer = requestAnimationFrame(autoScroll);
  }

  function dragTo() {
    var list = $('#chapters');
    var first = drag.picked[0], last = drag.picked[drag.picked.length - 1];
    var px = drag.y - drag.y0 + list.scrollTop - drag.scroll0;
    // Not past the top or the bottom of the list.
    px = Math.max(-first * drag.h, Math.min((drag.ids.length - 1 - last) * drag.h, px));
    var d = Math.round(px / drag.h);
    drag.picked.forEach(function (p) { drag.rows[p].style.transform = 'translateY(' + px + 'px)'; });
    if (d === drag.d) return;
    drag.d = d;
    drag.order = movedOrder(drag.ids, drag.picked, d);
    // The others slide out of the way.
    var lo = Math.max(0, Math.min(first, first + d) - 1), hi = Math.min(drag.ids.length - 1, Math.max(last, last + d) + 1);
    var where = {};
    for (var i = lo; i <= hi; i++) where[drag.order[i]] = i;
    Object.keys(drag.moved).forEach(function (p) {
      if (p < lo || p > hi) { drag.rows[p].style.transform = ''; delete drag.moved[p]; }
    });
    var isPicked = {};
    drag.picked.forEach(function (p) { isPicked[p] = 1; });
    for (var p = lo; p <= hi; p++) {
      if (isPicked[p]) continue;
      var to = where[drag.ids[p]];
      var off = to === undefined ? 0 : (to - p) * drag.h;
      drag.rows[p].style.transform = off ? 'translateY(' + off + 'px)' : '';
      if (off) drag.moved[p] = 1; else delete drag.moved[p];
    }
  }

  function autoScroll() {
    if (!drag || !drag.started) return;
    var list = $('#chapters'), r = list.getBoundingClientRect(), edge = 36;
    var v = drag.y < r.top + edge ? -(r.top + edge - drag.y) : drag.y > r.bottom - edge ? drag.y - (r.bottom - edge) : 0;
    if (v) {
      list.scrollTop += Math.max(-24, Math.min(24, v / 2));
      dragTo();
    }
    drag.timer = requestAnimationFrame(autoScroll);
  }

  document.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.y = e.clientY;
    if (!drag.started) {
      if (Math.abs(drag.y - drag.y0) < 6) return;
      startDrag();
    }
    e.preventDefault();
    dragTo();
  });

  function endDrag(cancel) {
    if (!drag) return;
    var d = drag;
    drag = null;
    if (!d.started) return;
    cancelAnimationFrame(d.timer);
    var list = $('#chapters');
    list.classList.remove('dragging');
    try { list.releasePointerCapture(d.pointerId); } catch (err) {}
    function settle() {
      d.rows.forEach(function (li) { li.classList.remove('lifted'); li.style.transform = ''; });
    }
    if (cancel || d.d === 0) return settle();
    // Rows stay where they were dropped until the list comes back in its new
    // order (and is redrawn).
    d.picked.forEach(function (p) { d.rows[p].classList.remove('lifted'); d.rows[p].style.transform = 'translateY(' + d.d * d.h + 'px)'; });
    ask({ t: 'book', op: 'order', ids: d.order }).then(function (r) {
      if (!r || !r.ok) settle();
    });
  }
  document.addEventListener('pointerup', function (e) { if (drag && e.pointerId === drag.pointerId) endDrag(false); });
  document.addEventListener('pointercancel', function () { endDrag(true); });

  // -------------------------------------------------------- latest chapter --

  var latestId = null;

  function showLatest() {
    var ch = book.chapters;
    if (!ch.length) {
      $('#pages').innerHTML = '<div class="page-empty dim">Chapters show up here as they\'re read.</div>';
      $('#latestNum').textContent = '';
      latestId = null;
      return;
    }
    var i = ch.length - 1, meta = ch[i];
    $('#latestNum').textContent = num(i + 1) + ' of ' + num(ch.length);
    if (meta.id === latestId) return;
    latestId = meta.id;
    chrome.storage.local.get(EG.CHAPTER_PREFIX + meta.id).then(function (got) {
      if (latestId !== meta.id) return;
      var body = got[EG.CHAPTER_PREFIX + meta.id] || { blocks: [] };
      var part = EGBook.chapterFor(book, meta, { blocks: (body.blocks || []).slice(0, 10) }, i);
      var page = document.createElement('article');
      page.className = 'page p0';
      page.dataset.id = meta.id;
      page.innerHTML = '<div class="num">Chapter ' + num(i + 1) + '</div>' +
        '<span class="meta mono">' + num(meta.words) + ' words</span>' +
        '<h3>' + esc(part.title) + '</h3>' +
        // Our own serializer's output: escaped text and a handful of tags.
        '<div class="text">' + part.html + '</div>';
      var stack = $('#pages');
      var empty = stack.querySelector('.page-empty');
      if (empty) empty.remove();
      Array.from(stack.querySelectorAll('.page')).forEach(function (p) {
        if (p.classList.contains('p0')) p.classList.replace('p0', 'p1');
        else if (p.classList.contains('p1')) p.classList.replace('p1', 'p2');
        else { p.classList.add('gone'); setTimeout(function () { p.remove(); }, 600); }
      });
      stack.appendChild(page);
    });
  }

  // ---------------------------------------------------------------- reader --

  function openReader(id) {
    var i = book.chapters.findIndex(function (c) { return c.id === id; });
    if (i === -1) return;
    chrome.storage.local.get(EG.CHAPTER_PREFIX + id).then(function (got) {
      var ch = EGBook.chapterFor(book, book.chapters[i], got[EG.CHAPTER_PREFIX + id], i);
      $('#readerNum').textContent = 'Chapter ' + num(i + 1) + ' of ' + num(book.chapters.length);
      $('#readerTitle').textContent = ch.title;
      // Our own serializer's output: escaped text and a handful of tags.
      $('#readerText').innerHTML = ch.html;
      $('#reader').hidden = false;
      $('#reader').scrollTop = 0;
      $('#readerClose').focus();
    });
  }
  function closeReader() { $('#reader').hidden = true; }
  $('#readerClose').addEventListener('click', closeReader);
  $('#reader').addEventListener('mousedown', function (e) { if (e.target === this) closeReader(); });

  // Site configs live in a box of their own: they're set up once per site.
  function openConfigs() {
    $('#cfgDialog').hidden = false;
    $('#cfgClose').focus();
  }
  function closeConfigs() {
    endRename(true);
    $('#cfgDialog').hidden = true;
    hint('');
  }
  $('#editCfgs').addEventListener('click', openConfigs);

  // Refresh text: what a "slow down, then refresh" page says.
  var phraseKey = null;
  function renderPhrases(list) {
    var key = JSON.stringify(list);
    var box = $('#phraseList');
    // Not under someone typing in one of them.
    if (key === phraseKey || box.contains(document.activeElement)) return;
    phraseKey = key;
    box.innerHTML = list.map(function (p, i) {
      return '<li data-i="' + i + '"><input type="text" maxlength="200" value="' + esc(p) + '" aria-label="Refresh text">' +
        '<button class="mini" data-phrase-del="' + i + '" title="Remove">' + TRASH_SVG + '</button></li>';
    }).join('');
  }
  function savePhrases(list) {
    phraseKey = null;
    return ask({ t: 'saveSettings', patch: { refreshPhrases: list } });
  }
  function phrasesNow() { return state ? state.settings.refreshPhrases.slice() : []; }
  $('#phraseList').addEventListener('change', function (e) {
    var li = e.target.closest('li');
    if (!li) return;
    var list = phrasesNow(), i = Number(li.dataset.i), v = e.target.value.trim();
    if (v) list[i] = v; else list.splice(i, 1);
    savePhrases(list);
  });
  $('#phraseList').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur();
  });
  $('#phraseList').addEventListener('click', function (e) {
    var b = e.target.closest('[data-phrase-del]');
    if (!b) return;
    var list = phrasesNow();
    list.splice(Number(b.dataset.phraseDel), 1);
    savePhrases(list);
  });
  $('#phraseAdd').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('#phraseNew').value.trim();
    if (!v) return;
    var list = phrasesNow();
    if (!list.some(function (p) { return p.toLowerCase() === v.toLowerCase(); })) list.push(v);
    $('#phraseNew').value = '';
    savePhrases(list);
  });
  $('#cfgClose').addEventListener('click', closeConfigs);
  $('#cfgDialog').addEventListener('mousedown', function (e) { if (e.target === this) closeConfigs(); });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || document.querySelector('.eg-modal')) return;
    if (!$('#reader').hidden) closeReader();
    else if (!$('#cfgDialog').hidden && document.activeElement !== $('#configName')) closeConfigs();
  });
  $('#pages').addEventListener('click', function (e) {
    var p = e.target.closest('.page.p0');
    if (p) openReader(Number(p.dataset.id));
  });

  // ------------------------------------------------------------ storage --

  function onBook(animate) {
    renderBookText();
    renderList(animate);
    showLatest();
    renderShelf();
    if (state) render();
  }

  chrome.storage.local.get([EG.BOOK_KEY, EG.LIBRARY_KEY]).then(function (got) {
    book = EG.bookWithDefaults(got[EG.BOOK_KEY]);
    library = got[EG.LIBRARY_KEY] || { books: {} };
    onBook(false);
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes[EG.LIBRARY_KEY]) library = changes[EG.LIBRARY_KEY].newValue || { books: {} };
    if (changes[EG.BOOK_KEY]) {
      var before = book.id;
      book = EG.bookWithDefaults(changes[EG.BOOK_KEY].newValue);
      onBook(book.id === before);
    } else if (changes[EG.LIBRARY_KEY]) {
      renderShelf();
    }
  });

  // ---------------------------------------------------------------- actions --

  document.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;

    if (b.dataset.pick) {
      var slot = b.dataset.pick;
      // Pick on the link that's in the box now, even if it was only just pasted.
      var url = $('#startUrl').value.trim();
      if (!/^https?:\/\/\S+$/i.test(url)) {
        hint('Can\'t select the ' + (slot === 'next' ? 'next chapter button' : 'chapter text area') +
          ' without a chapter link. Paste one in the starting chapter link box first.', true);
        return;
      }
      hint('Opening the chapter to pick on. Click ' + (slot === 'next' ? 'the next chapter button.' :
        'the chapter text: use ↑ to widen the box until it covers all of it, then click or press Enter.') + ' Esc cancels.');
      clearTimeout(urlTimer);
      $('#startUrl').dataset.applied = url;
      ask({ t: 'saveSettings', patch: { startUrl: url } }).then(function () {
        return ask({ t: 'startPicker', slot: slot });
      }).then(function (r) {
        if (!r || !r.ok) hint((r && r.error) || 'Couldn\'t start picking.', true);
      });
      return;
    }
    if (b.dataset.show) {
      ask({ t: 'highlight', slot: b.dataset.show }).then(function (r) {
        if (!r || !r.ok) hint('Pick on a chapter page first.', true);
        else if (!r.found) hint('Nothing on that page matches it. Pick it again.', true);
        else hint('');
      });
      return;
    }
    if (b.dataset.clear) { ask({ t: 'clearPick', slot: b.dataset.clear }); return; }

    var row = b.closest('.chapter');
    if (row && b.dataset.act) {
      var id = Number(row.dataset.id);
      if (b.dataset.act === 'del') removeChapters({ ids: [id] });
      else if (b.dataset.act === 'tick') tickRow(id, e.shiftKey);
      else if (b.dataset.act === 'view') openReader(id);
    }
  });

  $('#chapters').addEventListener('change', function (e) {
    if (!e.target.classList.contains('ttl')) return;
    var id = Number(e.target.closest('.chapter').dataset.id);
    var i = book.chapters.findIndex(function (c) { return c.id === id; });
    var c = book.chapters[i];
    var auto = c ? EGBook.titleOf(book, Object.assign({}, c, { title: '' }), i) : '';
    // Typing the automatic title back in clears the override.
    ask({ t: 'book', op: 'rename', id: id, title: e.target.value === auto ? '' : e.target.value });
  });

  // configs
  ['#configSel', '#cfgEditSel'].forEach(function (sel) {
    $(sel).addEventListener('change', function () {
      ask({ t: 'config', op: 'select', id: this.value });
      hint('');
    });
  });

  function startRename() {
    var cfg = EG.activeConfig(state.settings);
    var input = $('#configName');
    input.value = cfg.name;
    input.dataset.id = cfg.id;
    input.hidden = false;
    $('#configTitle').hidden = true;
    input.focus();
    input.select();
  }
  function endRename(save) {
    var input = $('#configName');
    if (input.hidden) return;
    input.hidden = true;
    $('#configTitle').hidden = false;
    if (save && input.value.trim()) {
      $('#configTitle').textContent = input.value.trim();
      ask({ t: 'config', op: 'rename', id: input.dataset.id, name: input.value });
    }
  }
  $('#renameCfg').addEventListener('click', startRename);
  $('#configName').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') endRename(true);
    else if (e.key === 'Escape') endRename(false);
  });
  $('#configName').addEventListener('blur', function () { endRename(true); });

  $('#addCfg').addEventListener('click', function () {
    ask({ t: 'config', op: 'add' }).then(function (r) {
      if (!r || !r.ok) return;
      hint('New config: name it, paste the link to a chapter of that site in the starting chapter link box, then select its next button and text area.');
      // Name it straight away, once the new config has come back.
      var wait = setInterval(function () {
        if (state && state.settings.activeConfig === r.id) { clearInterval(wait); startRename(); }
      }, 50);
      setTimeout(function () { clearInterval(wait); }, 3000);
    });
  });

  $('#delCfg').addEventListener('click', function () {
    var cfg = EG.activeConfig(state.settings);
    EGUI.confirm({
      title: 'Delete config?',
      message: '"' + cfg.name + '" and its picks will be removed. Books captured with it are kept.',
      ok: 'Delete config', danger: true
    }).then(function (yes) {
      if (!yes) return;
      ask({ t: 'config', op: 'delete', id: cfg.id }).then(function (r) {
        if (r && !r.ok && r.error) hint(r.error, true);
      });
    });
  });

  // start / stop
  var urlTimer = null;
  $('#startUrl').addEventListener('input', function () {
    var v = this.value.trim();
    clearTimeout(urlTimer);
    urlTimer = setTimeout(function () {
      $('#startUrl').dataset.applied = v;
      ask({ t: 'saveSettings', patch: { startUrl: v } });
    }, 300);
  });
  $('#startUrl').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('#go').click();
  });

  function start() {
    var url = $('#startUrl').value.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) {
      $('#runText').textContent = 'Paste the link to the chapter you want to start from.';
      $('.runline').classList.add('error');
      $('#startUrl').focus();
      return;
    }
    clearTimeout(urlTimer);
    $('#startUrl').dataset.applied = url;
    ask({ t: 'saveSettings', patch: { startUrl: url } }).then(function () {
      return ask({ t: 'start', url: url });
    }).then(function (r) {
      if (r && !r.ok) { $('#runText').textContent = r.error; $('.runline').classList.add('error'); }
    });
  }

  $('#go').addEventListener('click', function () {
    if (state && state.run.status === 'running') { ask({ t: 'stop' }); return; }
    start();
  });

  // book
  var metaTimer = null;
  ['#bookTitle', '#bookAuthor'].forEach(function (sel) {
    $(sel).addEventListener('input', function () {
      clearTimeout(metaTimer);
      metaTimer = setTimeout(function () {
        ask({ t: 'book', op: 'meta', title: $('#bookTitle').value, author: $('#bookAuthor').value });
      }, 300);
    });
  });
  $('#titleMode').addEventListener('change', function () {
    ask({ t: 'book', op: 'meta', titleMode: this.value });
  });

  $('#bookSel').addEventListener('change', function () {
    ask({ t: 'library', op: 'switch', id: this.value }).then(function (r) {
      if (r && !r.ok && r.error) say(r.error);
    });
  });
  $('#newBook').addEventListener('click', function () {
    // The current book is kept: it goes on the list and can be picked again.
    ask({ t: 'library', op: 'new' }).then(function (r) {
      if (r && !r.ok && r.error) say(r.error);
    });
  });
  $('#delBook').addEventListener('click', function () {
    var n = book.chapters.length, id = book.id;
    EGUI.confirm({
      title: 'Delete this book?',
      message: '"' + (book.title || 'Untitled book') + '" and its ' + num(n) + ' chapter' + (n === 1 ? '' : 's') +
        ' will be removed for good. This can\'t be undone.',
      ok: 'Delete book', danger: true
    }).then(function (yes) {
      if (!yes) return;
      ask({ t: 'library', op: 'delete', id: id }).then(function (r) {
        if (r && !r.ok && r.error) say(r.error);
      });
    });
  });

  // build
  var building = false;
  /**
   * Pairs of chapters that are the same: the same text, or the same first
   * line and nearly the same length (a site changing a line between visits,
   * or posting a chapter twice). The later of each pair is the one to drop.
   */
  function findDuplicates(chapters) {
    var byHash = {}, byLine = {}, pairs = [];
    chapters.forEach(function (c, i) {
      var line = String(c.firstLine || '').trim().toLowerCase();
      var twin = byHash[c.hash];
      if (twin === undefined && line) {
        (byLine[line] || []).some(function (j) {
          var w1 = chapters[j].words || 0, w2 = c.words || 0;
          if (Math.abs(w1 - w2) <= Math.max(3, 0.03 * Math.max(w1, w2))) { twin = j; return true; }
          return false;
        });
      }
      if (twin !== undefined) { pairs.push({ a: twin, b: i }); return; }
      byHash[c.hash] = i;
      if (line) (byLine[line] = byLine[line] || []).push(i);
    });
    return pairs;
  }

  function build() {
    if (building || !book.chapters.length) return;
    var pairs = findDuplicates(book.chapters);
    if (!pairs.length) return buildNow(book);
    var lines = pairs.slice(0, 6).map(function (p) {
      return '· Chapter ' + num(p.a + 1) + ' and chapter ' + num(p.b + 1) + ' ("' + EGBook.titleOf(book, book.chapters[p.b], p.b).slice(0, 60) + '")';
    });
    if (pairs.length > 6) lines.push('· …and ' + num(pairs.length - 6) + ' more');
    EGUI.choose({
      title: pairs.length === 1 ? 'There\'s a duplicate chapter' : 'There are ' + num(pairs.length) + ' duplicate chapters',
      message: (pairs.length === 1 ? 'These two look the same:' : 'These look the same:') + '\n' + lines.join('\n') +
        '\n\nRemove the second of each and then build?',
      wide: true,
      choices: [
        { label: 'No, build anyway', value: 'anyway' },
        { label: 'Yes, remove and build', value: 'remove', primary: true }
      ],
      focus: 1
    }).then(function (answer) {
      if (answer === 'anyway') return buildNow(book);
      if (answer !== 'remove') return;
      var ids = pairs.map(function (p) { return book.chapters[p.b].id; });
      removeChapters({ ids: ids }).then(function (r) {
        if (!r || !r.ok) return;
        return chrome.storage.local.get(EG.BOOK_KEY).then(function (got) {
          buildNow(EG.bookWithDefaults(got[EG.BOOK_KEY]));
        });
      });
    });
  }

  function buildNow(b) {
    if (building || !b.chapters.length) return;
    building = true;
    var btns = [$('#build')];
    btns.forEach(function (x) { x.disabled = true; x.textContent = 'Building…'; });
    EGBook.download(b).then(function (r) {
      btns.forEach(function (x) { x.textContent = '✓ ' + r.name + ' (' + (r.size / 1024 / 1024).toFixed(1) + ' MB)'; });
    }).catch(function (e) {
      btns.forEach(function (x) { x.textContent = 'Build failed: ' + (e && e.message || e); });
    }).then(function () {
      building = false;
      setTimeout(function () {
        btns.forEach(function (x) { x.textContent = '⬇ Build & download EPUB'; x.disabled = !book.chapters.length; });
      }, 4000);
      btns.forEach(function (x) { x.disabled = !book.chapters.length; });
    });
  }
  $('#build').addEventListener('click', build);

  $('#reloadExt').addEventListener('click', function () { chrome.runtime.reload(); });

})();
