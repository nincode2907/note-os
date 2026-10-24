import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = relative => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const readBytes = relative => readFileSync(fileURLToPath(new URL(relative, import.meta.url)));

test('PWA manifest, browser metadata and Apple title use the install name Note OS', () => {
  const manifest = read('../../app/manifest.ts'), layout = read('../../app/layout.tsx');
  assert.match(manifest, /name:\s*'Note OS'/); assert.match(manifest, /short_name:\s*'Note OS'/);
  assert.match(layout, /applicationName:\s*'Note OS'/); assert.match(layout, /appleWebApp:\s*\{[^}]*title:\s*'Note OS'/);
  assert.match(layout, /url:\s*'\/apple-touch-icon\.png'/);
});

test('PWA asset declarations and service-worker shell cache move together without clearing local data', () => {
  const manifest = read('../../app/manifest.ts'), worker = read('../../public/sw.js'), appShell = read('../../app/ui/app-shell.tsx');
  for (const icon of ['/icons/noteos-192.png', '/icons/noteos-512.png', '/icons/noteos-maskable-512.png']) assert.ok(manifest.includes(icon));
  assert.match(worker, /const CACHE_NAME = `\$\{CACHE_PREFIX\}0002`/);
  for (const icon of ['/icons/noteos-192.png', '/icons/noteos-512.png', '/icons/noteos-maskable-512.png', '/apple-icon.png', '/apple-touch-icon.png']) assert.ok(worker.includes(`'${icon}'`));
  assert.match(worker, /names\.slice\(2\)\.map\(name => caches\.delete\(name\)\)/);
  assert.match(worker, /fetch\(request, \{ cache: 'no-store' \}\)/);
  assert.match(appShell, /serviceWorker\.register\('\/sw\.js', \{ scope: '\/', updateViaCache: 'none' \}\)/);
  assert.doesNotMatch(worker, /indexedDB\.deleteDatabase|localStorage\.clear|sessionStorage\.clear/);
});

test('icon assets are square PNGs at declared production dimensions and maskable source keeps the mark inset', () => {
  const assets = [
    ['../../public/icons/noteos-192.png', 192],
    ['../../public/icons/noteos-512.png', 512],
    ['../../public/icons/noteos-maskable-512.png', 512],
    ['../../public/apple-touch-icon.png', 180],
  ];
  for (const [relative, size] of assets) {
    const png = readBytes(relative);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
  }
  const master = readBytes('../../../../../../assets/branding/noteos-icon-master.png');
  assert.equal(master.readUInt32BE(16), 1024); assert.equal(master.readUInt32BE(20), 1024);
  const maskable = read('../../../../../../assets/branding/noteos-icon-maskable.svg');
  assert.match(maskable, /translate\(143\.36 143\.36\) scale\(\.72\)/);
  assert.match(maskable, /M22 45V19h7v4c2-3 5-5 9-5/);
});
