import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(root, 'temporary screenshots');
fs.mkdirSync(outDir, { recursive: true });

const url = process.argv[2];
const label = process.argv[3] || '';
const width = Number(process.argv[4]) || 1440;
const height = Number(process.argv[5]) || 7000;
const virtualTimeBudget = Number(process.argv[6]) || 0;

if (!url) {
  console.error('Usage: node screenshot.mjs <url> [label] [width] [height]');
  process.exit(1);
}

const candidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const browser = candidates.find((p) => fs.existsSync(p));
if (!browser) {
  console.error('No Chrome/Edge install found in expected locations.');
  process.exit(1);
}

let n = 1;
while (fs.existsSync(path.join(outDir, `screenshot-${n}${label ? '' : ''}.png`)) ||
       fs.existsSync(path.join(outDir, `screenshot-${n}-${label}.png`))) {
  n++;
}
const filename = label ? `screenshot-${n}-${label}.png` : `screenshot-${n}.png`;
const outPath = path.join(outDir, filename);

execFileSync(browser, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  `--window-size=${width},${height}`,
  `--screenshot=${outPath}`,
  ...(virtualTimeBudget ? [`--virtual-time-budget=${virtualTimeBudget}`] : []),
  url,
], { stdio: 'inherit' });

console.log(`Saved ${outPath}`);
