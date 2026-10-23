const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');

const repo = resolve(__dirname, '../../../../..');
const browserProject = resolve(repo, '../ui-lens');
const evidence = `${repo}/artifacts/review/noteOS-Phase08.1-H-Host-Isolation-review/evidence`;
const groups = {
  all: ['mvp-03-browser.mjs', 'backup-v2-browser.mjs', 'mvp-05-quick-capture-browser.mjs'],
  archive: ['backup-v2-browser.mjs', 'mvp-05-quick-capture-browser.mjs'],
};
const scripts = groups[process.argv[2] ?? 'all'];
if (!scripts) throw new Error('Usage: node run-phase081h-web-regressions.cjs [all|archive]');
const command = [
  'run', '--rm', '--network', 'container:noteos-phase081h-isolated-test-web-1',
  '-v', `${repo}:/workspace:ro`, '-v', `${browserProject}:/ui-lens:ro`,
  '-v', `${evidence}:/evidence`, '-v', `${evidence}:/workspace/artifacts/review/noteOS-Backup-V2-review/evidence`,
  '-e', 'NOTEOS_PLAYWRIGHT_ROOT=/ui-lens', '-e', 'NOTEOS_TEST_URL=http://127.0.0.1:3000',
  '-e', 'NOTEOS_MVP03_EVIDENCE=/evidence/editor', '-e', 'NOTEOS_MVP05_EVIDENCE=/evidence/quick-capture',
  '--entrypoint', 'sh', 'noteos-phase00-gate1-playwright', '-lc',
  scripts.map(script => `node /workspace/spikes/phase-00/gate1/web/scripts/${script}`).join(' && '),
];
execFileSync('docker', command, { stdio: 'inherit' });
