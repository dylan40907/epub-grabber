'use strict';
/*
 * epub.js - builds the .epub: a small ZIP writer and an EPUB 3 package with an
 * EPUB 2 NCX, so older readers get a table of contents too. Chapter bodies are
 * the captured XHTML with formatting intact, and entries are deflated when the
 * browser supports CompressionStream, which makes the file about a third the size.
 *
 *   EGEpub.build({ title, author, chapters: [{ title, html }] }) -> Promise<Blob>
 */
(function (root) {

  var enc = new TextEncoder();
  var X = function (s) { return root.EGCapture.escapeXml(s); };

  // ------------------------------------------------------------- the zip --

  var crcTable = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function canDeflate() {
    try { new CompressionStream('deflate-raw'); return true; } catch (e) { return false; }
  }

  function deflate(bytes) {
    var cs = new CompressionStream('deflate-raw');
    var stream = new Blob([bytes]).stream().pipeThrough(cs);
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  // Builds a ZIP from [{name, data:Uint8Array, store?:bool}].
  async function makeZip(entries) {
    var chunks = [], central = [], offset = 0;
    var useDeflate = canDeflate();
    var u16 = function (n) { return new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF]); };
    var u32 = function (n) { return new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]); };

    for (var e of entries) {
      var nameBytes = enc.encode(e.name);
      var data = e.data;
      var crc = crc32(data);
      var method = 0, body = data;
      if (useDeflate && !e.store && data.length > 64) {
        var packed = await deflate(data);
        if (packed.length < data.length) { method = 8; body = packed; }
      }

      var local = [
        u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0x21),
        u32(crc), u32(body.length), u32(data.length), u16(nameBytes.length), u16(0),
        nameBytes, body
      ];
      var localSize = 0;
      local.forEach(function (c) { chunks.push(c); localSize += c.length; });

      [
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0x21),
        u32(crc), u32(body.length), u32(data.length), u16(nameBytes.length),
        u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes
      ].forEach(function (c) { central.push(c); });

      offset += localSize;
    }

    var centralStart = offset, centralSize = 0;
    central.forEach(function (c) { chunks.push(c); centralSize += c.length; });
    [
      u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
      u32(centralSize), u32(centralStart), u16(0)
    ].forEach(function (c) { chunks.push(c); });

    return new Blob(chunks, { type: 'application/epub+zip' });
  }

  // ------------------------------------------------------------ the book --

  var STYLE =
    'html { font-size: 100%; }\n' +
    'body { margin: 5% 6%; font-family: Georgia, "Times New Roman", serif; line-height: 1.6; }\n' +
    'h1 { font-size: 1.5em; line-height: 1.3; margin: 0 0 1em; text-align: left; }\n' +
    'h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.2em 0 0.6em; }\n' +
    'p { margin: 0 0 0.2em; text-indent: 1.4em; orphans: 2; widows: 2; }\n' +
    'h1 + p, h2 + p, h3 + p, hr + p, p.center + p, blockquote + p, ul + p, ol + p, pre + p { text-indent: 0; }\n' +
    'section > p:first-of-type { text-indent: 0; }\n' +
    '.center { text-align: center; text-indent: 0; }\n' +
    '.right { text-align: right; text-indent: 0; }\n' +
    'hr { border: none; text-align: center; margin: 1.2em 0; }\n' +
    'hr::after { content: "* * *"; }\n' +
    'blockquote { margin: 0.8em 1.5em; }\n' +
    'blockquote p { text-indent: 0; margin-bottom: 0.5em; }\n' +
    'pre { white-space: pre-wrap; font-family: inherit; }\n' +
    'li p { text-indent: 0; }\n';

  function chapterXhtml(title, body) {
    return '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">\n' +
      '<head>\n<meta charset="utf-8"/>\n<title>' + X(title) + '</title>\n' +
      '<link rel="stylesheet" type="text/css" href="style.css"/>\n</head>\n<body>\n' +
      '<section epub:type="chapter">\n<h1>' + X(title) + '</h1>\n' + body + '\n</section>\n</body>\n</html>';
  }

  function uuid() {
    if (root.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function build(book) {
    var title = (book.title || '').trim() || 'Untitled Book';
    var author = (book.author || '').trim() || 'Unknown Author';
    var bookId = 'urn:uuid:' + uuid();
    var modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    var files = [];

    // mimetype MUST be first and stored uncompressed.
    files.push({ name: 'mimetype', data: enc.encode('application/epub+zip'), store: true });

    files.push({ name: 'META-INF/container.xml', data: enc.encode(
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
      '  <rootfiles>\n' +
      '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n' +
      '  </rootfiles>\n' +
      '</container>') });

    files.push({ name: 'OEBPS/style.css', data: enc.encode(STYLE) });

    var manifest = [], spine = [], nav = [], ncx = [];
    book.chapters.forEach(function (c, i) {
      var n = i + 1, fname = 'chap' + n + '.xhtml', cid = 'chap' + n;
      var t = c.title || ('Chapter ' + n);
      files.push({ name: 'OEBPS/' + fname, data: enc.encode(chapterXhtml(t, c.html)) });
      manifest.push('<item id="' + cid + '" href="' + fname + '" media-type="application/xhtml+xml"/>');
      spine.push('<itemref idref="' + cid + '"/>');
      nav.push('<li><a href="' + fname + '">' + X(t) + '</a></li>');
      ncx.push('<navPoint id="np' + n + '" playOrder="' + n + '">\n' +
        '  <navLabel><text>' + X(t) + '</text></navLabel>\n' +
        '  <content src="' + fname + '"/>\n</navPoint>');
    });

    files.push({ name: 'OEBPS/nav.xhtml', data: enc.encode(
      '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">\n' +
      '<head><meta charset="utf-8"/><title>Contents</title></head>\n<body>\n' +
      '<nav epub:type="toc" id="toc">\n<h1>Contents</h1>\n<ol>\n' + nav.join('\n') + '\n</ol>\n</nav>\n</body>\n</html>') });

    files.push({ name: 'OEBPS/toc.ncx', data: enc.encode(
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n<head>\n' +
      '  <meta name="dtb:uid" content="' + bookId + '"/>\n' +
      '  <meta name="dtb:depth" content="1"/>\n' +
      '  <meta name="dtb:totalPageCount" content="0"/>\n' +
      '  <meta name="dtb:maxPageNumber" content="0"/>\n</head>\n' +
      '<docTitle><text>' + X(title) + '</text></docTitle>\n<navMap>\n' + ncx.join('\n') + '\n</navMap>\n</ncx>') });

    files.push({ name: 'OEBPS/content.opf', data: enc.encode(
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">\n' +
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
      '  <dc:identifier id="bookid">' + bookId + '</dc:identifier>\n' +
      '  <dc:title>' + X(title) + '</dc:title>\n' +
      '  <dc:creator>' + X(author) + '</dc:creator>\n' +
      '  <dc:language>en</dc:language>\n' +
      '  <meta property="dcterms:modified">' + modified + '</meta>\n' +
      '</metadata>\n<manifest>\n' +
      '  <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n' +
      '  <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n' +
      '  <item id="css" href="style.css" media-type="text/css"/>\n' +
      manifest.join('\n') + '\n</manifest>\n<spine toc="ncx">\n' + spine.join('\n') + '\n</spine>\n</package>') });

    return makeZip(files);
  }

  function fileName(title) {
    return ((title || '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'book') + '.epub';
  }

  root.EGEpub = { build: build, fileName: fileName };

})(typeof globalThis !== 'undefined' ? globalThis : self);
