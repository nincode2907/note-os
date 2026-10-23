import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpsRequest } from 'node:https';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [process.env.NOTEOS_PLAYWRIGHT_ROOT ?? `${root}/../ui-lens`] }));
const evidenceDir = process.env.NOTEOS_SYNC_EVIDENCE ?? `${root}/artifacts/review/noteOS-Phase08.1-H-Host-Isolation-review/evidence`;
const container = process.env.NOTEOS_PHASE081H_CONTAINER ?? 'noteos-phase081h-isolated-test-web-1';
const hosts = ['noteos.synthetic.test', 'memoryos.synthetic.test'];
const upstreamHost = process.env.NOTEOS_PHASE081H_UPSTREAM_HOST ?? '127.0.0.1';
const upstreamPort = Number(process.env.NOTEOS_PHASE081H_UPSTREAM_PORT ?? 15730);
const tmp = await mkdtemp(join(tmpdir(), 'noteos-081h-https-'));
await mkdir(evidenceDir, { recursive: true });
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(tmp, 'key.pem'), '-out', join(tmp, 'cert.pem'), '-days', '1', '-subj', '/CN=noteos.synthetic.test', '-addext', 'subjectAltName=DNS:noteos.synthetic.test,DNS:memoryos.synthetic.test'], { stdio: 'ignore' });
const key = await readFile(join(tmp, 'key.pem'));
const cert = await readFile(join(tmp, 'cert.pem'));
const forwarded = [];
const proxy = createServer({ key, cert }, (req, res) => {
  const entry = { host: req.headers.host, path: req.url, cookiePresent: Boolean(req.headers.cookie), setCookiePresent: false, setCookieAttributes: null };
  forwarded.push(entry);
  const upstream = http.request({ hostname: upstreamHost, port: upstreamPort, path: req.url, method: req.method, headers: req.headers }, response => {
    const setCookie = response.headers['set-cookie'];
    if (setCookie) {
      const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      entry.setCookiePresent = true;
      entry.setCookieAttributes = cookie.split(';').slice(1).map(value => value.trim());
    }
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(upstream);
});

const fixture = async action => {
  if (action === 'pair' && process.env.NOTEOS_PHASE081H_PAIRING_CODE) return process.env.NOTEOS_PHASE081H_PAIRING_CODE;
  return (await exec('docker', ['exec', container, 'node', '/verification/fixture.mjs', action])).stdout.trim();
};
const getJson = (page, path) => page.evaluate(async url => {
  const response = await fetch(url, { credentials: 'same-origin' });
  const text = await response.text();
  try { return { status: response.status, body: JSON.parse(text), url: response.url }; }
  catch { return { status: response.status, bodyText: text.slice(0, 240), url: response.url }; }
}, path);
const postJson = (page, path, body) => page.evaluate(async ({ url, payload }) => {
  const response = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'X-NoteOS-Sync': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const text = await response.text();
  try { return { status: response.status, body: JSON.parse(text) }; }
  catch { return { status: response.status, bodyText: text.slice(0, 240) }; }
}, { url: path, payload: body });
const rawPost = ({ host, origin, cookie, path, crossSite = false, body = {} }) => new Promise((resolve, reject) => {
  const request = httpsRequest({ hostname: '127.0.0.1', port: 15731, path, method: 'POST', rejectUnauthorized: false, headers: { host, origin, cookie, 'X-NoteOS-Sync': '1', 'Content-Type': 'application/json', ...(crossSite ? { 'Sec-Fetch-Site': 'cross-site' } : {}) } }, response => {
    let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
  });
  request.on('error', reject); request.end(JSON.stringify(body));
});
const results = [];
try {
  await new Promise(resolve => proxy.listen(15731, process.env.NOTEOS_PHASE081H_BIND ?? '127.0.0.1', resolve));
  const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${hosts[0]} 127.0.0.1,MAP ${hosts[1]} 127.0.0.1`] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await page.goto(`https://${hosts[0]}:15731/`);
    const code = await fixture('pair');
    const paired = await postJson(page, '/api/v1/sync/pair', { code, label: 'Synthetic hostname isolation' });
    assert.equal(paired.status, 200, JSON.stringify(paired));
    assert.equal(JSON.stringify(paired.body).includes('token'), false);
    const cookieAttributes = forwarded.find(row => row.path === '/api/v1/sync/pair')?.setCookieAttributes ?? [];
    assert.ok(cookieAttributes.some(value => value.toLowerCase() === 'httponly'));
    assert.ok(cookieAttributes.some(value => value.toLowerCase() === 'secure'));
    assert.ok(cookieAttributes.some(value => value.toLowerCase() === 'samesite=strict'));
    assert.ok(cookieAttributes.some(value => value.toLowerCase() === 'path=/api/v1/sync'));
    assert.equal(cookieAttributes.some(value => value.toLowerCase().startsWith('domain=')), false);
    const session = (await context.cookies()).find(cookie => cookie.name === '__Secure-noteos_sync');
    assert.ok(session?.secure && session?.httpOnly && session?.sameSite === 'Strict');
    assert.equal(session.domain, hosts[0]);

    const allowed = await getJson(page, '/api/v1/sync/status');
    assert.equal(allowed.status, 200);
    assert.equal(new URL(allowed.url).search, '');
    const memoryPage = await context.newPage();
    await memoryPage.goto(`https://${hosts[1]}:15731/`);
    const denied = await getJson(memoryPage, '/api/v1/sync/status');
    assert.equal(denied.status, 403);
    assert.equal((await context.cookies(`https://${hosts[1]}:15731`)).some(cookie => cookie.name === '__Secure-noteos_sync'), false);
    assert.equal(forwarded.find(row => row.host === `${hosts[1]}:15731` && row.path === '/api/v1/sync/status')?.cookiePresent, false);

    const wrongOrigin = await rawPost({ host: `${hosts[0]}:15731`, origin: `https://${hosts[1]}:15731`, cookie: `${session.name}=${session.value}`, path: '/api/v1/sync/bootstrap/dry-run', body: { protocolVersion: 1, records: [] } });
    assert.equal(wrongOrigin.status, 403);
    const crossSite = await rawPost({ host: `${hosts[0]}:15731`, origin: `https://${hosts[0]}:15731`, cookie: `${session.name}=${session.value}`, path: '/api/v1/sync/bootstrap/dry-run', crossSite: true, body: { protocolVersion: 1, records: [] } });
    assert.equal(crossSite.status, 403);
    assert.equal(await page.evaluate(secret => JSON.stringify({ ...localStorage, ...sessionStorage }).includes(secret), session.value), false);

    const revoked = await postJson(page, '/api/v1/sync/revoke', {});
    assert.equal(revoked.status, 200);
    assert.equal((await getJson(page, '/api/v1/sync/status')).status, 401);
    results.push({ browser: 'Chromium', version: browser.version(), hostnameIsolation: true, cookieAttributes: ['Secure', 'HttpOnly', 'SameSite=Strict', 'host-only', 'Path=/api/v1/sync'], allowedOriginStatus: allowed.status, siblingHostnameStatus: denied.status, wrongOriginStatus: wrongOrigin.status, csrfStatus: crossSite.status, revocationStatus: revoked.status, postRevocationStatus: 401, tokenInResponseOrStorage: false, syntheticOnly: true, liveTailnetTest: false });
    await writeFile(join(evidenceDir, 'host-isolation-https-requests.json'), JSON.stringify(forwarded, null, 2) + '\n');
    await writeFile(join(evidenceDir, 'host-isolation-browser-results.json'), JSON.stringify(results, null, 2) + '\n');
  } finally { await context.close(); await browser.close(); }
} finally {
  await new Promise(resolve => proxy.close(resolve));
  await rm(tmp, { recursive: true, force: true });
}
console.log('PASS: Chromium synthetic HTTPS hostname isolation, cookie flags, Origin/CSRF rejection, and immediate revocation.');
