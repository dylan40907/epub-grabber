# EPUB Grabber

A personal Chromium browser extension that builds an EPUB from a book published as one web page per chapter. You point it at the first chapter, pick the element that holds the chapter text and the button that goes to the next chapter, and it walks the chapters in order and packages them into an EPUB for an e-reader.

It reads only what the browser already shows you. It does not log in, remove paywalls, or touch DRM. You are responsible for respecting each site's terms of service and the author's copyright; use it for content you are allowed to keep a copy of.

## How it works

- **Configs.** A config describes one site's layout: a selector for the chapter text, one for the next button, and optional elements to exclude. You make one by clicking the elements on a chapter page; the picker highlights on hover, and the arrow keys widen or narrow the pick. Each pick stores a few fallback selectors (id, class, XPath) so small layout differences between chapters do not break it.
- **The run.** The service worker opens the start chapter in a background tab, waits for the text, captures it and closes the tab. When "next" is a link, it reads the next address from each page and loads up to two chapters at once; when it is a button, it clicks it and waits. Chapters are always added in order.
- **Stopping.** The run ends when the next button is missing or disabled, a link points back to a chapter already read, the next page has no chapter text, the same chapter appears twice, or you press Stop. Near-duplicate chapters are flagged before building.
- **Capture.** Chapter HTML is converted to clean XHTML, keeping paragraphs and inline formatting.
- **Building.** `epub.js` writes an EPUB 3 package (with an EPUB 2 table of contents for older readers) using a small built-in ZIP writer and the browser's `CompressionStream`.
- **Storage.** Books and chapters live in `chrome.storage.local`, so a run can be stopped and resumed later, and several books can be kept at once.

## Install

1. Open `chrome://extensions` (or the equivalent in another Chromium browser).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.
4. Click the toolbar icon to open the app page.

There is no build step and no runtime dependency.

## Usage

1. Choose a config, or create one from a chapter page with the pickers.
2. Paste the link to the first chapter you want and press **Start capturing**.
3. When it reaches the end, set the title and author, choose how chapters are titled, and press **Build & download EPUB**.

## Tests

`tools/test.mjs` loads the extension into Playwright's Chromium and runs it end to end against a local fake book site, then opens the built EPUB and checks its contents.

```bash
npm install playwright
npx playwright install chromium
node tools/test.mjs
```

`node tools/serve.mjs` starts the fake site on its own for manual testing. It covers per-page chapters, a single-page reader that swaps chapters in place, slow and out-of-order pages, a next control that only reacts to mouse events, rate-limit pages (which stop the run) and duplicated chapters.

## Files

```
extension/manifest.json   Manifest V3
extension/src/app.*       the app page (books, configs, run progress, build)
extension/src/background.js  service worker: runs the capture
extension/src/content.js  pickers and per-page capture
extension/src/capture.js  chapter element to XHTML
extension/src/shared.js   settings, configs, selector engine
extension/src/epub.js     EPUB writer
extension/src/bookio.js   chapter titles and download
extension/src/ui.*        in-page confirm dialog
tools/                    end-to-end test, fake book site, icon generator
```

## Third-party software

The extension has no third-party runtime code. The test uses [Playwright](https://playwright.dev) (Apache-2.0).
