'use strict';
/*
 * ui.js - the extension's own dialog boxes, in place of the browser's
 * confirm(), which looks like nothing else here (and offers to block the
 * page's dialogs). Styles are in ui.css.
 *
 *   EGUI.confirm({ title, message, ok: 'Delete', danger: true }) -> Promise<boolean>
 *   EGUI.choose({ title, message, choices: [{ label, value, primary?, danger? }] })
 *     -> Promise<value | null>   (null: Esc, or a click outside the box)
 */
(function (root) {

  var open = null;

  function dialog(opts) {
    opts = opts || {};
    if (open) open(null);
    return new Promise(function (resolve) {
      var back = document.createElement('div');
      back.className = 'eg-modal-back';
      back.innerHTML =
        '<div class="eg-modal' + (opts.danger ? ' danger' : '') + (opts.wide ? ' wide' : '') +
          '" role="alertdialog" aria-modal="true" aria-labelledby="egModalTitle">' +
          '<div class="eg-modal-title" id="egModalTitle"></div>' +
          '<div class="eg-modal-msg"></div>' +
          '<div class="eg-modal-btns"></div>' +
        '</div>';
      back.querySelector('.eg-modal-title').textContent = opts.title || 'Are you sure?';
      back.querySelector('.eg-modal-msg').textContent = opts.message || '';
      var row = back.querySelector('.eg-modal-btns');
      var buttons = opts.choices.map(function (c) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = c.className || (c.primary ? 'eg-modal-ok' : 'eg-modal-cancel');
        b.textContent = c.label;
        b.addEventListener('click', function () { done(c.value); });
        row.appendChild(b);
        return b;
      });

      var before = document.activeElement;
      function done(answer) {
        if (!back.isConnected) return;
        open = null;
        document.removeEventListener('keydown', onKey, true);
        back.classList.add('closing');
        setTimeout(function () { back.remove(); }, 120);
        if (before && before.focus) try { before.focus(); } catch (e) {}
        resolve(answer);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(opts.escValue === undefined ? null : opts.escValue); }
        else if (e.key === 'Tab') {
          // Keep focus on the buttons.
          e.preventDefault();
          var i = buttons.indexOf(document.activeElement);
          buttons[(i + (e.shiftKey ? buttons.length - 1 : 1)) % buttons.length].focus();
        }
      }
      back.addEventListener('mousedown', function (e) {
        if (e.target === back) done(opts.escValue === undefined ? null : opts.escValue);
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(back);
      open = done;
      (buttons[opts.focus || 0] || buttons[0]).focus();
    });
  }

  function confirmBox(opts) {
    opts = opts || {};
    return dialog({
      title: opts.title, message: opts.message, danger: opts.danger, escValue: false,
      choices: [
        { label: opts.cancel || 'Cancel', value: false },
        { label: opts.ok || 'OK', value: true, primary: true }
      ],
      // Something that can't be undone starts on Cancel, so Enter is safe.
      focus: opts.danger ? 0 : 1
    });
  }

  function choose(opts) {
    opts = Object.assign({}, opts);
    // The first choice (the one on the right is the main one) gets focus.
    var choices = (opts.choices || []).slice();
    return dialog(Object.assign(opts, { choices: choices, focus: opts.focus || 0 }));
  }

  root.EGUI = { confirm: confirmBox, choose: choose };

})(typeof globalThis !== 'undefined' ? globalThis : self);
