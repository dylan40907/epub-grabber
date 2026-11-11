'use strict';
/*
 * content.js - runs in the top frame of every page but does nothing until the
 * worker talks to it. It is the extension's hands on the book tab:
 *
 *   startPicker  hover-highlight elements, click one to pick it,
 *                with ↑/↓ to widen or narrow the pick, which is what
 *                you need for a chapter's text: you hover a paragraph, but you
 *                want the element around all of them)
 *   probe        is the chapter text here, and what's its fingerprint?
 *   capture      the chapter, formatting and all (capture.js)
 *   clickNext    press the next chapter button
 *   highlight    flash what a picked selector matches, so you can check it
 */
(function () {

  function alive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  // Loaded twice into the same page (the manifest and an on-demand inject):
  // keep the first. But a copy left over from before the extension was
  // reloaded can't talk to it any more - that one is told to clear its
  // overlays and step aside, rather than blocking this one forever.
  if (window.__epubGrabberAlive && window.__epubGrabberAlive()) return;
  document.dispatchEvent(new CustomEvent('epubgrabber:retire'));
  window.__epubGrabberAlive = alive;

  var SLOT_LABEL = {
    next: 'the next chapter button',
    text: 'the chapter text',
    exclude: 'something inside the text to leave out'
  };

  // ---------------------------------------------------------- fingerprint --

  // Cheap, and only has to tell "same chapter" from "different chapter" while
  // waiting for the next one to load.
  function fingerprint(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return s.length + ':' + (h >>> 0).toString(36);
  }

  function findText(sel) {
    var hit = EG.findTarget(sel && sel.text, document);
    return hit ? hit.el : null;
  }

  // The fallback for a next button that isn't where you picked it.
  function guessNext() {
    var rel = document.querySelector('a[rel~="next"], link[rel~="next"]');
    if (rel && rel.tagName === 'A' && EG.isVisible(rel)) return rel;
    var els = document.querySelectorAll('a, button, [role="button"]');
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].innerText || els[i].getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      if (/^(next|next chapter|next page|next ch\.?)\s*[›»>→]*$/i.test(t) && EG.isVisible(els[i])) return els[i];
    }
    return null;
  }

  function findNext(sel, allowGuess) {
    var hit = EG.findTarget(sel && sel.next, document, sel && sel.nextText);
    if (hit) return { el: hit.el, index: hit.index, guessed: false };
    if (allowGuess) {
      var g = guessNext();
      if (g) return { el: g, index: -1, guessed: true };
    }
    return null;
  }

  /** Where the next button leads, if it's a link. */
  function hrefOf(el) {
    // The link itself, the link around it, or - when what matched is a
    // wrapper - the one link inside it.
    var link = el.closest('a[href]');
    if (!link) {
      var inner = el.querySelectorAll('a[href]');
      if (inner.length === 1) link = inner[0];
    }
    if (!link || !/^https?:/i.test(link.href)) return '';
    if (/^\s*(#|javascript:)/i.test(link.getAttribute('href') || '')) return '';
    return link.href;
  }

  function nextInfo(sel, allowGuess) {
    var next = findNext(sel, allowGuess);
    if (!next) return { found: false };
    return {
      found: true,
      el: next.el,
      disabled: EG.isDisabled(next.el),
      guessed: next.guessed,
      label: (next.el.innerText || next.el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      href: hrefOf(next.el)
    };
  }

  // A "slow down" page instead of the chapter (the run stops on these): Cloudflare's "Error 1015 - You
  // are being rate limited", its "Enable JavaScript and cookies to continue"
  // check, a plain 429. The phrases come from the list on the app page; case,
  // spacing and hyphens don't matter. Only looked for when there's no chapter
  // text, so a chapter that happens to mention one isn't mistaken for it.
  function squash(t) { return String(t || '').toLowerCase().replace(/[\s\u00a0\-\u2010-\u2014]+/g, ' ').trim(); }
  function rateLimited(phrases) {
    var page = squash((document.title || '') + '\n' + (document.body ? document.body.innerText || '' : ''));
    return (phrases || []).some(function (p) { p = squash(p); return !!p && page.indexOf(p) !== -1; });
  }

  function probe(sel, allowGuess, phrases) {
    var el = findText(sel);
    var raw = el ? (el.innerText || el.textContent || '').trim() : '';
    var next = nextInfo(sel, allowGuess);
    var textFound = !!el && raw.length > 0;
    return {
      ok: true,
      url: location.href,
      ready: document.readyState,
      textFound: textFound,
      limited: !textFound && rateLimited(phrases),
      sig: raw ? fingerprint(raw) : '',
      chars: raw.length,
      nextFound: next.found,
      nextDisabled: !!next.disabled,
      nextGuessed: !!next.guessed,
      nextText: next.label || '',
      nextHref: next.href || ''
    };
  }

  function capture(sel) {
    var el = findText(sel);
    if (!el) return { ok: false, error: 'notext', url: location.href };
    var raw = (el.innerText || el.textContent || '').trim();
    var res = EGCapture.capture(el, sel.exclude);
    return {
      ok: true,
      url: location.href,
      pageTitle: document.title,
      sig: raw ? fingerprint(raw) : '',
      blocks: res.blocks,
      text: res.text,
      words: res.words
    };
  }

  /**
   * Press the next button where it is: scroll it
   * into view, ask the browser what's actually on top at its centre, and send
   * that the whole pointer + mouse sequence at those coordinates. Only used
   * when the next button isn't a link - for a link, the worker just opens its
   * address, which is faster and can't be ignored by the site.
   */
  function clickNext(sel, allowGuess) {
    var next = nextInfo(sel, allowGuess);
    if (!next.found) return { ok: true, found: false };
    if (next.disabled) return { ok: true, found: true, disabled: true };
    var el = next.el;
    // Answer first, click after: if the click navigates, the page (and this
    // script) is gone before a reply sent afterwards would get out.
    setTimeout(function () { pointClick(el); }, 0);
    return { ok: true, found: true, disabled: false, guessed: next.guessed, label: next.label, href: next.href };
  }

  function pointClick(el) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var hit = EG.deepElementFromPoint(x, y, document);
    // Whatever is on top at that spot gets the click - unless it's one of
    // ours, or something unrelated is covering the button entirely, in which
    // case the button itself does.
    var receiver = el;
    if (hit && !(hit.getAttribute && hit.getAttribute('data-epubgrabber')) &&
        (el.contains(hit) || hit.contains(el))) receiver = hit;
    var base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x + (window.screenX || 0), screenY: y + (window.screenY || 0),
      detail: 1, button: 0
    };
    var pointer = Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1 }, base);
    function fire(C, type, extra) { receiver.dispatchEvent(new C(type, extra)); }
    fire(PointerEvent, 'pointerover', Object.assign({ buttons: 0 }, pointer));
    fire(MouseEvent, 'mouseover', Object.assign({ buttons: 0 }, base));
    fire(PointerEvent, 'pointerdown', Object.assign({ buttons: 1 }, pointer));
    fire(MouseEvent, 'mousedown', Object.assign({ buttons: 1 }, base));
    fire(PointerEvent, 'pointerup', Object.assign({ buttons: 0 }, pointer));
    fire(MouseEvent, 'mouseup', Object.assign({ buttons: 0 }, base));
    fire(MouseEvent, 'click', Object.assign({ buttons: 0 }, base));
  }

  // ------------------------------------------------------------ highlight --

  // One layer for every highlight box, so they all go together: after a
  // few seconds, on any click or key on the page, when you clear a pick in
  // the console, or when a capture starts.
  var flash = null;

  function clearHighlight() {
    if (!flash) return;
    clearTimeout(flash.timer);
    window.removeEventListener('pointerdown', clearHighlight, true);
    window.removeEventListener('keydown', clearHighlight, true);
    flash.layer.remove();
    flash = null;
  }

  function highlight(els, color) {
    clearHighlight();
    els = els.filter(function (el) { return el && el.isConnected; }).slice(0, 20);
    if (!els.length) return;
    // Scroll first, measure after - a box measured before a scroll is drawn
    // where the element used to be.
    els[0].scrollIntoView({ block: 'center', behavior: 'instant' });
    var layer = document.createElement('div');
    layer.setAttribute('data-epubgrabber', 'flash');
    // Absolute, in page coordinates, so the boxes move with the page if you
    // scroll while they're up.
    layer.style.cssText = 'all:initial;position:absolute;left:0;top:0;width:0;height:0;' +
      'z-index:2147483646;pointer-events:none;';
    els.forEach(function (el) {
      var r = el.getBoundingClientRect();
      var box = document.createElement('div');
      box.style.cssText = 'all:initial;position:absolute;pointer-events:none;box-sizing:border-box;' +
        'border:3px solid ' + color + ';background:' + color + '22;border-radius:4px;' +
        'left:' + (r.left + window.scrollX) + 'px;top:' + (r.top + window.scrollY) + 'px;' +
        'width:' + r.width + 'px;height:' + r.height + 'px;';
      layer.appendChild(box);
    });
    document.documentElement.appendChild(layer);
    flash = { layer: layer, timer: setTimeout(clearHighlight, 2500) };
    window.addEventListener('pointerdown', clearHighlight, true);
    window.addEventListener('keydown', clearHighlight, true);
  }

  document.addEventListener('epubgrabber:retire', function () {
    clearHighlight();
    if (picking) picking();
  });

  // --------------------------------------------------------------- picker --

  var picking = null;

  function wordsIn(el) {
    return EG.wordCount(el.innerText || el.textContent || '');
  }

  function sendPick(el, slot) {
    if (!el) return;
    var info = {
      t: 'picked',
      slot: slot,
      url: location.href,
      pageTitle: document.title,
      tag: el.tagName.toLowerCase(),
      label: EG.describeElement(el),
      text: (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      candidates: EG.candidatesFor(el, { lookalikes: slot === 'next' })
    };
    if (slot === 'text') {
      var cap = EGCapture.capture(el, []);
      info.words = cap.words;
      info.firstLine = cap.blocks.length ? cap.blocks[0].text.slice(0, 80) : '';
      info.blockCount = cap.blocks.length;
    }
    chrome.runtime.sendMessage(info).catch(function () {});
  }

  function startPicker(slot) {
    if (picking) picking();
    slot = SLOT_LABEL[slot] ? slot : 'text';
    var overlay = document.createElement('div');
    overlay.setAttribute('data-epubgrabber', 'picker');
    overlay.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    var sr = overlay.attachShadow({ mode: 'closed' });
    var color = slot === 'next' ? '#f59e0b' : slot === 'exclude' ? '#ef4444' : '#38bdf8';
    sr.innerHTML =
      '<style>' +
      '.box{position:fixed;border:2px solid ' + color + ';background:' + color + '24;border-radius:3px;display:none}' +
      '.tip{position:fixed;font:500 12px/1.3 ui-sans-serif,system-ui,Segoe UI,sans-serif;' +
      'background:#0f172a;color:#e2e8f0;padding:5px 8px;border-radius:6px;max-width:60vw;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none}' +
      '.hint{position:fixed;left:50%;top:14px;transform:translateX(-50%);background:#0f172a;' +
      'color:#e2e8f0;font:600 13px/1.4 ui-sans-serif,system-ui,Segoe UI,sans-serif;text-align:center;' +
      'padding:8px 14px;border-radius:8px;border:1px solid ' + color + ';box-shadow:0 4px 18px #0006}' +
      '.hint small{display:block;font-weight:400;color:#94a3b8}' +
      '</style>' +
      '<div class="box"></div><div class="tip"></div>' +
      '<div class="hint">Click ' + SLOT_LABEL[slot] +
      (slot === 'text'
        ? '<small>↑ widens to the element around it, ↓ narrows back · Enter picks · Esc cancels</small>'
        : '<small>Esc cancels</small>') +
      '</div>';
    var box = sr.querySelector('.box'), tip = sr.querySelector('.tip');
    var hovered = null, current = null, trail = [];
    document.documentElement.appendChild(overlay);

    function at(e) {
      var path = e.composedPath && e.composedPath();
      var el = (path && path.length && path[0].nodeType === 1) ? path[0] : null;
      if (!el || el === overlay) el = EG.deepElementFromPoint(e.clientX, e.clientY);
      if (el && el.getAttribute && el.getAttribute('data-epubgrabber')) return null;
      return el;
    }
    function show(el) {
      current = el;
      if (!el) return;
      var r = el.getBoundingClientRect();
      box.style.cssText = 'display:block;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width +
        'px;height:' + r.height + 'px';
      var best = EG.candidatesFor(el)[0];
      var extra = slot === 'text' ? '  ·  ' + wordsIn(el).toLocaleString() + ' words' : '';
      tip.style.display = 'block';
      tip.textContent = '<' + el.tagName.toLowerCase() + '>  ' + (best ? best.value : '(no stable selector)') + extra;
      var tipTop = r.bottom + 26 < window.innerHeight ? r.bottom + 6 : Math.max(4, r.top - 26);
      if (tipTop < 70 && r.height > window.innerHeight - 100) tipTop = window.innerHeight - 34;
      tip.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 360)) + 'px';
      tip.style.top = tipTop + 'px';
    }
    function onMove(e) {
      var el = at(e);
      if (!el || el === hovered) return;
      hovered = el;
      trail = [];
      show(el);
    }
    function pick() {
      var el = current;
      cleanup();
      if (el) sendPick(el, slot);
    }
    function onClick(e) {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if (!current) { current = at(e); }
      pick();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cleanup(); return; }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); pick(); return; }
      if (e.key === 'ArrowUp' && current && current.parentElement && current.parentElement !== document.documentElement) {
        e.preventDefault(); e.stopPropagation();
        trail.push(current);
        show(current.parentElement);
      } else if (e.key === 'ArrowDown' && trail.length) {
        e.preventDefault(); e.stopPropagation();
        show(trail.pop());
      }
    }
    var swallow = function (e) { e.preventDefault(); e.stopPropagation(); };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('mousedown', swallow, true);
    window.addEventListener('mouseup', swallow, true);
    window.addEventListener('keydown', onKey, true);

    function cleanup() {
      if (!picking) return;
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('mousedown', swallow, true);
      window.removeEventListener('mouseup', swallow, true);
      window.removeEventListener('keydown', onKey, true);
      overlay.remove();
      picking = null;
    }
    picking = cleanup;
  }

  // ------------------------------------------------------------- messages --

  if (!alive()) return;

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.t !== 'string') return;
    try {
      switch (msg.t) {
        case 'ping':
          sendResponse({ ok: true, url: location.href });
          return;
        case 'probe':
          sendResponse(probe(msg.sel, msg.allowGuess, msg.phrases));
          return;
        case 'capture':
          sendResponse(capture(msg.sel));
          return;
        case 'clickNext':
          clearHighlight();
          sendResponse(clickNext(msg.sel, msg.allowGuess));
          return;
        case 'unhighlight':
          clearHighlight();
          sendResponse({ ok: true });
          return;
        case 'startPicker':
          clearHighlight();
          startPicker(msg.slot);
          sendResponse({ ok: true });
          return;
        case 'highlight': {
          var list = (msg.selectors || []);
          var hit = msg.all ? null : EG.findTarget(list, document);
          var els = hit ? [hit.el] : [];
          if (msg.all) list.forEach(function (s) { els = els.concat(EG.resolveAll(s.value, EG.typeOf(s), document)); });
          highlight(els, msg.color || '#38bdf8');
          sendResponse({ ok: true, found: els.length });
          return;
        }
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  });

})();
