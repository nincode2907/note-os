# Phase 09C — AI Suggestions Inbox

**Verdict: PASS** (synthetic data; isolated Docker stack; fake local Gateway). Not deployed.

## What works

- **Proposals:** category (fixed vi/en/ja taxonomy), tags (extractive), one-sentence summary, tasks, related notes. Related notes are proposed by the server, never the model, only among notes whose own consent is currently approved for the same boundary; only IDs + reason codes are stored, titles are resolved on the device.
- **Review UI** (note page `#ai-suggestions` + `/inbox`): per item: kind, value, reason (“From your note” verbatim quote, or related-note reason), confidence (1 − model uncertainty, labelled as not a guarantee), provider/model and time, and a diff preview of exactly what will be added and where. Actions: **Approve / Edit / Reject / Later (Defer) / Undo**; non-applicable items offer **Dismiss**. AI Inbox nav link appears only when the paired server reports AI enabled.
- **AI never edits a note.** Apply happens only on an owner click, on the note page, through the existing `SaveCoordinator` (revision CAS, recovery journal, Sync outbox): tags via `updateMetadata`, document items via editor `setContent` + `coordinator.edit` + `flush`, with rollback to the last saved content if the save fails. The server note changes only through ordinary Text Sync (verified in E2E).
- **Stale / duplicate / cross-device:** item applicability is content-based — an item whose quote is no longer in the note is *stale*; an effect already present (tag key, identical checklist item, identical summary paragraph, related line) is a *duplicate*. Server decisions use per-item compare-and-set (`expectedVersion`): a second device acting on an old version gets `DECISION_CONFLICT` with the current state, and sees the item as *Applied*.
- **Undo:** tags are removed semantically; document items are reverted exactly while the note is unchanged, otherwise only the exact inserted node is removed (refused if the owner edited it). Undo records `UNDONE` and reopens the item.
- **Offline:** decisions queue in IndexedDB v7 (`aiDecisionOutbox`) and deliver in order; local undo receipts live in `aiApplyReceipts` (pre-apply document kept only on this device, cleared on undo, capped at 500).
- **Revocation:** purges payloads, removes the note from both inbox views, and queued decisions fail closed (`SUGGESTION_REVOKED`).
- **Light/dark & responsive:** AI surfaces carry scoped tokens that follow `prefers-color-scheme`; 44 px touch targets and stacked actions at ≤720 px; 0.2 s rise animation, disabled under `prefers-reduced-motion`.

## Server contract

AI ledger v4 (`004-ai-suggestion-decisions.sql`): `ai_suggestion_item_state` (current per-item decision + version) and append-only `ai_suggestion_decisions` (request-idempotent; keys, states, revisions; no text). Transitions: NONE/DEFERRED/UNDONE → APPROVED|EDITED|REJECTED|DEFERRED; APPROVED|EDITED|REJECTED → UNDONE. Suggestion status rolls up to ACCEPTED/REJECTED when every item is decided. Routes (same auth, origin, CSRF, rate limit as 09B-0): `GET /api/v1/ai/suggestions` (metadata only), `GET /api/v1/ai/suggestions/notes/{noteId}`, `POST /api/v1/ai/suggestions/{id}/decisions`. Cap 20,000 decision rows (`507` when full).

## Defects found and fixed during this phase

1. **AI API burst (reliability):** the consent panel re-fetched server consent on every Sync state event; one device used all 60 req/min during a normal flow and the inbox showed “Offline”. Fixed: server checks throttled to one per 15 s except after explicit actions/online; 429 shows “busy, retrying” with a delayed retry. E2E peak after fix: **34 requests/min**.
2. **Undo after later edits** refused all document undos; replaced with exact-node semantic inverse (refuses only if the owner changed that node).
3. **Dockerfile could not build** at HEAD (pre-existing since `ae4fb24`): runtime `COPY` used `/app/lib/...` instead of `/app/app/lib/...`. Fixed; the runtime image now also contains the AI worker modules and document engine source required by `ai-worker.mjs`.

## Verification

- Server: `ai-suggestions.test.mjs` (6) — server-side related consent filter, metadata-only inbox, CAS between devices, idempotency/rollup, revocation purge with no text in the decision log, HTTP auth/validation.
- Client: `ai-inbox.test.mjs` (8) — pure planning/applicability/undo, plus integration against the **real** route handlers + IndexedDB + SaveCoordinator: apply → Sync outbox → decision; two devices → CONFLICT; offline queue; revocation.
- Browser E2E `scripts/ai-inbox-browser.mjs` on `docker-compose.phase09-ai-synthetic.yml` (isolated volume/network, port 15745): Mac Chromium 156 (light + dark) and iPhone-sized WebKit 27.2 (390×844, light + dark). Pair → Text Sync → explicit consent → request → **on-demand worker inside the container** calling the host fake Gateway (`host.docker.internal:15746`, STRICT_LOCAL, attested profile) → review → approve/edit/reject/defer/related/undo → Sync → second device sees *Applied*. DEVICE_ONLY note: no AI controls, never sent. **PASS.** Screenshots in `evidence/09C/`.

## Limits and owner decisions

- **Privacy classification gap:** Text Sync enrollment does not set `privacy`; today only audio authorization marks a note `PRIVATE_SERVER`. AI correctly refuses missing privacy, so text-only notes cannot become AI-eligible in the current UI. Needed: an explicit per-note privacy control (owner decision; never inferred). The E2E seeds an explicit classification.
- Representations are interim and owner-revisable: category → tag; summary → quote block at top; related → plain “Related: <title>” line (canonical links must be http/https and origins differ per device).
- App-wide dark mode is not implemented (44 hard-coded colours outside AI surfaces); AI surfaces follow the system scheme.
- Not tested on a physical iPhone; WebKit at iPhone size is not device evidence.
