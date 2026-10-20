# noteOS

noteOS is a local-first AI note-taking product for Web and iPhone. This repository is currently in Phase 00: validate architecture with runnable spikes and automated evidence; do not begin Phase 01 or production feature work.

## Approved baseline

- Monorepo: pnpm workspaces; use Turborepo only if it is needed.
- Web: Next.js, React and Tiptap. iPhone: Expo and React Native.
- Backend: Laravel 12 and PHP 8.4; MySQL and Redis; services run with Docker Compose.
- Canonical document: versioned ProseMirror/Tiptap JSON. Offline sync engine remains undecided until benchmarked.
- Audio candidate: `expo-audio`. AI/STT adapters must preserve the privacy contracts.
- Check current supported stable versions and compatibility before pinning dependencies.

## Operational constraints

- Keep the work within Phase 00 spikes. Do not build production UI or proceed to Phase 01.
- Do not alter MemoryOS, AI Gateway, or other projects; do not reset real data volumes.
- Run backend, database, Web and worker services through Docker Compose. Destructive tests need an isolated Docker database.
- Do not use paid cloud AI or send personal data to external services during this phase.
- Do not claim real-iPhone results without testing on an iPhone. Mark hardware- or access-dependent work BLOCKED with the missing evidence.
- Do not create third-party accounts or push/deploy outside local development.
- Canonical JSON is the source of truth; Markdown is a derived projection. Unknown schema data must be preserved and opened read-only when safe editing is unavailable.
- Privacy levels are `DEVICE_ONLY`, `PRIVATE_SERVER`, and `CLOUD_ALLOWED`; never lower privacy implicitly and fail closed when provider boundaries are unclear.

## Working references

- For spike procedures and acceptance criteria, read `.agents/skills/phase-00-validation/SKILL.md`.
- The complete approved brief, deliverables and final report format are in `docs/phase-00/technical-validation-plan.md`; the visual overview is `docs/phase-00/technical-validation-plan.html`.
- Store Phase 00 decisions and evidence in `docs/phase-00/`. Do not report unmeasured targets as results.

## Completion

Keep each spike's status explicit as PASS, FAIL, or BLOCKED. Report actual versions, device/OS/browser, dataset, iterations, p50/p95 and relevant resource use. Record reproduction steps, source/tests, logs and unresolved limits. Stop after Phase 00 and hand off the report for architecture review.
