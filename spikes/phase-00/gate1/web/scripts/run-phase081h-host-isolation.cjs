const { execFileSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const { resolve } = require('node:path');

const repo = resolve(__dirname, '../../../../..');
const browserProject = resolve(repo, '../ui-lens');
const webContainer = 'noteos-phase081h-isolated-test-web-1';
const browserImage = 'noteos-phase00-gate1-playwright';
const evidence = `${repo}/artifacts/review/noteOS-Phase08.1-H-Host-Isolation-review/evidence`;
mkdirSync(evidence, { recursive: true });

// The one-time code exists only in this process environment and is never printed or written to evidence.
const code = execFileSync('docker', ['exec', webContainer, 'node', '/verification/fixture.mjs', 'pair'], { encoding: 'utf8' }).trim();
try {
  execFileSync('docker', [
    'run', '--rm', '--network', 'noteos-phase081h-isolated-test_default',
    '-v', `${repo}:/workspace:ro`, '-v', `${browserProject}:/ui-lens:ro`, '-v', `${evidence}:/evidence`,
    '-e', 'NOTEOS_PLAYWRIGHT_ROOT=/ui-lens', '-e', 'NOTEOS_SYNC_EVIDENCE=/evidence',
    '-e', 'NOTEOS_PHASE081H_UPSTREAM_HOST=web',
    '-e', 'NOTEOS_PHASE081H_UPSTREAM_PORT=3000',
    '-e', 'NOTEOS_PHASE081H_BIND=0.0.0.0', '-e', `NOTEOS_PHASE081H_PAIRING_CODE=${code}`,
    '--entrypoint', 'node', browserImage,
    '/workspace/spikes/phase-00/gate1/web/scripts/phase081h-host-isolation-browser.mjs',
  ], { stdio: 'inherit' });
} catch (error) {
  const message = String(error.stderr ?? error.message ?? error).replaceAll(code, '[redacted synthetic pairing code]');
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
