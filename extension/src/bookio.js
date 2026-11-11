'use strict';
/*
 * bookio.js - turning the stored book into EPUB chapters and a download.
 * Used by the app page (an extension page, so it has chrome.storage,
 * capture.js and epub.js loaded).
 */
(function (root) {

  function firstTextBlock(blocks) {
    for (var i = 0; i < blocks.length; i++) if (blocks[i].tag !== 'hr' && blocks[i].text) return i;
    return -1;
  }

  /** The title a chapter will get in the EPUB. */
  function titleOf(book, meta, i) {
    if (meta.title) return meta.title;
    if (book.titleMode === 'firstLine' && meta.firstLine) return meta.firstLine;
    return 'Chapter ' + (i + 1);
  }

  /** {title, html} for one chapter, as it will go into the EPUB. */
  function chapterFor(book, meta, body, i) {
    var blocks = (body && body.blocks) || [];
    if (book.titleMode === 'firstLine') {
      // The first line is the title, so it comes out of the text - same as
      // the old EPUB Creator. A renamed chapter still loses its first line,
      // so switching modes never leaves a heading printed twice.
      var k = firstTextBlock(blocks);
      if (k !== -1) blocks = blocks.slice(0, k).concat(blocks.slice(k + 1));
    }
    return { title: titleOf(book, meta, i), html: EGCapture.renderBlocks(blocks) };
  }

  /** Build the EPUB and hand it to the browser as a download. */
  function download(book) {
    var keys = book.chapters.map(function (c) { return EG.CHAPTER_PREFIX + c.id; });
    return chrome.storage.local.get(keys).then(function (got) {
      var chapters = book.chapters.map(function (c, i) {
        return chapterFor(book, c, got[EG.CHAPTER_PREFIX + c.id], i);
      });
      return EGEpub.build({ title: book.title, author: book.author, chapters: chapters });
    }).then(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = EGEpub.fileName(book.title || 'book');
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
      return { name: a.download, size: blob.size };
    });
  }

  root.EGBook = { titleOf: titleOf, chapterFor: chapterFor, download: download, firstTextBlock: firstTextBlock };

})(typeof globalThis !== 'undefined' ? globalThis : self);
