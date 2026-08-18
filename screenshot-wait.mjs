import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(root, 'temporary screenshots');
fs.mkdirSync(outDir, { recursive: true });

const url = process.argv[2];
const label = process.argv[3] || '';
const width = Number(process.argv[4]) || 1440;
const height = Number(process.argv[5]) || 8500;
const waitMs = Number(process.argv[6]) || 4000;
const maxCapHeight = Number(process.argv[7]) || 16000;

if (!url) {
  console.error('Usage: node screenshot-wait.mjs <url> [label] [width] [height] [waitMs]');
  process.exit(1);
}

const candidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const browser = candidates.find((p) => fs.existsSync(p));
if (!browser) { console.error('Chrome not found.'); process.exit(1); }

const port = 9222 + Math.floor(Math.random() * 500);
const userDataDir = path.join(root, '.chrome-profile-' + port);

const proc = spawn(browser, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  `--window-size=${width},${Math.min(height, 1400)}`,
  'about:blank',
], { stdio: 'ignore' });

async function waitForEndpoint() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('DevTools endpoint never became available');
}

function send(ws, id, method, params = {}) {
  ws.send(JSON.stringify({ id, method, params }));
}

async function main() {
  console.log('waiting for devtools endpoint...');
  await waitForEndpoint();
  console.log('endpoint ready, creating target...');
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  const target = await res.json();
  console.log('target created, connecting ws...');
  const ws = new WebSocket(target.webSocketDebuggerUrl);

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  console.log('ws connected');

  let msgId = 1;
  const pending = new Map();
  const waiters = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    }
    if (msg.method) {
      for (const w of waiters) w(msg);
    }
  });

  function call(method, params = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP call timed out: ${method}`));
      }, timeoutMs);
      pending.set(id, (result) => { clearTimeout(timer); resolve(result); });
      send(ws, id, method, params);
    });
  }

  async function callWithRetry(method, params, timeoutMs, retries = 2) {
    for (let i = 0; i <= retries; i++) {
      try { return await call(method, params, timeoutMs); }
      catch (err) {
        console.log(`  ${method} attempt ${i + 1} failed: ${err.message}`);
        if (i === retries) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  function waitFor(eventMethod, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const idx = waiters.push((msg) => {
        if (!done && msg.method === eventMethod) { done = true; resolve(msg); }
      }) - 1;
      setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs);
    });
  }

  await call('Page.enable');
  await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride', { width, height: 1200, deviceScaleFactor: 1, mobile: width < 700 });
  console.log('navigating...');
  const navPromise = waitFor('Page.loadEventFired', 20000);
  await call('Page.navigate', { url });
  await navPromise;
  console.log('load fired (or timed out), waiting extra', waitMs, 'ms...');

  await new Promise((r) => setTimeout(r, waitMs));

  console.log('measuring page...');
  const metrics = await call('Page.getLayoutMetrics');
  const contentSize = metrics.cssContentSize || metrics.contentSize;
  const fullHeight = Math.min(contentSize.height, maxCapHeight);
  console.log('content size', contentSize, '-> expanding viewport to full height for lazy images');

  await call('Emulation.setDeviceMetricsOverride', { width, height: fullHeight, deviceScaleFactor: 1, mobile: width < 700 });
  await new Promise((r) => setTimeout(r, 1200));

  console.log('capturing screenshot in tiles (single huge captures hang headless Chrome)...');
  const sliceHeight = 1000;
  const tmpDir = path.join(outDir, '.tiles-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  const tileFiles = [];
  for (let y = 0; y < fullHeight; y += sliceHeight) {
    const h = Math.min(sliceHeight, fullHeight - y);
    const { data } = await callWithRetry('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y, width: contentSize.width, height: h, scale: 1 },
    }, 6000, 3);
    const tf = path.join(tmpDir, `tile-${String(y).padStart(6, '0')}.png`);
    fs.writeFileSync(tf, Buffer.from(data, 'base64'));
    tileFiles.push(tf);
    console.log(`  tile y=${y} h=${h} ok`);
    await new Promise((r) => setTimeout(r, 150));
  }

  let n = 1;
  while (fs.existsSync(path.join(outDir, `screenshot-${n}-${label || 'wait'}.png`))) n++;
  const outPath = path.join(outDir, `screenshot-${n}-${label || 'wait'}.png`);

  const py = `
import sys
from PIL import Image
files = sys.argv[1:-1]
out = sys.argv[-1]
imgs = [Image.open(f) for f in files]
w = imgs[0].width
h = sum(im.height for im in imgs)
canvas = Image.new('RGB', (w, h), (255,255,255))
y = 0
for im in imgs:
    canvas.paste(im, (0, y))
    y += im.height
canvas.save(out)
`;
  const pyFile = path.join(tmpDir, 'stitch.py');
  fs.writeFileSync(pyFile, py);
  execFileSync('python', [pyFile, ...tileFiles, outPath], { stdio: 'inherit' });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('Saved', outPath);

  ws.close();
  proc.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
}

const hardTimeout = setTimeout(() => {
  console.error('HARD TIMEOUT — killing and exiting');
  try { proc.kill(); } catch {}
  process.exit(1);
}, 120000);
hardTimeout.unref?.();

main()
  .then(() => clearTimeout(hardTimeout))
  .catch((err) => { console.error(err); try { proc.kill(); } catch {}; process.exit(1); });
