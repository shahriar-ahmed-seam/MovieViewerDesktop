/**
 * End-to-end subtitle check against the real media server, using the built app (dist/).
 *
 *   npm run build
 *   E2E_CASE='{"name":"x","dirUrl":"http://.../","file":"Name.mkv","seekSec":120}' \
 *     node_modules/.bin/electron --no-sandbox scripts/e2e-subtitles.js
 *
 * Launches the app with a throw-away profile whose server URL is the video's folder, clicks
 * the video, mutes it, seeks, waits until subtitles are on screen, and saves a screenshot.
 * Prints one JSON result line prefixed with "E2E_RESULT ".
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const testCase = JSON.parse(process.env.E2E_CASE || '{}');
const outDir = process.env.E2E_OUT || path.join(os.tmpdir(), 'mv-e2e-shots');
fs.mkdirSync(outDir, { recursive: true });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-e2e-profile-'));
app.setPath('userData', profile);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
  serverUrl: testCase.dirUrl,
  preferredSubtitleLanguage: testCase.lang || 'eng',
  subtitlesEnabledByDefault: !testCase.noSubs,
  developerDiagnostics: false
}));

const result = { name: testCase.name, ok: false, steps: [] };
const t0 = Date.now();
const step = (s) => result.steps.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);

function finish(code) {
  console.log('E2E_RESULT ' + JSON.stringify(result));
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  app.exit(code);
}

setTimeout(() => {
  result.error = result.error || 'overall timeout';
  finish(1);
}, (testCase.timeoutSec || 150) * 1000);

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', () => run(win).catch((err) => {
    result.error = String(err && err.message || err);
    finish(1);
  }));
});

require(path.join(__dirname, '../dist/main/index.js'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(win, js, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await win.webContents.executeJavaScript(js).catch(() => null);
    if (v) return v;
    await sleep(250);
  }
  const state = await win.webContents.executeJavaScript(`(() => {
    const v = document.querySelector('video');
    if (!v) return null;
    const b = []; for (let i = 0; i < v.buffered.length; i++) b.push([v.buffered.start(i).toFixed(1), v.buffered.end(i).toFixed(1)]);
    return { t: v.currentTime, rs: v.readyState, ns: v.networkState, seeking: v.seeking, paused: v.paused, err: v.error && v.error.code, buffered: b,
      status: [...document.querySelectorAll('button')].map(x => x.textContent.trim()).find(x => /^Sub:|^Tracks/.test(x)) };
  })()`).catch(() => null);
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(state)}`);
}

async function run(win) {
  win.setSize(1280, 800);
  step('app loaded');
  const fileJs = JSON.stringify(testCase.file);
  await waitFor(win, `[...document.querySelectorAll('[title]')].some(e => e.getAttribute('title') === ${fileJs})`, 30000, 'directory listing');
  step('directory listed');
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('[title]')].find(e => e.getAttribute('title') === ${fileJs}).click(); true`);
  await waitFor(win, `!!document.querySelector('video')`, 10000, 'player');
  step('player opened');
  await win.webContents.executeJavaScript(`(() => { const v = document.querySelector('video'); v.muted = true; v.volume = 0; return true; })()`);
  await waitFor(win, `document.querySelector('video').readyState >= 1`, 60000, 'video metadata');
  step('video metadata loaded');

  const seek = testCase.seekSec || 0;
  if (seek > 0) {
    await waitFor(win, `document.querySelector('video').readyState >= 2`, 60000, 'first frame');
    await win.webContents.executeJavaScript(`(() => { const v = document.querySelector('video'); v.currentTime = ${seek}; v.play().catch(() => {}); return true; })()`);
    await waitFor(win, `(() => { const v = document.querySelector('video'); return !v.seeking && v.readyState >= 2; })()`, 90000, 'seek completion');
    result.seekLanded = await win.webContents.executeJavaScript(`document.querySelector('video').currentTime`);
    step(`seeked to ${seek}s (landed ${Number(result.seekLanded).toFixed(2)}s)`);
  }

  // Wait until a subtitle is actually drawn: text lane with content, or non-transparent canvas pixels
  const probe = `(() => {
    const lane = document.querySelector('.subtitle-overlay [data-subtitle-lane] span');
    if (lane && lane.textContent.trim()) return { kind: 'text', text: lane.textContent.trim(), t: document.querySelector('video').currentTime };
    const c = document.querySelector('.subtitle-overlay canvas');
    if (c && c.width > 0) {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 16) if (d[i] > 0) n++;
      if (n > 50) return { kind: 'bitmap', pixels: n, t: document.querySelector('video').currentTime };
    }
    return null;
  })()`;
  const seen = await waitFor(win, probe, (testCase.waitSubSec || 90) * 1000, 'subtitle on screen');
  result.firstSubtitle = seen;
  step(`subtitle visible (${seen.kind})`);
  const firstImg = await win.webContents.capturePage();
  const firstFile = path.join(outDir, `${testCase.name.replace(/[^a-z0-9]+/gi, '_')}_first.png`);
  fs.writeFileSync(firstFile, firstImg.toPNG());
  result.screenshotFirst = firstFile;

  // Let the controls auto-hide, then capture
  await win.webContents.executeJavaScript(`document.querySelector('video').play().catch(()=>{}); true`);
  await sleep(1500);
  await waitFor(win, probe, 20000, 'subtitle after controls hide').then(v => { result.shotSubtitle = v; }).catch(() => {});
  const img = await win.webContents.capturePage();
  const file = path.join(outDir, `${testCase.name.replace(/[^a-z0-9]+/gi, '_')}.png`);
  fs.writeFileSync(file, img.toPNG());
  result.screenshot = file;

  const modalInfo = await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /Sub:|Tracks/.test(b.textContent || ''));
    return btn ? btn.textContent.trim() : null;
  })()`);
  result.subButton = modalInfo;

  if (testCase.switchAudio) {
    // Open the track modal, switch to the second audio track (remux), and confirm subtitles continue
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b => /Sub:|Tracks/.test(b.textContent||'')).click(); true`);
    await sleep(500);
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b => /^Audio/.test((b.textContent||'').trim())).click(); true`);
    await sleep(400);
    const switched = await win.webContents.executeJavaScript(`(() => {
      const rows = [...document.querySelectorAll('div')].filter(d => d.textContent && /^#\\d+/.test(d.textContent.trim()) && d.style && d.style.cursor);
      const target = rows[1];
      if (!target) return false;
      target.click();
      return target.textContent.trim().slice(0, 60);
    })()`);
    step(`audio switch clicked: ${switched}`);
    // Close the modal (a single Escape; a second one would navigate back to the browser)
    await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`);
    await waitFor(win, `(() => { const v = document.querySelector('video'); return v && v.src.includes('/remux?') && v.readyState >= 2 && !v.paused; })()`, 60000, 'remuxed playback');
    step('remuxed playback running');
    await win.webContents.executeJavaScript(`document.querySelector('video').muted = true; true`);
    const after = await waitFor(win, probe, 60000, 'subtitle after audio switch');
    result.afterAudioSwitch = after;
    step('subtitle visible after audio switch');
    await sleep(1500);
    const img2 = await win.webContents.capturePage();
    const file2 = path.join(outDir, `${testCase.name.replace(/[^a-z0-9]+/gi, '_')}_remux.png`);
    fs.writeFileSync(file2, img2.toPNG());
    result.screenshotRemux = file2;
  }

  result.ok = true;
  finish(0);
}
