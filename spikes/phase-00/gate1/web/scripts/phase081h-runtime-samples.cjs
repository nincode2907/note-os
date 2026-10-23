const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');

const container = process.env.NOTEOS_PHASE081H_CONTAINER ?? 'noteos-phase081h-isolated-test-web-1';
const output = process.env.NOTEOS_PHASE081H_SAMPLE_OUTPUT ?? '/tmp/noteos-phase081h-runtime-samples.json';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const toMiB = text => {
  const match = text.trim().match(/^([\d.]+)\s*(B|KiB|MiB|GiB)$/);
  if (!match) throw new Error(`Unrecognized Docker memory unit: ${text}`);
  const factors = { B: 1 / 1024 ** 2, KiB: 1 / 1024, MiB: 1, GiB: 1024 };
  return Number(match[1]) * factors[match[2]];
};
const percentile = (values, p) => values.slice().sort((a, b) => a - b)[Math.ceil(p * values.length) - 1];

(async () => {
  const samples = [];
  for (let index = 0; index < 10; index++) {
    const row = execFileSync('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}', container], { encoding: 'utf8' }).trim();
    const [cpu, memory, memoryPercent] = row.split('|');
    const [used, limit] = memory.split('/').map(value => value.trim());
    samples.push({ sample: index + 1, cpuPercent: Number(cpu.replace('%', '')), memoryUsedMiB: toMiB(used), memoryLimitMiB: toMiB(limit), memoryPercent: Number(memoryPercent.replace('%', '')) });
    if (index < 9) await sleep(1000);
  }
  const memoryValues = samples.map(sample => sample.memoryUsedMiB);
  const cpuValues = samples.map(sample => sample.cpuPercent);
  const report = {
    container,
    purpose: 'Synthetic Node 22.23.4 application container only; not the unregistered Tailscale node and not production load.',
    samples,
    memoryUsedMiB: { p50: percentile(memoryValues, 0.5), p95: percentile(memoryValues, 0.95), min: Math.min(...memoryValues), max: Math.max(...memoryValues) },
    cpuPercent: { p50: percentile(cpuValues, 0.5), p95: percentile(cpuValues, 0.95), max: Math.max(...cpuValues) },
    intervalMs: 1000,
  };
  mkdirSync(require('node:path').dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(`PASS: collected ${samples.length} Docker resource samples; Node 22.23.4 candidate only.\n`);
})().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
