import os from 'node:os';
import { performance } from 'node:perf_hooks';
import {
  canonicalToMarkdown,
  parseCanonicalDocument,
  serializeCanonicalDocument,
  validateCanonicalDocument,
} from '../src/index.js';

const iterations = 30;
const quantile = (values, fraction) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];

function makeDocument(words) {
  const content = Array.from({ length: words }, (_, index) => `word${index + 1}`).join(' ');
  return { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: content }] }] };
}

function measure(operation, input) {
  for (let warmup = 0; warmup < 5; warmup += 1) operation(input);
  const durations = [];
  for (let sample = 0; sample < iterations; sample += 1) {
    const start = performance.now();
    operation(input);
    durations.push(performance.now() - start);
  }
  return { p50Ms: Number(quantile(durations, 0.5).toFixed(3)), p95Ms: Number(quantile(durations, 0.95).toFixed(3)) };
}

const operations = {
  jsonParseAndSchemaValidation: (json) => {
    const parsed = JSON.parse(json);
    return validateCanonicalDocument(parsed);
  },
  canonicalSerialization: (document) => serializeCanonicalDocument(document),
  markdownProjection: (document) => canonicalToMarkdown(document),
  localSaveProxyJsonEncodeDecode: (document) => JSON.parse(JSON.stringify(document)),
};

const hostBefore = process.memoryUsage();
const cpuStart = process.cpuUsage();
const rows = [];
let peakRssBytes = hostBefore.rss;
const memorySampler = setInterval(() => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
}, 10);
for (const words of [100, 1_000, 5_000]) {
  const document = makeDocument(words);
  const json = JSON.stringify(document);
  const measurements = Object.fromEntries(Object.entries(operations).map(([name, operation]) => [name, measure(operation, name === 'jsonParseAndSchemaValidation' ? json : document)]));
  rows.push({ words, jsonBytes: Buffer.byteLength(json), iterations, measurements });
}
clearInterval(memorySampler);
const cpu = process.cpuUsage(cpuStart);
const hostAfter = process.memoryUsage();
peakRssBytes = Math.max(peakRssBytes, hostAfter.rss);

console.log(JSON.stringify({
  environment: {
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    architecture: os.arch(),
    logicalCpus: os.cpus().length,
  },
  methodology: '5 warmups + 30 sequential iterations per operation and document size; one plain-text ProseMirror paragraph; performance.now(); p95 is nearest-rank.',
  memoryBytes: { rssBefore: hostBefore.rss, rssAfter: hostAfter.rss, sampledPeakRss: peakRssBytes, heapUsedBefore: hostBefore.heapUsed, heapUsedAfter: hostAfter.heapUsed },
  cpuMilliseconds: { user: Number((cpu.user / 1000).toFixed(2)), system: Number((cpu.system / 1000).toFixed(2)) },
  localSaveNote: 'JSON encode/decode proxy only; browser localStorage write and read were not measured.',
  results: rows,
}, null, 2));
