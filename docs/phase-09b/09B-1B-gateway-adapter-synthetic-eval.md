# Phase 09B-1B — AI Gateway adapter and synthetic evaluation

**Verdict: PARTIAL.** Adapter, boundary policy, worker and synthetic harness: **PASS** (tests + fake Gateway over real loopback HTTP).
Real local-model benchmark: **BLOCKED** — the Gateway has no local backend configured and the brief allows only mock/fake providers until the owner approves a real model.

## Existing Gateway (verified read-only, not modified)

| Fact | Evidence |
|---|---|
| Local AI Gateway = `codex-server`, OpenAI-compatible, `127.0.0.1:15600` (Dev Hub registry; MemoryOS uses it via `host.docker.internal:15600` + Host `codex-server.localhost`). | `GET /health` → `{"ok":true,"provider":"codex"}` |
| Only provider configured: `codex` (ChatGPT/Codex CLI). Its models report `"state":"remote"` → **cloud**. | `GET /v1/models` |
| Local backends (`ollama`, `lmstudio`) are opt-in in the Gateway and **not configured**. | `GET /v1/models?provider=ollama` → 400 `provider_disabled` |
| Ollama is installed with `llama3.1` / `llama3.1-fast` (≈4.9 GB) but was not running. | `~/.ollama/models/manifests` |

No inference, chat, or prompt was sent to the real Gateway. Only `GET /health` and `GET /v1/models` (no note data) were called.

## Adapter contract (`sync-server/ai-provider-gateway.mjs`)

- **Boundary classification:** `codex` → cloud → refused at configuration (`Cloud gateway providers are not permitted`). Only `ollama`/`lmstudio` can form a `STRICT_LOCAL` profile.
- **Explicit profile, no fallback:** `NOTEOS_AI_LOCAL_PROVIDER_ENABLED=1`, `NOTEOS_AI_GATEWAY_URL` (plain loopback origin; `host.docker.internal` only with `NOTEOS_AI_GATEWAY_ALLOW_DOCKER_HOST=1`), `NOTEOS_AI_GATEWAY_PROVIDER`, `NOTEOS_AI_GATEWAY_MODEL` (no default), `NOTEOS_AI_LOCAL_ATTESTATION=<owner>:<YYYY-MM-DD>` (owner states the Gateway's local backend runs on this Mac). Any partial or unsafe profile collapses to `MOCK`; it never upgrades. Identity: `gateway:<provider>:<model>`.
- **Health without inference:** the model must be listed by `/v1/models?provider=<p>` with the same provider and `state !== "remote"`.
- **Transport:** `node:http`, `agent:false`, explicit Host/Bearer, redirects refused, 64 KiB response cap, timeout (default 60 s, max 180 s), `AbortSignal` honoured (the 09B-1A watchdog aborts in-flight calls). 5xx/429/timeout/unreachable → transient (bounded backoff, max 5 attempts); 4xx/redirect/oversize/invalid body → permanent → `FAILED_NEEDS_REVIEW` after one attempt.
- **Prompt:** only title, tags and plain text are sent, as JSON between `NOTE_DATA_BEGIN/END`; note ID, privacy, revision and other notes are never sent. System rules: data-not-instructions, no URLs/HTML/Markdown, JSON-only, verbatim quotes.
- **Removal-only normalization before the strict 09A validator:** drops ungrounded quotes, URL/HTML text, duplicate tags, non-extractive tag labels (label must occur in the note), category labels outside a fixed vi/en/ja taxonomy, and every model-proposed related note (related notes come from the deterministic/semantic path with per-candidate consent, not the model). Counts drops as a metric.
- **Policy wiring:** `aiExecutionProfile(env)` drives consent grant, enqueue (model identity + boundary in the dedupe key), dispatch and publish rechecks. A `MOCK` consent never authorizes a real model. `EXTERNAL_CLOUD` is impossible in the schema (AI ledger v3) and refused by provider admission.
- **AI ledger v3** (`003-ai-local-boundary.sql`): rebuilds `ai_analysis_requests` so `execution_boundary IN ('MOCK','STRICT_LOCAL')`; rows/indexes preserved. Not applied to production.

## Worker topology (`sync-server/ai-worker.mjs`)

Production Sync SQLite lives in Docker Desktop volume `noteos_noteos_sync` inside the VM, so a Mac-host process must not open it. The worker is an **on-demand process inside the existing `noteos-web` container** (`docker compose exec web node sync-server/ai-worker.mjs --check|--once|--drain`). No new container or resident service. Preflight is fail-closed: flags, attested profile, AI schema v3, control plane + reconcile, operator stop, Gateway health. Logs are metadata only (no titles, IDs of notes, prompts, outputs, or keys).

## Synthetic evaluation

Dataset: 30 hand-written synthetic notes (10 vi / 10 en / 10 ja), including 6 prompt-injection notes (instruction override, URL exfiltration, HTML/script, JSON smuggling) and 3 too-short notes. Run: Node 24.21.0, macOS 15.7.7, Apple M2 16 GB; host under external load (load average 270–500 from unrelated headless Chrome jobs), 3 iterations, fake Gateway latency 40–62 ms injected.

| Stage (stand-in generator) | Schema-valid | Unsafe leaks | Injected-label adoption | Dropped/request | Latency p50 / p95 | Tokens in/out (est.) | Client RSS max |
|---|---:|---:|---:|---:|---:|---:|---:|
| heuristic (rule-based) | 100 % | 0 | 0 | 0.07 | 60.6 / 88.7 ms | 293 / 97 | 71.6 MiB |
| adversarial (obeys injections) | 100 % | 0 | 3 / 18 | 9.0 | 58.7 / 97.6 ms | 293 / 214 | 80.4 MiB |

End to end through SQLite claim → fence → HTTP → validate → publish: 30/30 jobs `COMPLETED`, p50 73.7 ms / p95 113.8 ms (heuristic). Cost: local backend, not metered (0 for fake).

**How to read these numbers:** quality scores (heuristic category 1.0, tag recall 1.0, task recall 0.54) are circular — the rule generator's lexicon was written from the dataset. They prove the scoring and pipeline, not model quality. The meaningful results are: 0 unsafe leaks under a fully-obedient adversary; no proposal survives without a verbatim quote; and the residual — an injected word that is literally in the note (e.g. `pwned`) can still be proposed as a tag. Human per-item approval (09C) is the control for that residual.

## Real-model benchmark — BLOCKED

Requires owner decisions: (1) approve running a local model on synthetic data; (2) configure the Gateway's `OLLAMA_BASE_URL` (Gateway config is another project — not changed here) or approve a direct-Ollama adapter; (3) choose the model (installed: `llama3.1`/`llama3.1-fast` 8B, ≈4.9 GB; fits 16 GB but competes with Docker/Chrome). Command once approved:

```sh
NOTEOS_AI_EVAL_REAL_APPROVED=<owner:YYYY-MM-DD> node scripts/ai-synthetic-eval.mjs --real \
  --gateway http://127.0.0.1:15600 --provider ollama --model llama3.1-fast --out <dir>
```

The script refuses `codex`, non-loopback origins and missing approval. Measure RAM of the Ollama process separately (`ollama ps`, Activity Monitor) — the harness reports only its own RSS.

## Tests

`sync-server/ai-provider-gateway.test.mjs` (13 tests: config safety, health, payload privacy, fault classes, unreachable, abort, normalization, STRICT_LOCAL e2e outside test mode, admission refusals, DEVICE_ONLY/unconsented zero requests, permanent vs transient, injection containment, worker CLI in a separate process) plus one client test for boundary propagation. Full regression green (see `evidence/09B-1B/`).
