# Phase 09B-1A — Cross-process revocation safety

**Verdict: PASS** (synthetic data, test-only Mock provider; no model run, no migration, no deployment).
**Closes:** the 09B-0 blocker "a failed revoke latches only the serving process".

## Problem

09A.1/09B-0 returned `AI_REVOCATION_NOT_PERSISTED` when SQLite could not commit a revocation and latched that
note in an in-memory set. A second Node process (another Web process or a Mac worker) could not see that latch
and would keep dispatching inference while the durable consent row still said `APPROVED_*`.

## Design

The authority stays in SQLite. A filesystem control plane beside `sync.sqlite` carries the fail-closed state for
the window in which SQLite cannot carry it (`sync-server/ai-control.mjs`).

| Element | Behaviour |
|---|---|
| Write-ahead revocation intent | Before the revoke transaction, `<storage>/ai-control/r-<sha256(noteId)>.<ms>-<rand>` is created with `O_EXCL`, fsynced, and the directory fsynced. File existence is the signal; no note ID or content is written. Hashing avoids case-folding collisions on APFS. |
| Commit success | Intents with a timestamp ≤ commit time are removed. A newer concurrent intent is kept (it belongs to a later attempt). Failure to remove only over-blocks. |
| Commit failure | Intent stays; error `AI_REVOCATION_NOT_PERSISTED` with `controlPlane=revocation_intent_persisted`. If the intent could not be written either, an automatic global stop `s-*` is attempted; if that also fails the error reports `controlPlane=unavailable`. |
| Caller error | Idempotency conflicts and validation errors roll back before any write; the attempt removes its own intent and restores the prior latch state. |
| Grants / enqueue | Refused with `REVOCATION_PENDING` (HTTP 409) while an intent or in-process latch exists. Missing control plane → `AI_CONTROL_UNAVAILABLE` (503). |
| Durable dispatch fence | The dispatch transaction must commit an `ai_jobs` write **and** an fsynced worker heartbeat file. A read-only, full or frozen store/control plane therefore cannot dispatch. Claim failure → `claim_not_persisted`; fence failure → `dispatch_not_persisted`. |
| Pre-invoke recheck | The control plane is read again after the fence commits and immediately before the provider call. |
| In-flight watchdog | While the provider runs, every `watchdogMs` (default 100 ms) the worker checks markers/stops, job ownership/lease, and consent epoch; any doubt aborts the provider through `AbortSignal`. Revocation-type stops cancel the owned job. |
| Publish | `currentEligible` includes the control plane, so no suggestion is published while an intent or stop exists. |
| Reconcile | `reconcileAiRevocationIntents()` maps intent hashes to known note IDs and completes the revocation (`reason_code=recovered_revocation_intent`). It is idempotent; unmatched hashes are left in place and reported. |
| Stops | `INFERENCE_STOP` (operator) and `s-*` (automatic) block every note. A successful revoke never clears a global stop; `clearAutomaticInferenceStops()` is an explicit operator action and never removes the operator stop. |

## Failure matrix (all covered by tests)

| Scenario | Result |
|---|---|
| Revoke fails in process A while worker B is mid-inference | B aborts (provider `AbortSignal`), job `CANCELED`, no suggestion. p50 50.2 ms / p95 53.4 ms / max 55.3 ms over 40 cross-process races at 50 ms watchdog. |
| New worker process starts after a failed revoke | Job canceled before any provider call. |
| Process killed after the intent and before commit | Consent still `APPROVED` in SQLite, but every process is blocked; grant/enqueue → `REVOCATION_PENDING`; reconcile in a fresh process completes the revoke. |
| Real SQLite `readOnly` connection | Revoke fails with SQLite "readonly" cause, intent persists; a read-only worker cannot claim; a normal worker is blocked until reconcile. |
| Store turns read-only between claim and dispatch | `dispatch_not_persisted`, provider not called. |
| Control plane unwritable (chmod 0500) | Local and separate-process workers: `dispatch_not_persisted`. |
| Neither intent nor SQLite can persist | Error reports `controlPlane=unavailable`; serving process latched; other process blocked by unwritable heartbeat. |
| Intent cannot be written but SQLite commits | Success; the committed `REVOKED` row is authoritative. |
| Operator stop during inference | In-flight call aborted (`inference_stopped`); lease expiry requeues; stops block all notes. |
| Note IDs differing only by case | Independent markers. |
| HTTP | Unpersisted DELETE → 503; PUT grant and POST analysis request → 409 `REVOCATION_PENDING`; retry with the same request ID commits; a new grant gets epoch 3. |

## Residual limits (explicit)

- The design assumes all noteOS processes share one storage volume and run as the same OS user. A process that can write SQLite and the control plane while the revoking process can write neither is not detected; in that case the revoking client receives a 503 and keeps retrying (`REVOKE_PENDING`), and the other process is not informed until a retry commits. Deploy Web and worker under the same UID and volume.
- A provider call already in flight receives an abort; a remote endpoint that ignores cancellation may finish its computation, but the result cannot be published. The 09B-1B adapter forbids remote boundaries.
- Marker timestamps use the host wall clock. A clock moving backwards can leave a marker in place (over-blocking only); reconcile removes it.
- Automatic global stops require operator action to clear (runbook in the review bundle).

## Verification

`sync-server/ai-revocation-safety.test.mjs` (14 tests, real child processes via `test-fixtures/ai-safety-child.mjs`), one HTTP test in `ai-http.test.mjs`, and the full regression (server 111, client 125) pass on Node 24.21.0, macOS 15.7.7, Apple M2 16 GB. Logs: `evidence/09B-1A/`.

Gate result: **the safety gate for running any real model is PASS on code and tests.** It does not by itself authorize inference; owner approval and the 09B-1B provider boundary checks still apply.
