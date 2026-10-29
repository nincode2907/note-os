// Phase 09F on-device search evaluation. Synthetic notes only; no network.
//   node scripts/semantic-search-eval.mjs --out <dir> [--scale 5000] [--iterations 200]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { createSearchIndex } from '../app/lib/semantic-search.mjs';
import { filterNotes } from '../app/lib/mvp-utils.mjs';
import { SEARCH_QUERIES } from '../app/lib/fixtures/search-queries.mjs';
import { SYNTHETIC_NOTES, syntheticNoteRecord } from '../sync-server/ai-eval/synthetic-notes.mjs';

const args = process.argv.slice(2), flag = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback; };
const outDir = flag('out', 'artifacts/semantic-search-eval'), scale = Number(flag('scale', 5000)), iterations = Number(flag('iterations', 200));
const round = (value, digits = 3) => Number(value.toFixed(digits));
const pct = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]; };

const notes = SYNTHETIC_NOTES.map(entry => ({ ...syntheticNoteRecord(entry), id: entry.id }));

function quality(rank) {
  const byType = {}, all = [];
  for (const query of SEARCH_QUERIES) {
    const ids = rank(query.q), relevant = new Set(query.relevant);
    const hits = ids.slice(0, 5).filter(id => relevant.has(id)).length;
    const first = ids.slice(0, 10).findIndex(id => relevant.has(id));
    const row = { recall5: hits / relevant.size, mrr10: first < 0 ? 0 : 1 / (first + 1), anyHit: first >= 0 ? 1 : 0 };
    all.push(row); (byType[query.type] ??= []).push(row);
  }
  const mean = (rows, key) => round(rows.reduce((sum, row) => sum + row[key], 0) / rows.length);
  const summarize = rows => ({ queries: rows.length, recallAt5: mean(rows, 'recall5'), mrrAt10: mean(rows, 'mrr10'), queriesWithAnyHit: mean(rows, 'anyHit') });
  return { overall: summarize(all), byType: Object.fromEntries(Object.entries(byType).map(([type, rows]) => [type, summarize(rows)])) };
}

const index = createSearchIndex(); index.sync(notes);
const report = {
  phase: '09F', engine: 'on-device hybrid: BM25 + hashed lexical/concept vector (512 dims), RRF k=60',
  environment: { node: process.version, cpu: cpus()[0]?.model, memoryGiB: Math.round(totalmem() / 1073741824), at: new Date().toISOString() },
  dataset: { notes: notes.length, queries: SEARCH_QUERIES.length, languages: ['vi', 'en', 'ja'], synthetic: true },
  quality: {
    substringFilterBaseline: quality(q => filterNotes(notes, q, 'active').map(note => note.id)),
    keywordBm25: quality(q => index.search(q, { mode: 'keyword', limit: 10 }).map(row => row.id)),
    hybrid: quality(q => index.search(q, { limit: 10 }).map(row => row.id)),
  },
};

// Scale: synthetic filler notes built from the dataset vocabulary, plus the labelled notes.
const words = notes.flatMap(note => `${note.title} ${JSON.stringify(note.document)}`.match(/[\p{L}]{2,}/gu) ?? []);
let seed = 7; const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const filler = Array.from({ length: scale }, (_, i) => ({
  id: `filler-${i}`, title: Array.from({ length: 4 }, () => words[Math.floor(rand() * words.length)]).join(' '),
  document: { schemaVersion: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: Array.from({ length: 60 }, () => words[Math.floor(rand() * words.length)]).join(' ') }] }] },
  schemaVersion: 1, createdAt: 1, updatedAt: 2, lifecycle: 'active', revision: 1, privacy: i % 5 === 0 ? 'DEVICE_ONLY' : 'PRIVATE_SERVER', tags: [],
}));
globalThis.gc?.();
const heapBefore = process.memoryUsage().heapUsed;
const big = createSearchIndex();
const t0 = performance.now(); big.sync([...notes, ...filler]); const buildMs = performance.now() - t0;
globalThis.gc?.();
const heapAfter = process.memoryUsage().heapUsed;
const latencies = [];
for (let i = 0; i < iterations; i++) { const query = SEARCH_QUERIES[i % SEARCH_QUERIES.length].q; const s = performance.now(); big.search(query, { limit: 20 }); latencies.push(performance.now() - s); }
const changed = { ...filler[10], revision: 2, updatedAt: 3, title: 'updated synthetic title' };
const u0 = performance.now(); big.sync([...notes, ...filler.slice(0, 10), changed, ...filler.slice(11)]); const incrementalMs = performance.now() - u0;
report.scale = {
  notes: big.size, indexBuildMs: round(buildMs, 1), incrementalSyncOneChangeMs: round(incrementalMs, 1),
  queryMs: { p50: round(pct(latencies, 0.5), 2), p95: round(pct(latencies, 0.95), 2), max: round(Math.max(...latencies), 2), iterations },
  indexHeapMiB: round((heapAfter - heapBefore) / 1048576, 1), gcExposed: typeof globalThis.gc === 'function',
  scaledQuality: quality(q => big.search(q, { limit: 10 }).map(row => row.id)).overall,
};
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'semantic-search-eval.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
