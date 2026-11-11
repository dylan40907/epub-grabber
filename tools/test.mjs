/*
 * End-to-end test: loads the extension into a real Chromium, drives the
 * app page the way you would - pick the text, pick the next button, Start -
 * against the fake book site in tools/serve.mjs, then builds
 * the EPUB and opens it back up to check what's inside.
 *
 *   npm i -g playwright   (once; or have it in the folder)
 *   node tools/test.mjs             headless
 *   node tools/test.mjs --headful   watch it happen
 *
 * Uses Playwright's own Chromium: branded Chrome no longer accepts
 * --load-extension.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serve, limitedStats } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.join(HERE, '..', 'extension');
const HEADFUL = process.argv.includes('--headful');

async function loadPlaywright() {
  try { return await import('playwright'); } catch (e) {}
  const globalRoot = execSync('npm root -g').toString().trim();
  return import(pathToFileURL(path.join(globalRoot, 'playwright', 'index.js')).href);
}
const pw = await loadPlaywright();
const chromium = pw.chromium || pw.default.chromium;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n          ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeout = 30000, every = 200) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  return last;
}

// ------------------------------------------------------------------ unzip --

function unzip(buf) {
  const files = {};
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const order = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString();
    const lnlen = buf.readUInt16LE(off + 26), lelen = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    files[name] = { method, text: (method === 8 ? inflateRawSync(data) : data).toString('utf8') };
    order.push(name);
    p += 46 + nlen + elen + clen;
  }
  return { files, order };
}

// ------------------------------------------------------------------- main --

const server = await serve(0);
const BASE = `http://127.0.0.1:${server.address().port}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-test-'));
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-dl-'));

const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: !HEADFUL,
  acceptDownloads: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  downloadsPath: downloads,
  args: [
    `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`,
    // Chromium 137+ ignores --load-extension unless this is switched off.
    '--disable-features=DisableLoadExtensionCommandLineSwitch'
  ],
  viewport: { width: 1100, height: 900 }
});

let failed = false;
try {
  let [worker] = ctx.serviceWorkers();
  if (!worker) worker = await ctx.waitForEvent('serviceworker');
  const extId = worker.url().split('/')[2];
  check('extension loaded', !!extId);

  const errors = [];
  worker.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const panel = await ctx.newPage();
  // Chapter tabs the extension opened and hasn't closed yet (not counting the
  // page used for picking).
  let pickPage = null;
  const strayTabs = () => ctx.pages().filter((p) => p !== pickPage && p.url().startsWith(BASE)).length;
  // No browser dialogs anywhere: confirmations use the extension's own box.
  panel.on('dialog', (d) => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
  // Start a new book; the one before stays on the list.
  async function removeAll() {
    await panel.click('#newBook');
    await until(async () => (await panel.textContent('#chapCount')).startsWith('0 chapters'), 5000);
  }
  const bookOptions = () => panel.$eval('#bookSel', (e) => [...e.options].map((o) => o.text));
  const runLog = () => worker.evaluate(() => run.log.map((l) => l.message));
  const getBook = () => worker.evaluate(() => chrome.storage.local.get('eg.book').then((g) => g['eg.book']));
  const setting = (patch) => worker.evaluate((p) => saveSettings(p), patch);
  // Paste a chapter link and press Start, the way you would. The run shows
  // on the app page itself.
  // Site configs are edited in a box of their own.
  async function openCfgs() {
    if (await panel.isHidden('#cfgDialog')) await panel.click('#editCfgs');
    await panel.waitForSelector('#cfgDialog:not([hidden])', { timeout: 3000 });
  }
  async function closeCfgs() {
    if (await panel.isVisible('#cfgDialog')) await panel.click('#cfgClose');
  }
  async function startFrom(url) {
    await panel.bringToFront();
    await closeCfgs();
    await panel.fill('#startUrl', url);
    await panel.click('#go');
    return until(async () => (await panel.textContent('#go')) === 'Stop', 5000, 50);
  }
  // Paste a chapter link and press a pick button: the extension opens the
  // link in a tab of its own to pick on.
  async function pickOn(url, slot) {
    await panel.bringToFront();
    await openCfgs();
    await panel.fill('#startUrl', url);
    await panel.click(`[data-pick="${slot}"]`);
    const page = await until(async () => ctx.pages().find((p) => p.url() === url), 10000, 50);
    if (page && page !== pickPage) page.on('pageerror', (e) => errors.push('book: ' + e.message));
    pickPage = page;
    await page.waitForSelector('[data-epubgrabber="picker"]', { state: 'attached', timeout: 10000 });
    return page;
  }
  async function runEnds(timeout = 90000) {
    return until(async () => {
      const go = await panel.textContent('#go');
      return go === 'Start capturing' && (await panel.textContent('#runText'));
    }, timeout, 200);
  }
  panel.on('pageerror', (e) => errors.push('panel: ' + e.message));
  await panel.goto(`chrome-extension://${extId}/src/app.html`);

  // --- Config 1 comes with the extension and works with just a link --------
  await until(async () => /Config 1/.test(await panel.textContent('#configSel')), 5000);
  check('no "reload" warning with an up-to-date worker', await panel.isHidden('#stale'));
  // The toolbar icon brings this page to the front rather than opening another.
  await worker.evaluate(() => openApp());
  await sleep(300);
  check('the icon reuses the app page', ctx.pages().filter((p) => /\/src\/app\.html$/.test(p.url())).length === 1);
  check('Config 1 is there out of the box', (await panel.inputValue('#configSel')) === 'config-1');
  check('Config 1 has the next chapter button', /Next Chapter/.test(await panel.textContent('#nextWhat')), await panel.textContent('#nextWhat'));
  check('Config 1 has the text area', /#article/.test(await panel.textContent('#textWhat')), await panel.textContent('#textWhat'));
  const s0 = await worker.evaluate(() => settings);
  check('stops at 5000 chapters by default', s0.maxChapters === 5000, String(s0.maxChapters));
  check('loads 2 chapters at a time', s0.parallel === 2, String(s0.parallel));
  check('no source or loading-at-once boxes', (await panel.locator('#sHost, #sLanes').count()) === 0);
  check('no activity list, timing settings, duplicates button or leave-out section',
    (await panel.locator('#log, #delay, #parallel, #dedupe, #captureOne, #tabTitle, #clearAll, #excludeBox, [data-pick="exclude"]').count()) === 0);
  check('no side panel any more', !JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'))).side_panel);

  await startFrom(`${BASE}/reader/1`);
  const firstTab = await until(async () => ctx.pages().find((p) => p.url() === `${BASE}/reader/1`), 5000, 30);
  check('Start opens the first chapter in a tab of its own', !!firstTab);
  check('...in the background: the app page stays in front', await panel.evaluate(() => document.visibilityState === 'visible'));
  const readerDone = await runEnds();
  check('the first chapter\'s tab is closed once read', !ctx.pages().some((p) => p.url() === `${BASE}/reader/1`));
  const bookR = await getBook();
  check('Config 1: all 3 chapters of a reader-style book', bookR && bookR.chapters.length === 3 &&
    bookR.chapters.every((c, i) => c.firstLine.startsWith(`Chapter ${i + 1}:`)), `${readerDone} / ${JSON.stringify(bookR && bookR.chapters.map((c) => c.firstLine))}`);
  check('Config 1: ends where the last chapter has no next button', /No next chapter button/.test(readerDone || ''), readerDone);
  check('link box now holds the last chapter read, ready to carry on', (await panel.inputValue('#startUrl')) === `${BASE}/reader/3`,
    await panel.inputValue('#startUrl'));
  await removeAll();

  // --- the page: book at the top, no grid, configs tucked away -------------
  check('book bar is at the top, no big title or chapter squares', (await panel.locator('#title, #byline, #grid, #stamp').count()) === 0 &&
    (await panel.evaluate(() => document.querySelector('main section').classList.contains('book'))));
  check('site configs are hidden until asked for', await panel.isHidden('#cfgDialog'));
  await openCfgs();
  check('Edit site configs opens them', await panel.isVisible('#renameCfg'));
  const phrases = () => worker.evaluate(() => settings.refreshPhrases);
  check('refresh text starts with the rate limit and cookie-check phrases', (await panel.locator('#phraseList li').count()) === 4 &&
    (await phrases()).includes('rate limited') && (await phrases()).includes('Enable JavaScript and cookies to continue'), JSON.stringify(await phrases()));
  await panel.fill('#phraseNew', 'Just a moment');
  await panel.press('#phraseNew', 'Enter');
  check('add refresh text', !!(await until(async () => (await phrases()).includes('Just a moment'), 3000)) &&
    !!(await until(async () => (await panel.locator('#phraseList li').count()) === 5, 3000)));
  await panel.fill('#phraseList li:nth-child(5) input', 'Checking your browser');
  await panel.press('#phraseList li:nth-child(5) input', 'Enter');
  check('edit refresh text', !!(await until(async () => (await phrases())[4] === 'Checking your browser', 3000)), JSON.stringify(await phrases()));
  await panel.click('#phraseList li:nth-child(5) [data-phrase-del]');
  check('remove refresh text', !!(await until(async () => (await phrases()).length === 4 && !(await phrases()).includes('Checking your browser'), 3000)));
  check('no "Saved books" label', !/Saved books/i.test(await panel.textContent('.book-bar')));
  await panel.keyboard.press('Escape');
  check('...Esc closes them', !!(await until(() => panel.isHidden('#cfgDialog'), 2000)));

  // --- picking needs a chapter link ------------------------------------------
  await openCfgs();
  await panel.fill('#startUrl', '');
  const tabsNoLink = ctx.pages().length;
  await panel.click('[data-pick="next"]');
  check('picking with no link says it needs one, and opens nothing',
    !!(await until(async () => /Can't select the next chapter button without a chapter link/.test(await panel.textContent('#pickHint')), 3000)) &&
    ctx.pages().length === tabsNoLink, await panel.textContent('#pickHint'));
  await panel.click('[data-pick="text"]');
  check('...same for the text area', !!(await until(async () => /Can't select the chapter text area without a chapter link/.test(await panel.textContent('#pickHint')), 3000)));

  // --- add a config for another site -----------------------------------------
  await panel.click('#addCfg');
  await panel.waitForSelector('#configName', { state: 'visible', timeout: 5000 });
  await panel.fill('#configName', 'Fake site');
  await panel.press('#configName', 'Enter');
  await until(async () => /Fake site/.test(await panel.textContent('#configSel')), 5000);
  const cfgSel = await panel.$eval('#configSel', (e) => e.options[e.selectedIndex].text);
  check('Add config: new config named and in use', cfgSel === 'Fake site', cfgSel);
  check('Add config: starts with nothing picked', /not picked yet/.test(await panel.textContent('#textWhat')) &&
    /not picked yet/.test(await panel.textContent('#nextWhat')));
  check('Start is off until the text area is picked', await panel.isDisabled('#go'));

  // --- pick the chapter text: hover a paragraph, widen with ↑, Enter -------
  await pickOn(`${BASE}/book/1`, 'text');
  check('picking opens the pasted chapter link in a tab', !!pickPage);
  const para = await pickPage.locator('.chapter-content p').first().boundingBox();
  await pickPage.mouse.move(para.x + 20, para.y + para.height / 2);
  await pickPage.mouse.move(para.x + 30, para.y + para.height / 2);
  await pickPage.keyboard.press('ArrowUp');
  await pickPage.keyboard.press('Enter');
  const textWhat = await until(async () => {
    const t = await panel.textContent('#textWhat');
    return /div\.chapter-content/.test(t) && t;
  }, 5000);
  check('↑ widens the pick from a paragraph to the chapter container', !!textWhat, await panel.textContent('#textWhat'));
  check('...and the app page comes back to the front', !!(await until(() => panel.evaluate(() => document.visibilityState === 'visible'), 3000)));

  // --- pick the next button by clicking it ---------------------------------
  const pickTabs = ctx.pages().length;
  await pickOn(`${BASE}/book/1`, 'next');
  check('...the same tab is used again', ctx.pages().length === pickTabs, `${pickTabs} -> ${ctx.pages().length}`);
  const nextBox = await pickPage.locator('.nav.bottom .next-chap').boundingBox();
  await pickPage.mouse.move(nextBox.x + 5, nextBox.y + 5);
  await pickPage.mouse.click(nextBox.x + nextBox.width / 2, nextBox.y + nextBox.height / 2);
  const nextWhat = await until(async () => {
    const t = await panel.textContent('#nextWhat');
    return /Next Chapter/.test(t) && t;
  }, 5000);
  check('next chapter button picked', !!nextWhat, await panel.textContent('#nextWhat'));
  check('picking the next button did not follow the link', pickPage.url().endsWith('/book/1'), pickPage.url());

  // --- "show" highlights go away ---------------------------------------------
  const flashCount = () => pickPage.locator('[data-epubgrabber="flash"]').count();
  await panel.click('[data-show="next"]');
  check('show draws a box on the book page', !!(await until(async () => (await flashCount()) > 0, 3000, 50)));
  await pickPage.mouse.click(5, 5);
  check('...which goes when you click on the page', !!(await until(async () => (await flashCount()) === 0, 1000, 50)));
  await panel.click('[data-show="text"]');
  await until(async () => (await flashCount()) > 0, 3000, 50);
  check('...or after a few seconds', !!(await until(async () => (await flashCount()) === 0, 4000, 100)));

  // --- configs: rename, switch, and the picks follow ------------------------
  await panel.click('#renameCfg');
  await panel.fill('#configName', 'Fake books');
  await panel.press('#configName', 'Enter');
  check('rename a config', !!(await until(async () => /Fake books/.test(await panel.textContent('#configSel')), 3000)));
  const fakeId = await panel.inputValue('#configSel');
  await panel.selectOption('#cfgEditSel', 'config-1');
  check('switching to Config 1 shows its picks', !!(await until(async () => /#article/.test(await panel.textContent('#textWhat')), 3000)));
  await panel.selectOption('#cfgEditSel', fakeId);
  check('the config list by Start follows', !!(await until(async () => (await panel.inputValue('#configSel')) === fakeId, 3000)));
  check('...and back', !!(await until(async () => /chapter-content/.test(await panel.textContent('#textWhat')), 3000)));
  const cfgs = await worker.evaluate(() => chrome.storage.local.get('eg.settings').then((g) => g['eg.settings'].configs.map((c) => c.name)));
  check('configs are saved', JSON.stringify(cfgs) === JSON.stringify(['Config 1', 'Fake books']), JSON.stringify(cfgs));

  // --- run it --------------------------------------------------------------
  const log0 = (await runLog()).length;
  // Watch the app page while it runs: the count rolls up, squares and rows arrive.
  await panel.evaluate(() => {
    window.__seen = { counts: new Set(), lanes: 0, arrivals: 0 };
    new MutationObserver(() => {
      window.__seen.counts.add(document.querySelector('#bigCount').textContent);
      window.__seen.lanes = Math.max(window.__seen.lanes, document.querySelectorAll('#lanes li').length);
      window.__seen.busy = Math.max(window.__seen.busy || 0, document.querySelectorAll('#lanes li:not(.idle)').length);
      window.__seen.arrivals = Math.max(window.__seen.arrivals, document.querySelectorAll('#chapters .chapter.arrive').length);
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  await startFrom(`${BASE}/book/1`);
  check('Start turns into Stop while capturing', (await panel.textContent('#go')) === 'Stop');
  check('the pick tab closes when the run starts', !!(await until(async () => pickPage.isClosed(), 3000)));
  pickPage = null;
  const done = await runEnds();
  check('run ends on its own', !!done, done);
  check('...because next on the last chapter links back to itself',
    /goes back to a chapter already read/.test(done || ''), done);
  check('chapters loaded in background tabs (next is a link)', (await runLog()).slice(log0).some((l) => /at once in background tabs/.test(l)));
  check('every chapter tab closed afterwards', strayTabs() === 0, String(strayTabs()));
  // The app page, during and at the end of the run.
  const seen = await panel.evaluate(() => ({ counts: [...window.__seen.counts], lanes: window.__seen.lanes,
    arrivals: window.__seen.arrivals, busy: window.__seen.busy }));
  check('while running: the count went up chapter by chapter', seen.counts.length >= 3, JSON.stringify(seen.counts));
  check('while running: chapters shown loading in the tabs', seen.busy >= 1, JSON.stringify(seen));
  check('progress shows two rows, never more', seen.lanes === 2, JSON.stringify(seen));
  check('while running: chapters slide into the list', seen.arrivals >= 1, JSON.stringify(seen));
  check('app: counted 5 chapters this run', !!(await until(async () => (await panel.textContent('#bigCount')) === '5', 3000)),
    await panel.textContent('#bigCount'));
  check('app: one row per chapter in the list', (await panel.locator('#chapters .chapter').count()) === 5);
  check('app: latest chapter on top of the pages', /5 of 5/.test(await panel.textContent('#latestNum')) &&
    /Chapter 5/.test(await panel.textContent('.page.p0 h3')), await panel.textContent('#latestNum'));
  check('app: shows the run is done, build button lit up', /Done/.test(await panel.textContent('#status')) &&
    (await panel.getAttribute('#build', 'class')).includes('ready'));
  check('app: book title', (await panel.inputValue('#bookTitle')) === 'The Rain Book', await panel.inputValue('#bookTitle'));
  if (process.env.EG_SHOTS) await panel.screenshot({ path: path.join(HERE, '..', '.shots', 'app-end.png'), fullPage: true });

  const book = await getBook();
  check('captured all 5 chapters, no repeats', book.chapters.length === 5, JSON.stringify(book.chapters.map((c) => c.firstLine)));
  check('chapters are in order', book.chapters.every((c, i) => c.firstLine.startsWith(`Chapter ${i + 1}:`)),
    JSON.stringify(book.chapters.map((c) => c.firstLine)));
  check('chapter 3 found despite the extra banner above it', book.chapters[2] && /Chapter 3/.test(book.chapters[2].firstLine));
  check('book title guessed from the page title', book.title === 'The Rain Book', book.title);

  const ch1 = await worker.evaluate((id) => chrome.storage.local.get('eg.ch.' + id).then((g) => g['eg.ch.' + id]), book.chapters[0].id);
  const html = ch1.blocks.map((b) => `<${b.tag}${b.align ? ' class=' + b.align : ''}${b.quote ? ' q' : ''}>${b.html}`).join('\n');
  check('<em> kept', /<em>Nobody<\/em>/.test(html), html);
  check('CSS-only italics become <em>', /<em>Why does it always rain,<\/em>/.test(html), html);
  check('CSS-only bold becomes <strong>', /<strong>KEEP OUT<\/strong>/.test(html), html);
  check('<i> becomes <em>', /<em>Click\.<\/em>/.test(html), html);
  check('underline kept', /<u>BANG<\/u>/.test(html), html);
  check('subscript kept', /H<sub>2<\/sub>O/.test(html), html);
  check('& < > escaped', /&amp; frowned at the &lt;door&gt;/.test(html), html);
  check('font-size:0 watermark dropped', !/Stolen from/.test(html), html);
  check('off-screen watermark dropped', !/Read the original/.test(html), html);
  check('<br><br> splits a paragraph', ch1.blocks.some((b) => b.text === 'A line in a div.') &&
    ch1.blocks.some((b) => /^A second paragraph made with two breaks\.\nStill the second paragraph\.$/.test(b.text)),
    JSON.stringify(ch1.blocks.map((b) => b.text)));
  check('single <br> kept as a line break', /two breaks\.<br\/>Still/.test(html), html);
  check('centred scene break keeps its centring', ch1.blocks.some((b) => b.align === 'center' && b.text === '* * *'));
  check('blockquote kept', ch1.blocks.some((b) => b.quote && /Remember the rain/.test(b.text)));
  check('heading kept as the first block', ch1.blocks[0].tag === 'h3', ch1.blocks[0].tag);
  check('control character stripped', !/\u000B/.test(html));

  // --- starting again where it stopped, and duplicates cleaned up ------------
  // Slip a duplicate of chapter 2 into the book, the way an old version could.
  await worker.evaluate(async () => {
    const g = await chrome.storage.local.get('eg.book');
    const b = g['eg.book'];
    b.chapters.push(Object.assign({}, b.chapters[1], { id: b.nextId++ }));
    await chrome.storage.local.set({ 'eg.book': b });
  });
  await until(async () => (await panel.textContent('#chapCount')).startsWith('6 chapters'), 3000);
  check('link box is on the last chapter after the run', (await panel.inputValue('#startUrl')) === `${BASE}/book/5`, await panel.inputValue('#startUrl'));
  await panel.bringToFront();
  await panel.click('#go');
  await until(async () => (await panel.textContent('#go')) === 'Stop', 5000, 50);
  const again = await runEnds(40000);
  await until(async () => (await panel.textContent('#chapCount')).startsWith('5 chapters'), 3000);
  const book2 = await getBook();
  check('Start from the last chapter adds nothing and stops', /goes back to a chapter already read/.test(again || '') &&
    book2.chapters.length === 5, `${again} / ${book2.chapters.length}`);
  check('duplicate chapter removed automatically', book2.chapters.length === 5 &&
    new Set(book2.chapters.map((c) => c.hash)).size === 5 && (await runLog()).some((l) => /removed 1 duplicate/.test(l)));

  // --- preview + rename -----------------------------------------------------
  await panel.click('.chapter:nth-child(2) [data-act="view"]');
  await panel.waitForSelector('#reader:not([hidden])');
  const prevHtml = await panel.innerHTML('#readerText');
  check('preview shows the chapter with formatting, minus its title line', /<em>Nobody<\/em>/.test(prevHtml) && !/Chapter 2:/.test(prevHtml));
  await panel.click('#readerClose');
  await panel.click('.page.p0');
  check('clicking the latest chapter opens it', !!(await until(async () => !(await panel.isHidden('#reader')) &&
    /Chapter 5/.test(await panel.textContent('#readerTitle')), 3000)), await panel.textContent('#readerTitle'));
  await panel.keyboard.press('Escape');
  check('...Esc closes it', !!(await until(() => panel.isHidden('#reader'), 2000)));
  await panel.fill('.chapter:nth-child(2) .ttl', 'Two: Renamed');
  await panel.press('.chapter:nth-child(2) .ttl', 'Enter');
  await panel.click('#bookAuthor');
  await panel.fill('#bookAuthor', 'A. Writer');
  await sleep(800);


  // --- the chapter list: ticks, dragging, removing, undo -----------------
  const chOrder = async () => (await getBook()).chapters.map((c) => Number(/Chapter (\d)/.exec(c.firstLine)[1]));
  const orderIs = async (want) => !!(await until(async () => JSON.stringify(await chOrder()) === JSON.stringify(want), 4000, 100));
  const row = (n) => `#chapters .chapter:nth-child(${n})`;
  const rowH = await panel.$eval(row(1), (e) => e.offsetHeight);
  // Grab a row by its number and drag it `by` rows.
  async function dragRow(n, by) {
    const box = await panel.locator(`${row(n)} .num`).boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await panel.mouse.move(x, y);
    await panel.mouse.down();
    for (let k = 1; k <= 10; k++) await panel.mouse.move(x, y + (by * rowH * k) / 10);
    await panel.mouse.up();
  }
  const undoCount = async () => ((await getBook()).undo || []).length;
  check('no up/down buttons any more', (await panel.locator('#chapters [data-act="up"], #chapters [data-act="down"]').count()) === 0);

  await panel.click(`${row(1)} .tick`);
  await panel.click(`${row(3)} .tick`, { modifiers: ['Shift'] });
  check('shift-click ticks every row in between', (await panel.locator('#chapters .chapter.selected').count()) === 3 &&
    /3 selected/.test(await panel.textContent('#listNote')));
  check('...and the trash turns to "remove selected"', (await panel.getAttribute('#trashBtn', 'class')).includes('picked'));
  await panel.keyboard.press('Escape');
  check('Esc clears the ticks', (await panel.locator('#chapters .chapter.selected').count()) === 0 &&
    !(await panel.getAttribute('#trashBtn', 'class')).includes('picked'));

  let u0 = await undoCount();
  await panel.click(`${row(1)} .tick`);
  await panel.click(`${row(3)} .tick`);
  await dragRow(1, 2);
  check('dragging rows 1 and 3 down two keeps the gap between them', await orderIs([2, 4, 1, 5, 3]), JSON.stringify(await chOrder()));
  await panel.click('#undoBtn');
  check('undo button puts them back', await orderIs([1, 2, 3, 4, 5]), JSON.stringify(await chOrder()));
  await panel.keyboard.press('Escape');

  await dragRow(5, -4);
  check('drag one row to the top', await orderIs([5, 1, 2, 3, 4]), JSON.stringify(await chOrder()));
  await panel.click('h2');
  await panel.keyboard.press('Control+z');
  check('Ctrl+Z undoes it', await orderIs([1, 2, 3, 4, 5]), JSON.stringify(await chOrder()));

  const ids0 = (await getBook()).chapters.map((c) => c.id);
  await panel.click(`${row(2)} .tick`);
  await panel.click(`${row(4)} .tick`);
  await panel.click('#trashBtn');
  check('trash with rows ticked removes just those', await orderIs([1, 3, 5]), JSON.stringify(await chOrder()));
  await panel.click('#undoBtn');
  check('...undone, with their text', await orderIs([1, 2, 3, 4, 5]) &&
    !!(await worker.evaluate((id) => chrome.storage.local.get('eg.ch.' + id).then((g) => g['eg.ch.' + id]), ids0[1])));

  await panel.click('#trashBtn');
  check('trash with nothing ticked removes every chapter', !!(await until(async () => (await getBook()).chapters.length === 0, 4000)));
  await panel.click(`${row(1)}`).catch(() => {});
  await panel.keyboard.press('Control+z');
  check('...undone', await orderIs([1, 2, 3, 4, 5]));

  await panel.click(`${row(4)} [data-act="del"]`);
  check('✕ removes one chapter', await orderIs([1, 2, 3, 5]));
  await panel.reload();
  await until(async () => (await panel.locator('#chapters .chapter').count()) === 4, 5000);
  await until(async () => !(await panel.isDisabled('#undoBtn')), 3000);
  await panel.click('#undoBtn');
  check('undo still works after the page is reloaded', await orderIs([1, 2, 3, 4, 5]));
  check('every change undone, nothing left over', (await undoCount()) === u0, `${u0} -> ${await undoCount()}`);
  const renamed = (await getBook()).chapters[1].title;
  check('rename and author survive all that', renamed === 'Two: Renamed' && (await getBook()).author === 'A. Writer', renamed);

  // --- build ---------------------------------------------------------------
  const [download] = await Promise.all([panel.waitForEvent('download'), panel.click('#build')]);
  const file = path.join(downloads, download.suggestedFilename());
  await download.saveAs(file);
  check('EPUB downloaded with the book\'s name', download.suggestedFilename() === 'The_Rain_Book.epub', download.suggestedFilename());
  const buf = fs.readFileSync(file);
  const { files, order } = unzip(buf);
  check('mimetype is the first entry, stored', order[0] === 'mimetype' && files.mimetype.method === 0 &&
    files.mimetype.text === 'application/epub+zip');
  check('chapters are compressed', files['OEBPS/chap1.xhtml'].method === 8);
  check('5 chapter files', Object.keys(files).filter((n) => /chap\d+\.xhtml$/.test(n)).length === 5);
  const x1 = files['OEBPS/chap1.xhtml'].text;
  check('chapter 1 titled from its first line', /<h1>Chapter 1: The First Door<\/h1>/.test(x1), x1.slice(0, 600));
  check('first line not repeated in the text', (x1.match(/Chapter 1: The First Door/g) || []).length === 2);
  check('formatting in the EPUB', /<em>Nobody<\/em>/.test(x1) && /<strong>KEEP OUT<\/strong>/.test(x1));
  check('renamed chapter uses the new title', /<h1>Two: Renamed<\/h1>/.test(files['OEBPS/chap2.xhtml'].text));
  check('author in the package', /<dc:creator>A\. Writer<\/dc:creator>/.test(files['OEBPS/content.opf'].text));
  check('table of contents lists every chapter', (files['OEBPS/nav.xhtml'].text.match(/<li>/g) || []).length === 5);

  // Every XHTML file must parse as XML, or Apple Books shows a blank page.
  const xmlOk = await panel.evaluate((docs) => docs.map(([n, t]) => {
    const d = new DOMParser().parseFromString(t, 'application/xhtml+xml');
    return [n, !d.querySelector('parsererror')];
  }), Object.entries(files).filter(([n]) => /\.(xhtml|opf|ncx|xml)$/.test(n)).map(([n, f]) => [n, f.text]));
  check('every XHTML/XML file is well-formed', xmlOk.every(([, ok]) => ok), JSON.stringify(xmlOk.filter(([, ok]) => !ok)));
  fs.copyFileSync(file, path.join(HERE, '..', '.test-output.epub'));

  // --- a duplicate chapter in the book: building warns first --------------
  // Chapter 3 again, one word longer, the way a site reposts a chapter.
  await worker.evaluate(async () => {
    const g = await chrome.storage.local.get('eg.book');
    const b = g['eg.book'];
    const c = b.chapters[2];
    const lib = (await chrome.storage.local.get('eg.library'))['eg.library'];
    const id = lib.nextChapterId++;
    const body = (await chrome.storage.local.get('eg.ch.' + c.id))['eg.ch.' + c.id];
    b.chapters.push(Object.assign({}, c, { id, hash: 'x' + c.hash.slice(1), words: c.words + 1 }));
    await chrome.storage.local.set({ 'eg.book': b, 'eg.library': lib, ['eg.ch.' + id]: Object.assign({}, body, { id }) });
  });
  await until(async () => (await panel.textContent('#chapCount')).startsWith('6 chapters'), 3000);
  await panel.click('#build');
  check('build warns about the duplicate, naming both chapters', !!(await until(async () => panel.isVisible('.eg-modal'), 2000, 50)) &&
    /Chapter 3 and chapter 6/.test(await panel.textContent('.eg-modal-msg')), await panel.textContent('.eg-modal-msg').catch(() => ''));
  await panel.keyboard.press('Escape');
  await sleep(300);
  check('...Esc builds nothing and changes nothing', (await getBook()).chapters.length === 6);
  await panel.click('#build');
  await panel.waitForSelector('.eg-modal');
  const [dl2] = await Promise.all([panel.waitForEvent('download'), panel.click('.eg-modal-ok')]);
  const file2 = path.join(downloads, 'dedup-' + dl2.suggestedFilename());
  await dl2.saveAs(file2);
  check('"remove and build": the repeat is gone and the EPUB has 5 chapters',
    (await getBook()).chapters.length === 5 && Object.keys(unzip(fs.readFileSync(file2)).files).filter((n) => /chap\d+\.xhtml$/.test(n)).length === 5);

  // --- more than one book: start a new one, come back, delete --------------
  const rainId = await panel.inputValue('#bookSel');
  const rainIds = (await getBook()).chapters.map((c) => c.id);
  await removeAll();
  const opts1 = await bookOptions();
  check('New book: empty, and the last one is kept on the list', opts1[0] === 'Untitled book · 0 ch' &&
    opts1.includes('The Rain Book · 5 ch') && opts1.includes('Reader Book · 3 ch'), JSON.stringify(opts1));
  check('New book: link box starts empty', !!(await until(async () => (await panel.inputValue('#startUrl')) === '', 3000)), await panel.inputValue('#startUrl'));
  const emptyId = await panel.inputValue('#bookSel');
  await panel.selectOption('#bookSel', rainId);
  await until(async () => (await panel.textContent('#chapCount')).startsWith('5 chapters'), 5000);
  const back = await getBook();
  check('switching back brings the whole book back', back.title === 'The Rain Book' && back.author === 'A. Writer' &&
    back.chapters[1].title === 'Two: Renamed' && back.chapters.length === 5, JSON.stringify([back.title, back.author, back.chapters.length]));
  check('...with its chapter text', !!(await worker.evaluate((id) => chrome.storage.local.get('eg.ch.' + id).then((g) => g['eg.ch.' + id]), rainIds[0])));
  check('...and its link box on its last chapter', !!(await until(async () => (await panel.inputValue('#startUrl')) === `${BASE}/book/5`, 3000)),
    await panel.inputValue('#startUrl'));
  await panel.click('#delBook');
  check('Delete book asks first, in the extension\'s own box', !!(await until(async () => panel.isVisible('.eg-modal'), 2000, 50)) &&
    /The Rain Book/.test(await panel.textContent('.eg-modal-msg')));
  await panel.keyboard.press('Escape');
  await sleep(400);
  check('...Esc cancels and keeps the book', (await panel.locator('.eg-modal').count()) === 0 &&
    (await getBook()).chapters.length === 5);
  await panel.click('#delBook');
  await panel.click('.eg-modal-ok');
  await until(async () => !(await bookOptions()).some((o) => /Rain Book/.test(o)), 5000);
  const opts2 = await bookOptions();
  check('Delete book: gone from the list, on to the last book worked on', !opts2.some((o) => /Rain Book/.test(o)) &&
    (await panel.inputValue('#bookSel')) === emptyId, JSON.stringify(opts2));
  const leftover = await worker.evaluate((ids) => chrome.storage.local.get(ids.map((i) => 'eg.ch.' + i)).then((g) => Object.keys(g).length), rainIds);
  check('Delete book: its chapters are removed from storage', leftover === 0, String(leftover));

  // --- a book that ends on a "thanks for reading" page -----------------------
  await removeAll();
  await startFrom(`${BASE}/ending/1`);
  const ended = await until(async () => {
    const go = await panel.textContent('#go');
    return go === 'Start capturing' && /no chapter text/.test(await panel.textContent('#runText')) &&
      (await panel.textContent('#runText'));
  }, 60000, 300);
  const book3 = await worker.evaluate(() => chrome.storage.local.get('eg.book').then((g) => g['eg.book']));
  check('stops at a page with no chapter on it', !!ended && book3.chapters.length === 3,
    `${await panel.textContent('#runText')} / ${book3 && book3.chapters.length}`);

  // --- a single-page app: next swaps the text in place ----------------------
  await removeAll();
  await startFrom(`${BASE}/spa`);
  const spaDone = await until(async () => {
    const go = await panel.textContent('#go');
    return go === 'Start capturing' && /disabled/.test(await panel.textContent('#runText')) &&
      (await panel.textContent('#runText'));
  }, 60000, 300);
  const book4 = await worker.evaluate(() => chrome.storage.local.get('eg.book').then((g) => g['eg.book']));
  check('in-place chapters: all 4, ends on the disabled next button', !!spaDone && book4.chapters.length === 4,
    `${await panel.textContent('#runText')} / ${JSON.stringify(book4 && book4.chapters.map((c) => [c.firstLine, c.words]))}`);
  check('in-place chapters waited for the whole chapter to load',
    book4.chapters.every((c) => c.words === book4.chapters[0].words || Math.abs(c.words - book4.chapters[0].words) < 3),
    JSON.stringify(book4.chapters.map((c) => c.words)));

  // --- a busy site: never finishes loading, Next only reacts to mousedown ----
  await removeAll();
  await pickOn(`${BASE}/busy/1`, 'next');
  await pickPage.locator('.next-chap').scrollIntoViewIfNeeded();
  const busyNext = await pickPage.locator('.next-chap').boundingBox();
  await pickPage.mouse.move(busyNext.x + 5, busyNext.y + 5);
  await pickPage.mouse.click(busyNext.x + busyNext.width / 2, busyNext.y + busyNext.height / 2);
  await until(async () => /div\.next-chap/.test(await panel.textContent('#nextWhat')), 5000);
  check('picking a mousedown-only button doesn\'t set it off', pickPage.url().endsWith('/busy/1'), pickPage.url());
  const log6 = (await runLog()).length;
  await startFrom(`${BASE}/busy/1`);
  const busyDone = await until(async () => {
    const go = await panel.textContent('#go');
    return go === 'Start capturing' && (await panel.textContent('#runText'));
  }, 60000, 300);
  const book6 = await worker.evaluate(() => chrome.storage.local.get('eg.book').then((g) => g['eg.book']));
  check('busy site: all 3 chapters, though the tab never finishes loading', book6 && book6.chapters.length === 3,
    `${busyDone} / ${book6 && book6.chapters.length}`);
  check('busy site: ends on the disabled next button', /disabled/.test(busyDone || ''), busyDone);
  const busyLog = (await runLog()).slice(log6).join('\n');
  check('busy site: next isn\'t a link, so it clicks where the button is', /clicking it, one chapter at a time/.test(busyLog), busyLog.slice(0, 400));

  // --- a site that cancels scripted clicks: links are opened, never clicked ----
  await removeAll();
  const log7 = (await runLog()).length;
  await startFrom(`${BASE}/strict/1`);
  const strictDone = await until(async () => {
    const go = await panel.textContent('#go');
    return go === 'Start capturing' && (await panel.textContent('#runText'));
  }, 90000, 300);
  const book7 = await worker.evaluate(() => chrome.storage.local.get('eg.book').then((g) => g['eg.book']));
  const strictLog = (await runLog()).slice(log7).join('\n');
  check('chapter ids stay unique across books', book7 && book7.chapters.every((c) => !rainIds.includes(c.id)));
  check('click-proof site: all 3 chapters, by opening the link\'s address', book7 && book7.chapters.length === 3,
    `${strictDone} / ${book7 && book7.chapters.length}`);
  check('click-proof site: used background tabs', /at once in background tabs/.test(strictLog), strictLog.slice(0, 300));

  // --- chapters that finish loading out of order ---------------------------
  await removeAll();
  await startFrom(`${BASE}/order/1`);
  let maxTabs = 0;
  const orderDone = await until(async () => {
    maxTabs = Math.max(maxTabs, strayTabs());
    const go = await panel.textContent('#go');
    return go === 'Start capturing' && (await panel.textContent('#runText'));
  }, 90000, 100);
  const book8 = await worker.evaluate(() => chrome.storage.local.get('eg.book').then((g) => g['eg.book']));
  const firsts = (book8 ? book8.chapters : []).map((c) => c.firstLine);
  check('out-of-order loads: all 8 chapters', firsts.length === 8, `${orderDone} / ${JSON.stringify(firsts)}`);
  check('out-of-order loads: still in order in the book', firsts.every((f, i) => f.startsWith(`Chapter ${i + 1}:`)), JSON.stringify(firsts));
  check('out-of-order loads: two chapter tabs open at once', maxTabs === 2, String(maxTabs));
  check('out-of-order loads: ends where the last page has no next button', /No next chapter button on the last page/.test(orderDone || ''), orderDone);
  check('out-of-order loads: no chapter tabs left open', strayTabs() === 0, String(strayTabs()));

  // --- a site that rate limits ----------------------------------------------
  await removeAll();
  await setting({ rateWait: 1 });
  await startFrom(`${BASE}/limited/1`);
  const limitedDone = await until(async () => {
    const go = await panel.textContent('#go');
    return go === 'Start capturing' && (await panel.textContent('#runText'));
  }, 90000, 200);
  const book9 = await worker.evaluate(() => chrome.storage.local.get('eg.book').then((g) => g['eg.book']));
  const firsts9 = (book9 ? book9.chapters : []).map((c) => c.firstLine);
  const hits = limitedStats();
  check('rate limited: the site really did rate limit chapter 3', hits[3] >= 1, JSON.stringify(hits));
  check('rate limited: no retries', !(hits[3] > 1), JSON.stringify(hits));
  check('rate limited: kept chapters 1 and 2, in order',
    firsts9.length === 2 && firsts9.every((f, i) => f.startsWith(`Chapter ${i + 1}:`)), `${limitedDone} / ${JSON.stringify(firsts9)}`);
  check('rate limited: no error page captured as a chapter', !(book9 ? book9.chapters : []).some((c) => /1015|rate limited/i.test(c.firstLine)));
  check('rate limited: stops and says why', /rate limiting or showing a browser check/.test(limitedDone || ''), limitedDone);
  check('rate limited: no chapter tabs left open', strayTabs() === 0, String(strayTabs()));

  // --- Stop ------------------------------------------------------------------
  await removeAll();
  await setting({ delay: 3 });
  await startFrom(`${BASE}/book/1`);
  // With a 3s gap, stop while the second chapter's tab is open.
  await until(async () => (await getBook()).chapters.length >= 1 && strayTabs() > 0, 15000, 50);
  await panel.click('#go');
  const stopped = await until(async () => (await panel.textContent('#go')) === 'Start capturing', 5000, 100);
  check('Stop just stops: Start is back, nothing announced', !!stopped && (await panel.isEnabled('#go')) &&
    (await panel.isHidden('#stamp')) && !/Stopped/.test(await panel.textContent('body')),
    `${await panel.textContent('#runText')} / ${await panel.textContent('#status')}`);
  await sleep(300);
  check('Stop closes the chapter tabs', strayTabs() === 0, String(strayTabs()));
  const book5 = await worker.evaluate(() => chrome.storage.local.get('eg.book').then((g) => g['eg.book']));
  if (process.env.EG_DEBUG) console.log((await runLog()).join('\n'));
  check('Stop stops it mid-run', !!stopped && book5.chapters.length >= 1 && book5.chapters.length < 5, `${book5 && book5.chapters.length}`);
  const nRead = book5.chapters.length;
  check('after Stop, the link box is on the next chapter to read', !!(await until(async () =>
    (await panel.inputValue('#startUrl')) === `${BASE}/book/${nRead + 1}`, 3000)), `${nRead} read / ${await panel.inputValue('#startUrl')}`);
  await setting({ delay: 0.5 });
  await panel.click('#go');
  await until(async () => (await panel.textContent('#go')) === 'Stop', 5000, 50);
  const carried = await runEnds();
  const book5b = await getBook();
  check('...and Start carries on with no chapter twice', book5b.chapters.length === 5 &&
    book5b.chapters.every((c, i) => c.firstLine.startsWith(`Chapter ${i + 1}:`)), `${carried} / ${JSON.stringify(book5b.chapters.map((c) => c.firstLine))}`);

  // --- a site that posts a chapter twice in a row ---------------------------
  await removeAll();
  await openCfgs();
  await panel.selectOption('#cfgEditSel', 'config-1');
  await closeCfgs();
  await startFrom(`${BASE}/twice/1`);
  const twiceDone = await runEnds();
  const book10 = await getBook();
  check('a chapter posted twice (one word different) goes in once', book10.chapters.length === 4 &&
    book10.chapters.every((c, i) => c.firstLine.startsWith(`Chapter ${i + 1}:`)), `${twiceDone} / ${JSON.stringify(book10.chapters.map((c) => c.firstLine))}`);

  check('no errors in the extension', errors.length === 0, errors.join('\n'));
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await ctx.close();
  server.closeAllConnections();
  server.close();
}

const bad = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad || failed ? 1 : 0);
