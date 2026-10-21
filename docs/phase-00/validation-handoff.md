# noteOS — Phase 00-B Validation Handoff

**Updated:** 2026-10-21
**Scope:** Freeze 00-B/B1 evidence and prepare isolated Web, native and Laravel validation.
**Status:** Core document engine **PASS** (B1 30/30 Node tests); Web editor runtime **BLOCKED**; native runtime **BLOCKED**; Laravel Feature tests **NOT RUN**. No Phase 01 work or editor/Sync Engine selection.

## 1. Frozen implementation summary

Reviewed source revision: `371deab` (`Validate Phase 00 document engine and recovery`); working tree was clean before this handoff. B and B1 are included in this single commit, so Git does not provide separate B-versus-B1 commit diffs; the initial 26-test and B1 30-test artifacts distinguish the recorded suite states. The commit's files are confined to Phase 00 spike source, tests, fixtures, evidence and reports plus the Gate 1 Web package manifest/lockfile and `.gitignore`. It does not alter production application source, database schema, Compose services, Dev Hub registration, or other projects.

The implementation is under `spikes/phase-00/gate1/`:

- `web/packages/document-engine/` owns canonical schema v1 validation, Tiptap conversion, serialization, plain-text conversion and Markdown projection.
- `web/app/editor/page.jsx` is the `/editor` client route. It loads a bundled valid fixture, edits through Tiptap, stores canonical JSON in browser `localStorage`, reloads that value, and displays unsupported saved JSON read-only.
- `mobile/document-engine-prototype/QuickCapture.tsx` is source-only React Native `TextInput` wiring to the shared plain-text converter. It is not a built or verified native editor.

Canonical document envelope: `{ "schemaVersion": 1, "type": "doc", "content": [...] }`. ProseMirror/Tiptap JSON is authoritative; Markdown and plain text are projections.

| Schema v1 area | Supported representation and limits |
| --- | --- |
| Blocks | paragraph; heading levels 1–6; blockquote; codeBlock with optional language; bulletList; orderedList with positive `start`; listItem; nested lists |
| Checklist | taskList / taskItem with boolean `checked`; Markdown output uses GFM `[ ]` / `[x]` and warns that this is an extension |
| Inline | text and hardBreak; bold, italic, strike and link marks |
| Link | non-empty `href`; protocols limited to `http`, `https`, `mailto`, `tel`; unsafe or ambiguous protocols are rejected |
| Attachment | Spike-only inline `attachmentReference` with opaque `attachmentId` and display `label`; no bytes, upload, storage or privacy contract |
| Unknown / invalid input | Future schema versions, unknown nodes/marks/fields/attributes are unsupported and non-editable; malformed/schema-invalid trees are invalid. Unknown source is not silently rewritten. |

Not in schema v1: horizontal rules, inline code marks, tables, images, arbitrary extensions or a production attachment model. StarterKit disables code mark, horizontal rule, underline and the default document extension; the custom versioned `doc`, task extensions and attachment node are used instead.

Export warnings/limitations:

- Plain text loses rich inline formatting, blockquote/list structure, code language and attachment identity; warning codes identify the known losses. Text code points, combining marks, whitespace and line boundaries are preserved by the tested converter.
- Markdown reduces an attachment reference to display text, warns for it, and cannot preserve attachment identity. Checklist output requires GFM. Ordered-list marker style is not retained; a warning is emitted. Markdown is never canonical storage.
- `JSON.stringify`/parse in the microbenchmark is only a save proxy. Browser `localStorage`, quota, editor latency and multi-document storage were not measured.

## 2. Dependencies and regression evidence

| Surface | Frozen versions / evidence boundary |
| --- | --- |
| Document-engine package | `@tiptap/core`, `@tiptap/extension-document`, `@tiptap/extension-list`, `@tiptap/starter-kit` all `3.32.0`; locked in the package lockfile. Node built-in `node:test`; no test framework dependency. |
| Gate 1 Web workspace | Next.js `16.4.2`, React/React DOM `19.3.1`, Tiptap packages `3.32.0`; `@tiptap/extension-link` is pinned in the Web workspace. Web Dockerfile base is Node `22.21.1-alpine`. This workspace also declares WatermelonDB and PowerSync for other routes; those services are not used by `/editor`. |
| B1 Node run | Evidence reports Node `v24.21.0` on Windows host build `10.0.26300`, x64, 16 logical CPUs. 30 passed, 0 failed; duration about 255 ms in the recorded B1 output. This is not browser or native evidence. |
| Transformation benchmark | Node `v24.21.0`, 5 warmups + 30 measured iterations per 100/1,000/5,000 word single-paragraph size. p50/p95 and sampled RSS/CPU are in `editor-benchmark.md` and the benchmark artifact. It measures transforms, not typing, browser save or UI rendering. |
| Native baseline | Expo `57.0.30`, React Native `0.86.0`, React `19.2.3`; present in `mobile/package.json`. |
| Native candidates researched | TenTap `@10play/tentap-editor 1.1.0` and React Native Live Markdown `0.1.343` were researched, not installed or added to the mobile manifest/lock. Quick Capture is source-only. These package compatibility notes do not establish build support. |
| Laravel test runtime | `api/composer.lock` pins PHPUnit `11.5.57`; `phpunit.xml` selects SQLite `:memory:`. API runtime image was installed without Composer dev dependencies. No test runtime/image was built for B/B1. |

### Regression fixture and commands

Frozen fixture: [`schema-v1-rich.json`](../../spikes/phase-00/gate1/web/packages/document-engine/fixtures/schema-v1-rich.json). It covers headings, Vietnamese combining text, Japanese, emoji, bold/italic/link, hard break, nested bullet/ordered list, checklist, blockquote, code block and a synthetic attachment reference. Other fixtures cover malformed trees, unknown node/mark at depth and unsupported schema v2.

The recorded commands, from `spikes/phase-00/gate1/web/packages/document-engine/`, are:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run benchmark
```

The frozen B1 test output is [`b1-node-test-output.txt`](../../artifacts/phase-00/document-engine/b1-node-test-output.txt), **30 PASS / 0 FAIL**. Initial B ran 26/26; B1 added the regression coverage and its 30/30 result is the current frozen suite. Exact benchmark output: [`benchmark-output.log`](../../artifacts/phase-00/document-engine/benchmark-output.log). No command was run as part of this handoff.

## 3. Isolated Web `/editor` runbook

### Static isolation finding

The `/editor` client page imports only the local document-engine module, the bundled JSON fixture and CSS. Its data path uses `localStorage`, Tiptap editor callbacks, in-memory conversion and `window.location.reload()`. Static search found no `fetch`, XHR, API client or `/api` use in the editor page, its imported document-engine source or root layout. The root Next configuration defines an `/api/:path*` rewrite to `gate1-api`, but this route does not call `/api`; that rewrite is inert for this flow. Other routes do use backend services, and the Watermelon service worker registration is in the Watermelon UI rather than `/editor`.

Conclusion: the editor flow is statically independent of MySQL, Redis, MongoDB, PowerSync and Laravel for fixture load, create-from-text, edit, save and reload. This is a source conclusion; browser request/console evidence is not yet collected. Use a fresh browser context so a service worker or local data from another Gate 1 route cannot affect the result.

### Start only the Web service (future approved run)

**Precondition:** capacity gate must be rechecked and pass for the host and Docker VM at run time. B1 recorded only 1,512–1,531 MiB Windows available memory with paging activity; that is **CAPACITY_BLOCKED** against the prior 2–3 GiB Next + Chromium planning envelope. The current Docker VM headroom is not established. Do not run this sequence until the capacity decision permits it.

From the repository root, first confirm the already-built Web image exists without building it. If the image is missing, stop; a build needs its own capacity approval. Then start a single throwaway web container with dependency startup and image build explicitly disabled:

```sh
docker image inspect noteos-phase00-gate1-web >/dev/null
docker compose -f docker-compose.gate1.yml --profile gate1-watermelon \
  run --no-deps --pull never --rm -p 127.0.0.1::3000 gate1-watermelon-web
```

The profile service definition has an API `depends_on`, but `run --no-deps` suppresses dependency startup. `--pull never` prevents a missing image from being fetched; the earlier image inspection is a precondition and there is no build flag. It publishes a random loopback port, has no database volume mount, and the page does not call the API. The `run` port and dependency behavior follows the [Docker Compose run reference](https://docs.docker.com/reference/cli/docker/compose/run/). In another terminal, identify the one-off container and assigned port:

```sh
docker ps --filter label=com.docker.compose.service=gate1-watermelon-web \
  --format 'table {{.ID}}\t{{.Ports}}'
```

Open `http://127.0.0.1:<assigned-port>/editor` in a fresh private browser context. Keep the run single-worker and stop it with Ctrl-C; `--rm` removes the one-off container. Do not start the profile with `up`, because that would include database/API dependencies. Do not build in this runbook.

### Browser checks

1. **Valid canonical JSON:** initial view renders the bundled rich fixture. Confirm heading, marks, list, checklist, link, code, attachment label, Japanese and Vietnamese text.
2. **Create/edit/save/reload:** use the plain-text field to create a document, including Vietnamese and Japanese; convert it, edit it in the Tiptap surface, click **Save canonical JSON**, inspect the `noteos:phase-00-b:canonical-document-v1` localStorage value, then click **Reload local save**. Verify content and schema envelope survive.
3. **Unknown schema read-only:** in DevTools on this fresh origin, seed and reload:

   ```js
   localStorage.setItem('noteos:phase-00-b:canonical-document-v1', JSON.stringify({ schemaVersion: 2, type: 'doc', content: [] }));
   location.reload();
   ```

   Confirm the raw JSON is shown, edit/convert/save controls do not enable editing, and the stored value is unchanged.
4. **IME and Unicode:** type Vietnamese with the chosen Telex/VNI input method and Japanese through an active Japanese IME. Record OS/browser/input method and verify composition text, caret, selection, save/reload and code points. Node converter tests are not evidence for browser IME behavior.
5. **Markdown warnings:** preview the bundled rich fixture. Verify warnings for GFM checklist and attachment identity loss; preserve the canonical localStorage JSON while previewing.
6. **Console/network:** preserve console output and a HAR/screenshot. Filter requests for `/api`, Laravel, MySQL or PowerSync hostnames. Expect no backend request from `/editor`; distinguish Next document/chunk/HMR requests. Record any console errors and failed requests instead of hiding them.

Browser result starts **NOT RUN** and becomes PASS/FAIL only with the above runtime evidence. Record browser/version/OS, test document, screenshots, console/network evidence, and localStorage before/after.

## 4. Native validation checklist

The baseline is Expo 57 / RN 0.86 / React 19.2.3. TenTap is a WebView-backed ProseMirror/Tiptap candidate; Live Markdown is a native string-oriented Markdown input, not a canonical ProseMirror editor. Neither is selected. Record each evidence level separately:

| Stage | Evidence required | Current status |
| --- | --- | --- |
| Static compatibility | Lockfile/package matrix, Expo SDK/RN/New Architecture requirements, native module and WebView requirements, extension/schema mapping. Candidate upstream compatibility is not a build result. | Research recorded; TenTap/Live Markdown are not installed in the mobile manifest. |
| Build compatibility | Install from a candidate lock, Expo prebuild/dev client, iOS CocoaPods, Xcode build/signing. Record exact Xcode, iOS SDK, CocoaPods and package versions. | **NOT RUN / BLOCKED**; no native build evidence. |
| Runtime rendering/editing | On device render the rich fixture, create/edit supported nodes/marks, selection/caret, undo/redo and keyboard dismissal. Verify unknown schema opens raw/read-only. | **NOT RUN**. |
| IME behavior | Real iPhone typing with Vietnamese Telex and VNI and Japanese IME; composition, autocorrect, marked text, caret, selection and multiline behavior. Capture device/iOS/keyboard settings. | **BLOCKED** until a real iPhone is tested. Simulator evidence must be labeled simulator and cannot close this gate. |
| Canonical JSON round-trip | Export JSON from native, validate schema v1, compare supported fields/attrs and ordering with source fixture; native edit → save → reload → export again. Check unknown data preservation/read-only. | **NOT RUN**. TenTap `getJSON()` API possibility does not prove bridge round-trip. Live Markdown requires a separate loss-aware text-to-JSON mapping. |
| Background/restart persistence | Save, background app, terminate/relaunch, and verify committed local data. Distinguish saved JSON from in-memory edits; record data loss window. Test app upgrade/schema migration only as a separately approved validation. | **NOT RUN**. No guarantee for unsaved in-memory data is claimed. |

The Quick Capture adapter only proves source-level wiring to `plainTextToCanonicalDocument`; it is not a runtime-rendering or persistence test. Do not mark native PASS or choose a native editor until these stages have separate evidence on the target device.

## 5. Test-only Laravel PHP 8.4 proposal

`api/composer.json` requires PHP `^8.2`; `composer.lock` contains PHPUnit `11.5.57` and the dev tree. Host runtime is PHP 7.4.33 and `api/vendor/autoload.php` is absent. The API image uses `composer install --no-dev`, so it is not a test runner. Proposal only; no image, dependency install or Laravel test was run:

1. Add a **separate** test-only PHP `8.4` CLI image based on the API source, with Composer and the platform extensions required by the lockfile, especially `pdo_sqlite`/SQLite plus Laravel/PHPUnit requirements. Verify with `composer check-platform-reqs` after a locked install.
2. Install from the checked-in `api/composer.lock` using `composer install --no-interaction --prefer-dist` with dev dependencies enabled. Do not run `composer update`, do not alter the production API image, and do not mount another project's files or database.
3. Run the test container with networking disabled and only the isolated API source. `api/phpunit.xml` sets `DB_CONNECTION=sqlite` and `DB_DATABASE=:memory:`; `RefreshDatabase` therefore uses a process-local in-memory database rather than a shared MySQL volume.
4. Run only `php artisan test --configuration=phpunit.xml --filter=SyncPullContractTest`. Capture PHP version, Composer platform check, PHPUnit version, test output and exit status. The four Laravel tests remain **NOT RUN** until this approved runtime exists.

Resource usage for this future image/test has not been measured. The current Gate 1 capacity block applies; do not build or execute it while capacity is unverified.

## 6. Blockers and next gates

### Resource notes

- The Node transformer microbenchmark sampled process RSS at 59.8 MB before and 66.1 MB after; this is not the B1 test-runner peak. The pure Node regression command needs no Docker services, browser or database.
- Next + one Chromium worker has a prior **2–3 GiB planning estimate**, not a measured peak. B1's Windows sample showed about 1.48–1.50 GiB available with paging activity, so browser work was capacity-blocked. Docker VM available memory was not sampled in B1 and remains a separate precondition.
- Xcode/CocoaPods/native builds and the PHP 8.4 Composer test image have no measured resource profile. Require a capacity check before either build; do not infer safety from idle memory or a configured VM size.

- **Web:** browser runtime, editor save/reload, console/network and IME are **NOT RUN**; available-memory snapshot blocked the prior Next + Chromium plan.
- **Native:** no build, runtime, IME, JSON bridge or persistence evidence; actual iPhone validation remains **BLOCKED**.
- **Laravel:** PHP 8.4 test-only runtime and Composer dev dependencies are absent; contract Feature tests remain **NOT RUN**.
- **Export:** Markdown/plain-text losses are warned and documented, but browser warning UI remains unverified.
- **Scope:** do not build a production editor, select a native editor, select a Sync Engine, open Gate 2 or start Phase 01.

Next sequence after the separate capacity gate: (1) run one isolated `/editor` Web container with a fresh browser context and no dependencies; (2) prepare and run the isolated PHP 8.4 SQLite contract-test image; (3) seek explicit native build/device access and perform the native checklist. Stop for architecture review after Phase 00-B evidence is complete.

Evidence index and related report: [editor-benchmark.md](editor-benchmark.md), [phase-00-report.md](phase-00-report.md), [architecture-decisions.md](architecture-decisions.md#00-b--document-engine-and-editor-spike), [`B1 test output`](../../artifacts/phase-00/document-engine/b1-node-test-output.txt), [`capacity snapshots`](../../artifacts/phase-00/document-engine/b1-capacity-snapshot.txt).
