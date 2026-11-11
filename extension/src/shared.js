'use strict';
/*
 * shared.js - vocabulary shared by the service worker, the content script and
 * the console page. Pure data and DOM, no chrome.* calls, so it is safe to
 * importScripts() into a worker that has no DOM.
 *
 * The selector engine includes class-based candidates, because the element holding a
 * chapter's text is very often a <div class="chapter-content"> with no id, and
 * a positional path to it breaks the first time a page has an extra banner.
 */
(function (root) {

  var SETTINGS_KEY = 'eg.settings';
  var BOOK_KEY = 'eg.book';           // the book being worked on
  var LIBRARY_KEY = 'eg.library';     // { activeId, nextChapterId, books: {id: summary} }
  var SHELF_PREFIX = 'eg.shelf.';     // books put aside, by id
  var CHAPTER_PREFIX = 'eg.ch.';
  var RUN_KEY = 'eg.run';

  // A config is one site reader's layout: where the chapter text is and
  // which button goes to the next chapter. Selectors are tried in order; the
  // first that resolves wins, and the extras are fallbacks for a chapter page
  // laid out slightly differently from the one they were picked on. `picks`
  // describes what was picked, for the app page to show back.
  //
  // Config 1 ships with the extension: the reader these were picked on.
  var PACKED_CONFIGS = [{
    id: 'config-1',
    name: 'Config 1',
    selectors: {
      next: [{ type: 'xpath', value: '//a[normalize-space()="Next Chapter"]' }],
      text: [{ type: 'css', value: '#article' }],
      exclude: []
    },
    picks: {
      next: { tag: 'a', label: 'a', text: 'Next Chapter', selector: '//a[normalize-space()="Next Chapter"]' },
      text: { tag: 'div', label: 'div#article', selector: '#article' }
    }
  }];

  var SETTINGS_VERSION = 2;

  var DEFAULT_SETTINGS = {
    v: SETTINGS_VERSION,
    configs: PACKED_CONFIGS,
    activeConfig: 'config-1',
    startUrl: '',         // the chapter link pasted into the app page
    // Text a site shows instead of the chapter when it wants you to slow down
    // or prove you're a browser. A page showing any of these (and no chapter)
    // stops the run. Edited on the app page.
    refreshPhrases: ['rate limited', 'Error 1015', 'Too many requests', 'Enable JavaScript and cookies to continue'],
    // These aren't on the app page; they're the settings that work.
    // How many chapters load at once, each in its own background tab, when
    // the next button is a link (the address of chapter N+1 is read off
    // chapter N's page, so there's always one more to open). Two is what a
    // real site keeps up with; more just sit waiting.
    parallel: 2,
    delay: 0.5,           // seconds between opening chapters (or clicking next)
    timeout: 20,          // seconds to wait for the next chapter to show up
    rateWait: 5,          // seconds to wait before refreshing a rate-limited page
    maxChapters: 5000,    // hard stop, in case nothing else stops it
    // When the picked next button can't be found, try a link marked
    // rel="next" or labelled "Next" / "Next chapter".
    fallbackNext: true
  };

  var TIMING_KEYS = ['parallel', 'delay', 'timeout', 'rateWait', 'maxChapters', 'fallbackNext'];

  // Bumped when the app page and the worker must agree on their messages; a
  // page that sees a worker on a different number asks for a reload.
  var API = 6;

  var DEFAULT_BOOK = {
    id: '',
    lastUrl: '',          // the last chapter read, to carry on from
    title: '',
    author: '',
    // 'firstLine': the chapter's first line is its title (and is removed from
    //              the text) - what the old EPUB Creator did by default.
    // 'numbered':  Chapter 1, 2, 3..., text untouched.
    titleMode: 'firstLine',
    nextId: 1,
    // Metadata only - the bodies live under their own keys (eg.ch.<id>) so
    // adding a chapter never rewrites the whole book.
    // { id, url, firstLine, words, hash, title? }
    chapters: []
  };

  var STABLE_ATTRS = [
    'data-test', 'data-testid', 'data-test-id', 'data-qa', 'data-qa-id',
    'data-cy', 'data-automation-id', 'name', 'rel'
  ];

  var SHADOW_SEP = '>>>';

  // ---------------------------------------------------------------- utils --

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) n = lo;
    return Math.min(hi, Math.max(lo, n));
  }

  function emptyConfig(id, name) {
    return { id: id, name: name, selectors: { next: [], text: [], exclude: [] }, picks: { next: null, text: null } };
  }

  function configWithDefaults(c, i) {
    c = c || {};
    var out = emptyConfig(String(c.id || 'config-' + (i + 1)), String(c.name || 'Config ' + (i + 1)));
    ['next', 'text', 'exclude'].forEach(function (k) {
      if (c.selectors && Array.isArray(c.selectors[k])) out.selectors[k] = c.selectors[k];
    });
    if (c.picks) out.picks = { next: c.picks.next || null, text: c.picks.text || null };
    return out;
  }

  function withDefaults(stored) {
    stored = Object.assign({}, stored || {});
    // Settings from before configs existed: the timing was editable then and
    // isn't now, so those go back to the defaults. (The old picks were for
    // the same reader Config 1 ships with.)
    if (stored.v !== SETTINGS_VERSION) {
      TIMING_KEYS.forEach(function (k) { delete stored[k]; });
      delete stored.selectors;
      delete stored.picks;
    }
    var out = Object.assign({}, DEFAULT_SETTINGS, stored);
    out.v = SETTINGS_VERSION;
    var configs = Array.isArray(out.configs) && out.configs.length ? out.configs : PACKED_CONFIGS;
    out.configs = configs.map(configWithDefaults);
    if (!out.configs.some(function (c) { return c.id === out.activeConfig; })) out.activeConfig = out.configs[0].id;
    out.startUrl = typeof out.startUrl === 'string' ? out.startUrl : '';
    out.refreshPhrases = Array.isArray(out.refreshPhrases)
      ? out.refreshPhrases.map(function (p) { return String(p).trim().slice(0, 200); }).filter(Boolean)
      : DEFAULT_SETTINGS.refreshPhrases.slice();
    out.parallel = Math.round(clamp(out.parallel, 1, 2));
    out.delay = clamp(out.delay, 0, 30);
    out.timeout = clamp(out.timeout, 3, 120);
    out.rateWait = clamp(out.rateWait, 1, 120);
    out.maxChapters = Math.round(clamp(out.maxChapters, 1, 20000));
    out.fallbackNext = out.fallbackNext !== false;
    return out;
  }

  /** The config in use. */
  function activeConfig(settings) {
    for (var i = 0; i < settings.configs.length; i++) {
      if (settings.configs[i].id === settings.activeConfig) return settings.configs[i];
    }
    return settings.configs[0];
  }

  function bookWithDefaults(stored) {
    var out = Object.assign({}, DEFAULT_BOOK, stored || {});
    if (!Array.isArray(out.chapters)) out.chapters = [];
    if (out.titleMode !== 'numbered') out.titleMode = 'firstLine';
    out.nextId = Math.max(Number(out.nextId) || 1, 1);
    return out;
  }

  function wordCount(text) {
    var m = String(text || '').trim().match(/\S+/g);
    return m ? m.length : 0;
  }

  /** What two copies of the same chapter have in common. */
  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function isHttp(url) {
    return /^https?:/i.test(String(url || ''));
  }

  // ---------------------------------------------------- selector plumbing --

  function looksLikeXPath(sel) {
    return /^\s*[(/]|^\s*\.\//.test(sel);
  }

  function typeOf(entry) {
    if (entry.type && entry.type !== 'auto') return entry.type;
    return looksLikeXPath(entry.value) ? 'xpath' : 'css';
  }

  function queryShadow(selector, root_) {
    var hops = selector.split(SHADOW_SEP);
    var scopes = [root_];
    for (var i = 0; i < hops.length; i++) {
      var hop = hops[i].trim();
      if (!hop) continue;
      var next = [];
      for (var j = 0; j < scopes.length; j++) {
        var found = scopes[j].querySelectorAll(hop);
        for (var k = 0; k < found.length; k++) {
          if (i === hops.length - 1) next.push(found[k]);
          else if (found[k].shadowRoot) next.push(found[k].shadowRoot);
        }
      }
      scopes = next;
      if (!scopes.length) return [];
    }
    return scopes;
  }

  // Never throws. This runs in a polling loop and must not die on a typo.
  function resolveAll(value, type, doc) {
    doc = doc || root.document;
    value = String(value || '').trim();
    if (!value || !doc) return [];
    try {
      if (type === 'xpath') {
        var out = [];
        var snap = doc.evaluate(value, doc, null, 7, null);
        for (var i = 0; i < snap.snapshotLength; i++) out.push(snap.snapshotItem(i));
        return out;
      }
      if (value.indexOf(SHADOW_SEP) !== -1) return queryShadow(value, doc);
      return Array.prototype.slice.call(doc.querySelectorAll(value));
    } catch (e) {
      return [];
    }
  }

  /**
   * First element matched by the first selector that matches anything.
   * Returns {el, index} so callers can report which selector carried the day.
   */
  function findTarget(selectors, doc, expectText) {
    selectors = selectors || [];
    // When we know what the thing says ("Next Chapter"), a selector that
    // lands on something else ("Prev") on this page is passed over for one
    // that lands on the right thing.
    if (expectText) {
      var want = String(expectText).replace(/\s+/g, ' ').trim().toLowerCase();
      for (var x = 0; x < selectors.length; x++) {
        if (!selectors[x] || !selectors[x].value) continue;
        var found = resolveAll(selectors[x].value, typeOf(selectors[x]), doc);
        for (var y = 0; y < found.length; y++) {
          if (isVisible(found[y]) && buttonText(found[y]) === want) return { el: found[y], index: x, count: found.length };
        }
      }
    }
    for (var i = 0; i < selectors.length; i++) {
      var entry = selectors[i];
      if (!entry || !entry.value) continue;
      var hits = resolveAll(entry.value, typeOf(entry), doc);
      for (var j = 0; j < hits.length; j++) {
        if (isVisible(hits[j])) return { el: hits[j], index: i, count: hits.length };
      }
      if (hits.length) return { el: hits[0], index: i, count: hits.length };
    }
    return null;
  }

  function isVisible(el) {
    if (!el || !el.isConnected || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return false;
    var view = el.ownerDocument && el.ownerDocument.defaultView;
    if (view) {
      var cs = view.getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    }
    return true;
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    var aria = el.getAttribute && el.getAttribute('aria-disabled');
    if (aria === 'true') return true;
    var cls = typeof el.className === 'string' ? el.className : '';
    return /(^|\s)(disabled|is-disabled)(\s|$)/i.test(cls);
  }

  // -------------------------------------------------- selector generation --

  function cssEscape(v) {
    if (root.CSS && root.CSS.escape) return root.CSS.escape(String(v));
    return String(v).replace(/[^\w-]/g, '\\$&');
  }

  function idLooksStable(id) {
    if (!id || id.length > 80) return false;
    if (/^[:.]/.test(id) || /^[0-9]/.test(id)) return false;
    if (/[0-9a-f]{8}-[0-9a-f]{4}/i.test(id)) return false;
    if (/\d{4,}/.test(id)) return false;
    if (/^(ember|mui|radix|headlessui|react-aria)[-_:]?\d/i.test(id)) return false;
    return true;
  }

  // Generated class names (CSS-in-JS hashes, Tailwind-ish utilities with
  // state) change between builds or between pages; real ones read like words.
  function classLooksStable(c) {
    if (!c || c.length > 40 || c.length < 2) return false;
    if (!/^[a-zA-Z][\w-]*$/.test(c)) return false;
    if (/\d{3,}/.test(c)) return false;
    if (/^(css|sc|jsx|emotion|svelte|astro|chakra|mantine|tw)-/i.test(c)) return false;
    if (/^[a-z]+-[a-zA-Z0-9]{5,}$/.test(c) && /[A-Z0-9]/.test(c.split('-').pop())) return false;
    if (/^(active|selected|hover|focus|open|show|hidden|visible|current|is-|has-)/i.test(c)) return false;
    return true;
  }

  function ownerDoc(el) { return (el && el.ownerDocument) || root.document; }

  function searchRoot(el) {
    var node = el;
    while (node) {
      var parent = node.parentNode;
      if (parent && parent.nodeType === 11 && parent.host) return parent;
      if (!parent) break;
      node = parent;
    }
    return ownerDoc(el);
  }

  function tagOf(el) { return el.tagName.toLowerCase(); }

  // DevTools' "Copy XPath", reproduced.
  function absoluteXPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1) {
      if (node.id && idLooksStable(node.id) &&
          resolveAll('//*[@id="' + node.id + '"]', 'xpath', ownerDoc(el)).length === 1) {
        parts.unshift('*[@id="' + node.id + '"]');
        return '//' + parts.join('/');
      }
      var tag = tagOf(node);
      var parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      var sameTag = 0, index = 0;
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i].tagName === node.tagName) {
          sameTag++;
          if (parent.children[i] === node) index = sameTag;
        }
      }
      parts.unshift(sameTag > 1 ? tag + '[' + index + ']' : tag);
      node = parent;
    }
    return '/' + parts.join('/');
  }

  function cssPath(el, stopAt) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1) {
      if (node.id && idLooksStable(node.id)) { parts.unshift('#' + cssEscape(node.id)); break; }
      var tag = tagOf(node);
      var parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      var sameTag = 0, index = 0;
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i].tagName === node.tagName) {
          sameTag++;
          if (parent.children[i] === node) index = sameTag;
        }
      }
      parts.unshift(sameTag > 1 ? tag + ':nth-of-type(' + index + ')' : tag);
      node = parent;
      if (stopAt && node === stopAt) break;
    }
    return parts.join(' > ');
  }

  function xpathLiteral(s) {
    if (s.indexOf('"') === -1) return '"' + s + '"';
    if (s.indexOf("'") === -1) return "'" + s + "'";
    return 'concat("' + s.split('"').join('", \'"\', "') + '")';
  }

  function visibleText(el) {
    var t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.length > 60 ? '' : t;
  }

  function stableClasses(el) {
    var cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/) : [];
    return cls.filter(classLooksStable);
  }

  function buttonText(el) {
    return (el.innerText || el.textContent || (el.getAttribute && el.getAttribute('aria-label')) || '')
      .replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /**
   * Ranked selector candidates, verified against the live DOM.
   *
   * By default a selector only counts if the picked element is the first
   * thing it matches. With {lookalikes: true} it also counts if everything it
   * matches looks the same as the pick - same tag, same text - which is what
   * you want for a next button: most chapter pages have one above the text
   * and one below, and a.next-chap matching both is fine. What it must never
   * do is match "Prev" too.
   */
  function candidatesFor(el, opts) {
    if (!el || el.nodeType !== 1) return [];
    opts = opts || {};
    var doc = ownerDoc(el);
    var shadow = searchRoot(el) !== doc;
    var out = [];
    var want = buttonText(el);

    function lookalike(h) {
      return h === el || (h.tagName === el.tagName && buttonText(h) === want);
    }

    function offer(type, value, label) {
      if (!value) return;
      for (var i = 0; i < out.length; i++) if (out[i].value === value) return;
      var hits = shadow && type === 'css' ? queryShadow(value, doc) : resolveAll(value, type, doc);
      if (!hits.length) return;
      if (hits[0] !== el) {
        if (!opts.lookalikes || !want || hits.indexOf(el) === -1 || !hits.every(lookalike)) return;
      }
      out.push({ type: type, value: value, label: label, count: hits.length });
    }

    var tag = tagOf(el);

    for (var a = 0; a < STABLE_ATTRS.length; a++) {
      var attr = STABLE_ATTRS[a];
      var val = el.getAttribute && el.getAttribute(attr);
      if (!val || val.length > 100) continue;
      offer('css', '[' + attr + '=' + JSON.stringify(val) + ']', attr);
      offer('css', tag + '[' + attr + '=' + JSON.stringify(val) + ']', attr);
    }

    if (el.id && idLooksStable(el.id)) {
      offer('css', '#' + cssEscape(el.id), 'id');
      if (!shadow) offer('xpath', '//*[@id=' + xpathLiteral(el.id) + ']', 'id');
    }

    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria && aria.length <= 80) offer('css', tag + '[aria-label=' + JSON.stringify(aria) + ']', 'aria-label');

    var classes = stableClasses(el);
    for (var c = 0; c < classes.length; c++) {
      offer('css', tag + '.' + cssEscape(classes[c]), 'class');
    }
    if (classes.length > 1) {
      offer('css', tag + classes.map(function (k) { return '.' + cssEscape(k); }).join(''), 'classes');
    }

    var text = visibleText(el);
    if (text && !shadow && /^(button|a|span|div|li|input|summary)$/.test(tag)) {
      offer('xpath', '//' + tag + '[normalize-space()=' + xpathLiteral(text) + ']', 'text');
    }

    if (shadow) {
      var host = searchRoot(el).host;
      var hostSel = host ? (candidatesFor(host)[0] || {}).value : null;
      if (hostSel) offer('css', hostSel + ' ' + SHADOW_SEP + ' ' + cssPath(el, searchRoot(el)), 'shadow path');
    } else {
      offer('css', cssPath(el), 'css path');
      offer('xpath', absoluteXPath(el), 'path');
    }

    return out;
  }

  function deepElementFromPoint(x, y, doc) {
    doc = doc || root.document;
    var el = doc.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      var inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  /** A short human label for an element. */
  function describeElement(el) {
    if (!el || el.nodeType !== 1) return '';
    var s = el.tagName.toLowerCase();
    if (el.id) return s + '#' + el.id;
    var cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
    if (cls) s += '.' + cls;
    return s;
  }

  // ------------------------------------------------------------------ api --

  root.EG = {
    SETTINGS_KEY: SETTINGS_KEY,
    BOOK_KEY: BOOK_KEY,
    LIBRARY_KEY: LIBRARY_KEY,
    SHELF_PREFIX: SHELF_PREFIX,
    API: API,
    CHAPTER_PREFIX: CHAPTER_PREFIX,
    RUN_KEY: RUN_KEY,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    DEFAULT_BOOK: DEFAULT_BOOK,

    clamp: clamp,
    withDefaults: withDefaults,
    activeConfig: activeConfig,
    emptyConfig: emptyConfig,
    bookWithDefaults: bookWithDefaults,
    wordCount: wordCount,
    normalizeText: normalizeText,
    isHttp: isHttp,

    typeOf: typeOf,
    resolveAll: resolveAll,
    findTarget: findTarget,
    isVisible: isVisible,
    isDisabled: isDisabled,

    candidatesFor: candidatesFor,
    deepElementFromPoint: deepElementFromPoint,
    describeElement: describeElement
  };

})(typeof globalThis !== 'undefined' ? globalThis : self);
