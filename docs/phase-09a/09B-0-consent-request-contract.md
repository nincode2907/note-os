# 09B-0 proposal — explicit AI consent and analysis request transport

**Status:** Design proposal only. No endpoint, UI, Sync Protocol v1 change, database migration, or worker integration is implemented here.

## Existing client evidence

- iPhone Safari Web Text Sync was **owner-confirmed ACCEPTED** in the Phase 08.2B physical-device pilot: Safari iPhone↔Mac text Sync, offline replay, and conflict preservation were reported PASS. Codex did not perform or independently observe the phone interactions.
- Installed PWA physical acceptance is **pending**.
- Expo Native has no confirmed Sync client in the inspected source.

The remaining AI integration gap is transport for explicit AI consent and an explicit analysis request. It is not the absence of all iPhone-to-Mac Sync. Native Sync and installed PWA acceptance remain separate client readiness questions.

## Proposed contract

Keep Sync Protocol v1 unchanged. After ordinary Text Sync returns an acknowledgement for a committed active note revision, the user can separately authorize AI and request analysis through a separately versioned, authenticated AI API. The client sends identifiers and consent metadata; the server reads the exact immutable note snapshot from `sync_changelog`. The transport must not resend note text or enqueue work as a side effect of normal Sync push.

### Consent grant

Proposed request: `PUT /api/v1/ai/consents/{noteId}` with a strict envelope containing protocol version, approved scope (`organize`), provider-boundary choice, and an idempotency/request ID. The response returns the server consent epoch, current decision, and effective provider boundary. Consent is per note and explicitly granted; no historical backfill occurs. The UI must say whether the grant covers future revisions, and that choice remains an owner decision.

Eligibility remains separate from privacy. Missing/unknown privacy and `DEVICE_ONLY` are rejected. `PRIVATE_SERVER` requires explicit local-only consent plus later proof of local execution. `CLOUD_ALLOWED` does not itself grant provider permission. Phase 09B-0 must not expose external cloud processing until remote boundary, retention, and cancellation are separately approved.

### Analysis request

Proposed request: `POST /api/v1/ai/analysis-requests` with a strict envelope containing protocol version, request/idempotency ID, note ID, acknowledged server epoch, exact server version, consent epoch, and scope. The server must verify:

1. The authenticated device is authorized for the note.
2. The epoch/version identifies the latest committed active note revision and its immutable changelog snapshot.
3. Consent is currently approved for that note, scope, and provider boundary; privacy remains eligible.
4. The request has not been revoked, superseded, or already consumed under a different metadata tuple.
5. Job row and enqueue audit are committed atomically. Whether to join that transaction to the note commit is a separate architecture decision; never infer a request from a normal push.

Return only a job ID and bounded state metadata. Do not return the note snapshot or include it in logs. Repeated identical request IDs are idempotent; reusing an ID with different note/version/consent metadata is a conflict. Dedupe identity includes source epoch/version/hash, consent epoch, analysis policy, output schema, model identity, scope, and boundary.

### Revocation

Proposed request: `DELETE /api/v1/ai/consents/{noteId}` or an equivalent strict POST action, protected by the same authenticated-device and CSRF/origin rules as Sync. It must return success only after one transaction persists the incremented consent epoch, `REVOKED` marker, job cancellation, and suggestion payload purge. A full general audit quota cannot block revocation; the consent row is the minimal durable marker, with a compact general audit entry when capacity exists.

If SQLite cannot persist the transaction, return a recoverable error and stop dispatch in the authoritative worker control plane. Before multi-process inference, define how this fail-closed state reaches every worker; an in-memory flag alone is insufficient across processes.

## Client-specific path

- **iPhone Safari Web:** reuse the accepted same-origin Text Sync session only after a separate consent/request UI is approved. The AI endpoints must not alter Sync v1 push/pull envelopes.
- **Installed PWA:** implement the same contract, then complete the pending physical-install acceptance before claiming it is accepted.
- **Expo Native:** first verify/build the native Sync client and its authentication/privacy parity; do not assume the Safari result proves Expo behavior. Add consent/request transport only after that client exists.

## Unresolved owner decisions before implementation

1. Does a grant cover one exact note revision, or future revisions of that note until revoked? Recommended: per-note scope with a separate explicit request for each revision, disclosure when a grant covers future revisions, and no automatic historical requests.
2. Which actors/devices can grant/revoke, and does one device's revocation apply to every paired device? Recommended: server-global per-note revocation epoch.
3. Which boundary may be selected in 09B-0? Recommended: local-only Mock in synthetic testing; no real inference and no external-cloud option.
4. What retention applies to accepted/rejected metadata, audit markers, WAL copies and backups? Revocation purges live derived text but does not erase immutable history or prior backups.
5. Must the request and job be atomic with a future note commit, or is a separately committed explicit request sufficient? Sync v1 cannot express the request; do not extend it implicitly.
6. Which installed-PWA and Expo Native devices/OS versions need physical acceptance, and who supplies the acceptance evidence?

**Recommendation:** approve this transport contract for review only. Implement it as a separately versioned API/UI slice after owner decisions; keep Phase 09B-0 itself model-free and default-off.
