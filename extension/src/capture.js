'use strict';
/*
 * capture.js - turns the chapter element on the page into clean EPUB XHTML,
 * keeping the formatting a reader can see.
 *
 * Copying text loses italics because the formatting usually isn't in the
 * markup the clipboard sees: a site styles <span class="it">, or sets
 * font-style on a paragraph, or uses <i> one place and CSS the next. So this
 * reads the *computed* style of every element - what the page actually looks
 * like - and writes it back out as <em>, <strong>, <u>, <s>, <sup>, <sub>.
 * Paragraph structure is read the same way: anything the browser lays out as a
 * block is a block, and a <br><br> or a blank line in pre-wrapped text is a
 * paragraph break.
 *
 * Also skipped on purpose: text the reader can't see. Sites that guard
 * against scraping hide watermark sentences in the chapter with font-size:0,
 * opacity:0 or an off-screen position; copying the text picks those up.
 *
 * capture(el, excludeSelectors) -> { blocks, text, words }
 *   blocks: [{ tag: 'p'|'h1'..'h6'|'li'|'pre'|'hr', html, text, align, quote, list }]
 * renderBlocks(blocks) -> XHTML string (also used by the console and the EPUB).
 */
(function (root) {

  var SKIP = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1,
    BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, OPTION: 1, SVG: 1, CANVAS: 1,
    VIDEO: 1, AUDIO: 1, FORM: 1, NAV: 1, IMG: 1, PICTURE: 1, RT: 1, RP: 1, DIALOG: 1,
    LINK: 1, META: 1, HEAD: 1
  };

  // Tag order for nesting: outermost first.
  var FLAGS = ['b', 'i', 'u', 's', 'sup', 'sub'];
  var TAG = { b: 'strong', i: 'em', u: 'u', s: 's', sup: 'sup', sub: 'sub' };

  function isBold(cs) {
    var w = cs.fontWeight;
    if (w === 'bold' || w === 'bolder') return true;
    return parseInt(w, 10) >= 600;
  }

  function isItalic(cs) {
    return cs.fontStyle === 'italic' || /^oblique/.test(cs.fontStyle);
  }

  function isInlineDisplay(d) {
    return /^inline/.test(d) || d === 'contents' || /^ruby/.test(d);
  }

  /** Text that is in the DOM but not on the screen. */
  function hiddenFromReader(el, cs) {
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
    if (parseFloat(cs.opacity) === 0) return true;
    if (parseFloat(cs.fontSize) === 0) return true;
    if (cs.color === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(cs.color)) return true;
    if (cs.position === 'absolute' || cs.position === 'fixed') {
      var r = el.getBoundingClientRect();
      var view = el.ownerDocument.defaultView;
      if (r.right < -100 || r.bottom < -100 || r.left > view.innerWidth + 5000) return true;
      if (r.width <= 1 && r.height <= 1) return true;
    }
    if ((cs.overflow === 'hidden' || cs.clip !== 'auto') &&
        el.getBoundingClientRect().width <= 1 && el.getBoundingClientRect().height <= 1) return true;
    return false;
  }

  function escapeXml(s) {
    return String(s)
      // Characters XML 1.0 forbids outright - a stray one makes the whole
      // chapter unreadable in Apple Books.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttr(s) {
    return escapeXml(s).replace(/"/g, '&quot;');
  }

  function matchesAny(el, selectors) {
    if (!selectors || !selectors.length) return false;
    for (var i = 0; i < selectors.length; i++) {
      var s = selectors[i];
      if (!s || !s.value) continue;
      try {
        if (s.type === 'xpath') {
          if (s._set && s._set.has(el)) return true;
        } else if (el.matches(s.value)) {
          return true;
        }
      } catch (e) { /* bad selector: ignore */ }
    }
    return false;
  }

  function capture(rootEl, excludeSelectors) {
    var doc = rootEl.ownerDocument;
    var view = doc.defaultView;
    var excludes = (excludeSelectors || []).map(function (s) {
      var copy = { type: s.type, value: s.value };
      if (s.type === 'xpath' && root.EG) copy._set = new Set(root.EG.resolveAll(s.value, 'xpath', doc));
      return copy;
    });

    var rootCs = view.getComputedStyle(rootEl);
    var base = { i: isItalic(rootCs), b: isBold(rootCs) };

    var blocks = [];
    var para = null;  // { tokens, ctx }

    function startCtx() {
      return { tag: 'p', align: '', quote: false, list: '', pre: false };
    }

    function push(tok, ctx) {
      if (!para) para = { tokens: [], ctx: ctx };
      para.tokens.push(tok);
    }

    function flush() {
      if (!para) return;
      var p = para;
      para = null;
      emit(p.tokens, p.ctx);
    }

    function flagsFor(el, cs, parent, ctx) {
      var tag = el.tagName;
      var deco = cs.textDecorationLine || cs.textDecoration || '';
      var inLink = parent.link || tag === 'A';
      return {
        i: isItalic(cs) && !base.i,
        b: isBold(cs) && !base.b && !/^h[1-6]$/.test(ctx.tag),
        // text-decoration isn't inherited in computed style, only drawn, so
        // it has to be carried down by hand. Links are underlined by default
        // and that isn't formatting worth keeping.
        u: parent.u || (!inLink && /underline/.test(deco)),
        s: parent.s || /line-through/.test(deco),
        sup: parent.sup || tag === 'SUP' || cs.verticalAlign === 'super',
        sub: parent.sub || tag === 'SUB' || cs.verticalAlign === 'sub',
        link: inLink
      };
    }

    function ctxFor(el, cs, parent) {
      var ctx = Object.assign({}, parent);
      var tag = el.tagName;
      ctx.tag = 'p';
      if (/^H[1-6]$/.test(tag)) ctx.tag = tag.toLowerCase();
      else if (tag === 'LI' || cs.display === 'list-item') {
        ctx.tag = 'li';
        if (!ctx.list) ctx.list = 'ul';
      }
      if (tag === 'UL' || tag === 'OL') ctx.list = tag.toLowerCase();
      if (tag === 'BLOCKQUOTE') ctx.quote = true;
      var ws = cs.whiteSpace;
      ctx.pre = tag === 'PRE' || ws === 'pre' || ws === 'pre-wrap' || ws === 'pre-line' || ws === 'break-spaces';
      ctx.realPre = tag === 'PRE' || (parent.realPre && ctx.pre);
      var ta = cs.textAlign;
      ctx.align = (ta === 'center' || ta === '-webkit-center') ? 'center'
        : (ta === 'right' || ta === 'end' || ta === '-webkit-right') ? 'right' : '';
      return ctx;
    }

    function addText(s, flags, ctx, ws) {
      if (!s) return;
      var pre = ws === 'pre' || ws === 'pre-wrap' || ws === 'pre-line' || ws === 'break-spaces';
      if (!pre) {
        push({ t: 'text', s: s.replace(/[ \t\n\r\f]+/g, ' '), f: flags }, ctx);
        return;
      }
      var lines = s.replace(/\r\n?/g, '\n').split('\n');
      for (var i = 0; i < lines.length; i++) {
        if (i > 0) push({ t: 'br' }, ctx);
        var line = ws === 'pre-line' ? lines[i].replace(/[ \t\f]+/g, ' ') : lines[i];
        if (line) push({ t: 'text', s: line, f: flags, keep: !!ctx.realPre }, ctx);
      }
    }

    function walk(el, ctx, flags, cs) {
      for (var n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) {
          addText(n.nodeValue, flags, ctx, cs.whiteSpace);
          continue;
        }
        if (n.nodeType !== 1) continue;
        var tag = n.tagName.toUpperCase();
        if (SKIP[tag]) continue;
        if (n.getAttribute && n.getAttribute('data-epubgrabber')) continue;
        if (tag === 'BR') { push({ t: 'br' }, ctx); continue; }
        var ccs = view.getComputedStyle(n);
        if (hiddenFromReader(n, ccs)) continue;
        if (matchesAny(n, excludes)) continue;

        if (tag === 'HR') {
          flush();
          blocks.push({ tag: 'hr', html: '', text: '', align: '', quote: ctx.quote, list: '' });
          continue;
        }

        var shadow = n.shadowRoot;
        if (isInlineDisplay(ccs.display)) {
          var f = flagsFor(n, ccs, flags, ctx);
          walk(shadow || n, ctx, f, ccs);
        } else {
          flush();
          var c = ctxFor(n, ccs, ctx);
          walk(shadow || n, c, flagsFor(n, ccs, flags, c), ccs);
          flush();
        }
      }
    }

    /** One paragraph's worth of tokens -> blocks (a <br><br> splits it). */
    function emit(tokens, ctx) {
      var groups = [[]];
      for (var i = 0; i < tokens.length; i++) {
        var t = tokens[i];
        if (t.t === 'br' && !ctx.realPre) {
          // Two or more breaks in a row, ignoring whitespace between them, is
          // how a lot of sites write paragraphs.
          var j = i + 1;
          while (j < tokens.length && tokens[j].t === 'text' && !tokens[j].s.trim()) j++;
          if (j < tokens.length && tokens[j].t === 'br') {
            while (j < tokens.length && (tokens[j].t === 'br' ||
                   (tokens[j].t === 'text' && !tokens[j].s.trim()))) j++;
            groups.push([]);
            i = j - 1;
            continue;
          }
        }
        groups[groups.length - 1].push(t);
      }
      groups.forEach(function (g) { emitOne(g, ctx); });
    }

    function emitOne(tokens, ctx) {
      // Trim breaks and spaces off both ends.
      while (tokens.length && (tokens[0].t === 'br' || (tokens[0].t === 'text' && !tokens[0].keep && !tokens[0].s.trim()))) tokens.shift();
      while (tokens.length && (tokens[tokens.length - 1].t === 'br' ||
             (tokens[tokens.length - 1].t === 'text' && !tokens[tokens.length - 1].keep && !tokens[tokens.length - 1].s.trim()))) tokens.pop();
      if (!tokens.length) return;

      var html = '', text = '', stack = [], lastSpace = true;
      function close(k) { while (stack.length > k) html += '</' + TAG[stack.pop()] + '>'; }

      for (var i = 0; i < tokens.length; i++) {
        var t = tokens[i];
        if (t.t === 'br') { html += '<br/>'; text += '\n'; lastSpace = true; continue; }
        var s = t.s;
        if (!t.keep) {
          if (lastSpace) s = s.replace(/^ +/, '');
          if (i === tokens.length - 1 || (tokens[i + 1] && tokens[i + 1].t === 'br')) s = s.replace(/ +$/, '');
        }
        if (!s) continue;
        // A space between two runs goes outside any formatting the next run
        // drops and before any it adds: "<em>Click.</em> <u>BANG</u>", and
        // two italic words stay one <em>.
        var nextText = t;
        if (!s.trim()) {
          nextText = null;
          for (var j = i + 1; j < tokens.length; j++) {
            if (tokens[j].t === 'text' && tokens[j].s.trim()) { nextText = tokens[j]; break; }
          }
        }
        var want = nextText ? FLAGS.filter(function (k) { return nextText.f[k]; }) : [];
        var keep = 0;
        while (keep < stack.length && want.indexOf(stack[keep]) !== -1) keep++;
        close(keep);
        if (s.trim()) {
          want.forEach(function (k) {
            if (stack.indexOf(k) === -1) { stack.push(k); html += '<' + TAG[k] + '>'; }
          });
        }
        html += escapeXml(s);
        text += s;
        lastSpace = / $/.test(s);
      }
      close(0);
      if (!text.trim()) return;
      blocks.push({
        tag: ctx.realPre ? 'pre' : ctx.tag,
        html: html,
        text: text.trim(),
        align: ctx.align,
        quote: ctx.quote,
        list: ctx.tag === 'li' ? ctx.list : ''
      });
    }

    var top = startCtx();
    top = ctxFor(rootEl, rootCs, top);
    if (top.tag === 'li') top.tag = 'p';
    walk(rootEl.shadowRoot || rootEl, top, flagsFor(rootEl, rootCs, {}, top), rootCs);
    flush();

    var text = blocks.map(function (b) { return b.text; }).join('\n\n');
    return { blocks: blocks, text: text, words: root.EG ? root.EG.wordCount(text) : 0 };
  }

  /** Blocks -> XHTML body markup, grouping list items and quotes. */
  function renderBlocks(blocks) {
    var out = [];
    var inQuote = false, list = '';
    function closeList() { if (list) { out.push('</' + list + '>'); list = ''; } }
    function closeQuote() { if (inQuote) { closeList(); out.push('</blockquote>'); inQuote = false; } }

    (blocks || []).forEach(function (b) {
      if (b.quote && !inQuote) { closeList(); out.push('<blockquote>'); inQuote = true; }
      if (!b.quote && inQuote) closeQuote();
      if (b.tag === 'li') {
        if (list !== b.list) { closeList(); list = b.list || 'ul'; out.push('<' + list + '>'); }
      } else {
        closeList();
      }
      var cls = b.align ? ' class="' + escapeAttr(b.align) + '"' : '';
      if (b.tag === 'hr') out.push('<hr/>');
      else out.push('<' + b.tag + cls + '>' + b.html + '</' + b.tag + '>');
    });
    closeQuote();
    closeList();
    return out.join('\n');
  }

  root.EGCapture = {
    capture: capture,
    renderBlocks: renderBlocks,
    escapeXml: escapeXml,
    escapeAttr: escapeAttr
  };

})(typeof globalThis !== 'undefined' ? globalThis : self);
