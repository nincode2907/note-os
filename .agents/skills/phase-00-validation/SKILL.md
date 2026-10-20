---
name: phase-00-validation
description: Plan, implement, and report noteOS Phase 00 technical spikes against the approved validation brief. Use for architecture validation, benchmarks, prototypes, or Phase 00 evidence in this repository.
---

# noteOS Phase 00 validation

Use `docs/phase-00/technical-validation-plan.md` as the canonical scope and acceptance source. This skill is specific to noteOS; use the global `project-ai-bootstrap` skill for repository instruction and knowledge architecture rather than duplicating its methodology.

## Work within the phase

- Validate architecture through runnable prototypes and automated evidence. Do not start Phase 01, production UI, unrelated features, or production changes to MemoryOS or AI Gateway.
- Keep backend, database, Web and worker execution in Docker Compose. Use an isolated Docker database for any test that can alter data; never reset real data volumes.
- Do not use paid cloud AI or send personal data to external services. Verify real provider contracts where access permits; do not invent endpoints, model metadata, or compatibility claims.
- Preserve the privacy rules, canonical JSON source of truth, and offline sync decision boundaries in the brief.
- Mark hardware or access dependent work BLOCKED when the required device, signing account, credential, or implementation access is missing. Never present simulator results as real-device evidence.

## Produce reviewable evidence

- Keep the eight required reports and the final report under `docs/phase-00/`, following the filenames and final report questions in the brief.
- Keep spike source, automated tests, Compose setup, logs, screenshots, dependency/license notes, reproduction steps, and unresolved limitations traceable to the relevant spike.
- For each benchmark record device/OS/browser, exact dependency versions, dataset, iteration count, p50/p95, applicable CPU/memory, expected versus actual, and PASS/FAIL/BLOCKED.
- Report audio gaps and partial recovery honestly. Distinguish finalized audio segments from transient recorder chunks.
- Treat canonical JSON as authoritative; Markdown export is derived. Preserve unsupported document data and use read-only behavior when safe editing is unavailable.
- For sync, exercise the required scenarios and do not label a custom protocol as a library's sync engine unless its actual adapter is used.
- For privacy, verify provider configuration and egress boundaries; a privacy header alone is not proof of enforcement.
- For durability, report exactly which data is and is not in the verified backup. Do not promise absolute zero data loss.

## Handoff

Stop at Phase 00. The final report must distinguish what ran from what remains blocked, state remaining risks and real-iPhone checks, compare the selected frameworks and rejected libraries, note design conflicts, recommend Phase 01 architecture, list decisions for ChatGPT, and explain the Docker test environment.
