/*
 * A fake book site, for rehearsing EPUB Grabber and for tools/test.mjs.
 *
 *   node tools/serve.mjs          then open the printed URLs
 *
 * Three books, each one a way a real site ends or misbehaves:
 *
 *   /book/1 .. /book/5    a page per chapter. Next on the last chapter just
 *                         reloads it (the "keeps copying the last chapter"
 *                         case). Chapter 3 has an extra banner above the text,
 *                         so a positional selector would break there.
 *   /ending/1 .. /ending/3  next on the last chapter goes to a "thanks for
 *                         reading" page with no chapter on it.
 *   /spa                  one page; next swaps the chapter in place, loads it
 *                         in two pieces, and is disabled on the last one.
 *   /busy/1 .. /busy/3    like an ad-heavy site: every page has a request
 *                         that never finishes, so the tab never stops
 *                         "loading", and Next is a <div> that only reacts to
 *                         mousedown, sitting far below the fold. A plain
 *                         el.click() does nothing on it.
 *   /order/1 .. /order/8  odd chapters take 2.5s to show their text, even ones
 *                         are instant, so later chapters finish first. The last
 *                         one has no next button at all.
 *   /reader/1 .. /reader/3  laid out like the reader Config 1 was picked on:
 *                         the text in div#article, a "Next Chapter" link, and
 *                         no next link on the last chapter.
 *   /limited/1 .. /limited/6  chapters 3 and 5 answer the first two requests
 *                         with Cloudflare's "Error 1015 - You are being rate
 *                         limited" page (HTTP 429), then serve normally.
 *                         Chapter 4's first request gets Cloudflare's check
 *                         page ("Enable JavaScript and cookies to continue").
 *   /twice/1 .. /twice/5  Config 1's layout, but the site posted chapter 3
 *                         twice: /twice/4 is chapter 3 again with one word
 *                         more (an "edited" repost), /twice/5 is chapter 4.
 *   /strict/1 .. /strict/3  Next is an ordinary link, but the page cancels any
 *                         click that didn't come from a real mouse
 *                         (event.isTrusted), which no extension can fake.
 *
 * Every chapter carries the formatting the old macro lost - <em>, CSS-only
 * italics and bold, <br><br> paragraphs - plus the junk a capture should drop:
 * an ad box, and watermark text hidden with font-size:0 and off-screen.
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const STYLE = `
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 0 auto; padding: 20px; }
  .thought { font-style: italic; }
  .loud { font-weight: 700; }
  .sfx { text-decoration: underline; }
  .scene { text-align: center; }
  .ad-box { background: #fde68a; padding: 10px; margin: 12px 0; }
  .banner { background: #fee2e2; padding: 8px; }
  .nav { display: flex; gap: 12px; margin: 20px 0; }
  .nav a, .nav button { padding: 8px 14px; border: 1px solid #888; border-radius: 6px; }
  .wm { position: absolute; left: -9999px; }
`;

export function chapterBody(n, book = 'Book') {
  return `
    <h3>Chapter ${n}: The ${['First', 'Second', 'Third', 'Fourth', 'Fifth'][n - 1] || n + 'th'} Door</h3>
    <p>Rain hammered the roof of chapter ${n}. <em>Nobody</em> was coming, and she knew it.</p>
    <p><span class="thought">Why does it always rain,</span> she thought, &amp; frowned at the &lt;door&gt;.</p>
    <p>The sign read <span class="loud">KEEP OUT</span> in letters a foot high.<span style="font-size:0">Stolen from fakebooks.example</span></p>
    <div class="ad-box">Advertisement: buy more books!</div>
    <div>A line in a div.<br><br>A second paragraph made with two breaks.<br>Still the second paragraph.</div>
    <p class="wm">Read the original at fakebooks.example</p>
    <p class="scene">* * *</p>
    <p>She opened it. <i>Click.</i> <span class="sfx">BANG</span>. Water was H<sub>2</sub>O, and this was ${book} part ${n}.\u000B</p>
    <blockquote><p>"Remember the rain," the note said.</p></blockquote>`;
}

function page(title, inner) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${STYLE}</style></head>
<body>${inner}</body></html>`;
}

function multiPage(prefix, n, last, { selfLoopAtEnd }) {
  const next = n < last ? `${prefix}/${n + 1}` : (selfLoopAtEnd ? `${prefix}/${n}` : `${prefix}/end`);
  const banner = n === 3 ? '<div class="banner">Site notice: we moved servers!</div>' : '';
  return page(`Chapter ${n} - The Rain Book | FakeBooks`, `
    <header><a href="/">FakeBooks</a> &rsaquo; The Rain Book</header>
    ${banner}
    <div class="nav top"><a class="prev-chap" href="${prefix}/${Math.max(1, n - 1)}">Prev</a>
      <a class="btn next-chap" href="${next}">Next Chapter</a></div>
    <main>
      <div class="chapter-content">${chapterBody(n, 'The Rain Book')}</div>
    </main>
    <div class="nav bottom"><a class="btn next-chap" href="${next}">Next Chapter</a></div>
    <footer>Comments (12)</footer>`);
}

function busy(n, last) {
  const filler = Array.from({ length: 40 }, (_, i) => `<p>Comment ${i + 1}: great chapter!</p>`).join('');
  const next = n < last ? `/busy/${n + 1}` : '';
  return page(`Chapter ${n} - Busy Book`, `
    <img src="/hang" alt="" width="1" height="1">
    <main><div class="chapter-content">${chapterBody(n, 'Busy Book')}</div></main>
    <section class="comments">${filler}</section>
    <div class="nav"><div class="next-chap" role="button" tabindex="0"
      ${next ? `data-go="${next}"` : 'aria-disabled="true"'}>Next Chapter</div></div>
    <script>
      document.querySelector('.next-chap').addEventListener('mousedown', (e) => {
        const go = e.currentTarget.dataset.go;
        if (go) location.href = go;
      });
    </script>`);
}

function order(n, last) {
  const nav = n < last ? `<div class="nav"><a class="next-chap" href="/order/${n + 1}">Next Chapter</a></div>` : '';
  const wait = n % 2 ? 2500 : 0;
  return page(`Chapter ${n} - Order Book`, `
    <main><div class="chapter-content" id="content"></div></main>
    ${nav}
    <script>
      const body = ${JSON.stringify(chapterBody(n, 'Order Book'))};
      setTimeout(() => { document.getElementById('content').innerHTML = body; }, ${wait});
    </script>`);
}

function reader(n, last) {
  const next = n < last ? `<a href="/reader/${n + 1}">Next Chapter</a>` : '';
  return page(`Chapter ${n} - Reader Book`, `
    <div class="top"><a href="/reader/${Math.max(1, n - 1)}">Previous Chapter</a> ${next}</div>
    <div id="article">${chapterBody(n, 'Reader Book')}</div>
    <div class="bottom"><a href="/reader/${Math.max(1, n - 1)}">Previous Chapter</a> ${next}</div>`);
}

const limitedHits = new Map();
export function limitedStats() { return Object.fromEntries(limitedHits); }

function twice(n, last) {
  const next = n < last ? `<a href="/twice/${n + 1}">Next Chapter</a>` : '';
  const ch = n <= 3 ? n : n - 1;
  const body = chapterBody(ch, 'Twice Book') + (n === 4 ? '<p>Edited.</p>' : '');
  return page(`Chapter ${ch} - Twice Book`, `
    <div id="article">${body}</div>
    <div class="bottom">${next}</div>`);
}

function rateLimitedPage() {
  return `<!DOCTYPE html><html><head><title>Access denied | 127.0.0.1 used Cloudflare to restrict access</title></head>
<body><div id="cf-wrapper"><h1><span>Error</span> <span>1015</span></h1> <span>Ray ID: 8a1b2c3d4e5f6a7b</span>
<h2>You are being rate limited</h2><p>The owner of this website has banned you temporarily from accessing this website.</p></div></body></html>`;
}

function cookieCheckPage() {
  return `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
<body><div class="main-wrapper"><noscript><div>Enable JavaScript and cookies to continue</div></noscript>
<p>Enable JavaScript and cookies to continue</p></div></body></html>`;
}

function strict(n, last) {
  const next = n < last ? `/strict/${n + 1}` : `/strict/${n}`;
  return page(`Chapter ${n} - Strict Book`, `
    <main><div class="chapter-content">${chapterBody(n, 'Strict Book')}</div></main>
    <div class="nav"><a class="next-chap" href="${next}">Next Chapter</a></div>
    <script>
      document.querySelector('.next-chap').addEventListener('click', (e) => {
        if (!e.isTrusted) e.preventDefault();
      });
    </script>`);
}

function spa(last) {
  const bodies = Array.from({ length: last }, (_, i) => chapterBody(i + 1, 'The SPA Book'));
  return page('The SPA Book', `
    <main><div class="chapter-content" id="content"></div></main>
    <div class="nav"><button class="next-chap" type="button">Next Chapter</button></div>
    <script>
      const bodies = ${JSON.stringify(bodies)};
      let i = 0;
      const content = document.getElementById('content');
      const btn = document.querySelector('.next-chap');
      function show(k) {
        // Loads in two pieces, like a site streaming the chapter in.
        const half = bodies[k].indexOf('<div class="ad-box">');
        content.innerHTML = bodies[k].slice(0, half);
        setTimeout(() => { content.innerHTML = bodies[k]; }, 250);
        btn.disabled = k === bodies.length - 1;
      }
      setTimeout(() => show(0), 300);
      btn.addEventListener('click', () => {
        if (i >= bodies.length - 1) return;
        i++;
        content.innerHTML = '<p>Loading…</p>';
        setTimeout(() => show(i), 500);
      });
    </script>`);
}

export function serve(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let m, html = null;
    if ((m = /^\/book\/(\d+)$/.exec(url.pathname))) {
      const n = Math.min(5, Math.max(1, Number(m[1])));
      html = multiPage('/book', n, 5, { selfLoopAtEnd: true });
    } else if ((m = /^\/ending\/(\d+)$/.exec(url.pathname))) {
      html = multiPage('/ending', Math.min(3, Number(m[1])), 3, { selfLoopAtEnd: false });
    } else if (url.pathname === '/ending/end') {
      html = page('Thanks! | FakeBooks', '<main><h1>The End</h1><p>Thanks for reading! Rate this book.</p></main>');
    } else if ((m = /^\/busy\/(\d+)$/.exec(url.pathname))) {
      html = busy(Math.min(3, Math.max(1, Number(m[1]))), 3);
    } else if ((m = /^\/order\/(\d+)$/.exec(url.pathname))) {
      html = order(Math.min(8, Math.max(1, Number(m[1]))), 8);
    } else if ((m = /^\/twice\/(\d+)$/.exec(url.pathname))) {
      html = twice(Math.min(5, Math.max(1, Number(m[1]))), 5);
    } else if ((m = /^\/reader\/(\d+)$/.exec(url.pathname))) {
      html = reader(Math.min(3, Math.max(1, Number(m[1]))), 3);
    } else if ((m = /^\/limited\/(\d+)$/.exec(url.pathname))) {
      const n = Math.min(6, Math.max(1, Number(m[1])));
      const hits = (limitedHits.get(n) || 0) + 1;
      limitedHits.set(n, hits);
      if ((n === 3 || n === 5) && hits <= 2) {
        res.writeHead(429, { 'content-type': 'text/html; charset=utf-8' });
        return void res.end(rateLimitedPage());
      }
      if (n === 4 && hits <= 1) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
        return void res.end(cookieCheckPage());
      }
      html = multiPage('/limited', n, 6, { selfLoopAtEnd: true });
    } else if ((m = /^\/strict\/(\d+)$/.exec(url.pathname))) {
      html = strict(Math.min(3, Math.max(1, Number(m[1]))), 3);
    } else if (url.pathname === '/hang') {
      return;   // never answers: the tab stays "loading" for good
    } else if (url.pathname === '/spa') {
      html = spa(4);
    } else if (url.pathname === '/') {
      html = page('FakeBooks', '<ul><li><a href="/book/1">The Rain Book</a></li>' +
        '<li><a href="/ending/1">Ending page book</a></li><li><a href="/spa">The SPA Book</a></li>' +
        '<li><a href="/busy/1">Busy Book</a></li><li><a href="/strict/1">Strict Book</a></li></ul>');
    }
    if (!html) return void res.writeHead(404).end('nope');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await serve(Number(process.argv[2]) || 8765);
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`FakeBooks at ${base}\n  ${base}/book/1\n  ${base}/ending/1\n  ${base}/spa\n  ${base}/busy/1\n  ${base}/strict/1`);
}
