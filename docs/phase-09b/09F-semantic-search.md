# Phase 09F — Semantic Search

**Verdict: PARTIAL.** On-device hybrid search (keyword + lightweight multilingual meaning) is **PASS** and shipped in source, with keyword fallback. A neural-embedding tier is **BLOCKED** (no embedding endpoint in the Gateway; model choice and approval needed).

## What works

- **Smart / Exact search on the Notes page.** *Smart* ranks by meaning; *Exact* is the original substring filter and the automatic fallback if the index cannot be used. Search runs entirely in the browser: no request leaves the page (verified: zero cross-origin requests), so it is safe for every privacy class, including `DEVICE_ONLY`.
- **Engine** (`app/lib/semantic-search.mjs`, pure JS, no model, no dependency):
  - Keyword: BM25 over words with Vietnamese diacritic folding (`kham rang` finds *khám răng*) and Japanese/CJK character bigrams.
  - Meaning: 512-dim hashed vector of words, character trigrams and a curated vi/en/ja **concept lexicon** (27 concepts, e.g. *invoice* ↔ *hóa đơn* ↔ *請求書*), fused with keyword ranking by reciprocal rank (k = 60).
  - Noise controls found during testing: single-syllable Vietnamese terms keep diacritics (folding made *đơn* “bill” collide with *dọn* “clean”, and *ôn* with English *on*); very short notes (< 4 features) are keyword-only; vector-only hits need a shared concept or a strong score.
  - Incremental index: unchanged notes are skipped by revision/updatedAt/lifecycle/privacy key; edits re-index; deleted notes are removed; trashed/archived notes are excluded by default; callers can filter by privacy class.
- **Related notes on the Mac (09C integration):** suggestions now include `similar_content` neighbours from the same in-process vector, computed live at publish time over notes whose own consent is currently approved. Revocation, deletion or edits take effect on the next analysis; no embedding is stored.

## Evaluation (synthetic; `evidence/09F/semantic-search-eval.json`)

24 hand-labelled queries over the 30 synthetic notes: exact, paraphrase, cross-lingual and accentless Vietnamese.

| Method | Recall@5 | MRR@10 | Queries with a hit | Paraphrase R@5 | Cross-lingual R@5 |
|---|---:|---:|---:|---:|---:|
| Current substring filter | 0.44 | 0.54 | 54 % | 0.00 | 0.41 |
| BM25 keyword | 0.60 | 0.72 | 75 % | 0.28 | 0.41 |
| **Hybrid (Smart)** | **0.96** | **0.94** | **100 %** | **0.94** | **0.93** |

Scale (Node 24.21.0, Apple M2 16 GB, 5,030 notes): index build ≈1.1–1.7 s once, single-note incremental update 3–5 ms, query p50 5–7 ms / p95 7–18 ms (host under external load), index heap ≈20 MiB. Browser (isolated stack, 2,030 local notes): first Smart query ≈250 ms including the lazy index build, then 7–13 ms in Chromium 156 and iPhone-sized WebKit 27.2.

**Honest reading:** the concept lexicon and the queries were written by the same author against this synthetic set, so hybrid quality is optimistic. The engine is a lexical/concept approximation, not a neural model; meaning outside the 27 concepts is found only through shared words and character trigrams. The figures show the mechanism and its cost on a 16 GB Mac, not real-world quality.

## Model-embedding tier — BLOCKED (design ready)

Needs: an embedding endpoint (codex-server does not offer embeddings; Ollama `/api/embed` would require an approved direct adapter), a multilingual model choice (e.g. `bge-m3` ≈1.2 GB or `nomic-embed-text` ≈0.3 GB — English-centred), and owner approval. Design: Mac-side sidecar vectors only for notes with current organize consent and an eligible privacy class; content-hash staleness; purge in the same transaction as revocation; keyword/on-device fallback when unavailable; never a cloud call without a separate grant.

## Tests

`app/lib/semantic-search.test.mjs` (4), `sync-server/ai-suggestions.test.mjs` 09F case (consent-gated `similar_content`), `scripts/semantic-search-browser.mjs` (PASS on both engines), `scripts/semantic-search-eval.mjs`.
