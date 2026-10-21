# Phase 00-B — Document engine and editor validation

**Updated:** 2026-10-20
**Status:** Core schema/conversion spike **PASS** (26/26 Node tests); transformation microbenchmark **PASS**; browser editor **BLOCKED**; native/iPhone editor validation **BLOCKED**; Laravel sync contract tests **NOT RUN**. This is Phase 00 evidence only, not production approval.

## Scope and implementation

The prototype lives under `spikes/phase-00/gate1/` and does not change Compose services. The isolated package pins Tiptap `3.32.0` (`@tiptap/core`, `@tiptap/extension-document`, `@tiptap/extension-list`, `@tiptap/starter-kit`; the web workspace also pins `@tiptap/extension-link`). Package versions were checked against the npm registry on 2026-10-20. Runtime package listing: [`npm ls` evidence is represented by the exact package manifest and lockfile](../../spikes/phase-00/gate1/web/packages/document-engine/package-lock.json).

Canonical shape is `{ "schemaVersion": 1, "type": "doc", "content": [...] }`. ProseMirror JSON is authoritative; Markdown and plain text are derived projections.

| Feature | Schema v1 representation |
| --- | --- |
| Paragraph / heading | `paragraph`; `heading` with integer `level` 1–6 |
| Quote / code | `blockquote`; `codeBlock` with optional string language |
| Lists | `bulletList` / `orderedList` / `listItem`; positive ordered-list `start`; nested lists supported |
| Checklist | `taskList` / `taskItem` with boolean `checked` |
| Inline | text, `hardBreak`; bold, italic, strike and link marks |
| Link | non-empty `href`; only `http`, `https`, `mailto` and `tel` schemes |
| Attachment reference | Spike-only inline atom with opaque `attachmentId` and display `label`; it does not model bytes, uploads, or storage/privacy behavior |

Unknown future schema versions, nodes, marks, node/mark fields and attributes return `unsupported` with editing disabled. Invalid JSON/tree data returns `invalid`. Neither path silently drops unknown data. The browser route shows unsupported localStorage source as raw read-only JSON. Plain-text and Markdown projections report warnings when structure or formatting is omitted; checklist Markdown uses the GFM extension, and Markdown cannot preserve the attachment-reference type.

The web spike route is `spikes/phase-00/gate1/web/app/editor/page.jsx` (`/editor` in the Gate 1 Next app). It includes a Tiptap formatting surface, a synthetic attachment reference, plain-text conversion, Markdown preview, canonical JSON save/reload through a dedicated localStorage key, and a read-only unsupported-data state. A source-only React Native Quick Capture adapter is at `spikes/phase-00/gate1/mobile/document-engine-prototype/QuickCapture.tsx`.

## Automated contract tests

Reproduction: from `spikes/phase-00/gate1/web/packages/document-engine/`, run `npm ci --ignore-scripts --no-audit --no-fund`, `npm test`, and `npm run benchmark`. The test runner is Node's built-in test framework; tests do not use MySQL, Laravel, Docker, a browser or personal data.

Final result: **26 passed, 0 failed**. Coverage includes supported document nodes/marks, nested ordered and bullet lists, checklist state, attachment references, Unicode and combining marks, whitespace/newlines, Markdown/plain-text projection warnings, safe links, malformed trees, unsupported future/unknown data, canonical serialization/reload and repeated round trips. Exact output: [`node-test-output.txt`](../../artifacts/phase-00/document-engine/node-test-output.txt).

The first run had one failure: ProseMirror returns null-prototype attribute objects while JSON reload creates ordinary objects, which broke strict deep equality. The validator now normalizes its ProseMirror output through JSON serialization before returning canonical data. The rerun passed all 26 tests. This is a document-engine representation issue; it provides no evidence about the prior Watermelon 0/20 browser result.

## Transformation microbenchmark

Environment: Node `v24.21.0`, Windows host build `10.0.26300`, x64, 16 logical CPUs; Tiptap dependencies `3.32.0`. Each cell is 5 warmups followed by 30 sequential iterations. Dataset is one plain-text paragraph of 100, 1,000 or 5,000 words; p95 uses nearest-rank. Timings are milliseconds.

| Words (JSON bytes) | JSON parse + schema validation p50 / p95 | Canonical serialization p50 / p95 | Markdown projection p50 / p95 | JSON encode/decode save proxy p50 / p95 |
| ---: | ---: | ---: | ---: | ---: |
| 100 (794) | 0.015 / 0.043 | 0.016 / 0.038 | 0.015 / 0.034 | 0.004 / 0.005 |
| 1,000 (7,995) | 0.044 / 0.147 | 0.033 / 0.113 | 0.034 / 0.096 | 0.024 / 0.048 |
| 5,000 (43,995) | 0.091 / 0.117 | 0.110 / 0.454 | 0.080 / 0.097 | 0.065 / 0.078 |

The save proxy only measures `JSON.stringify`/`JSON.parse`; browser localStorage was not measured. This does not measure editor keystroke latency, render time, storage quota, multi-note datasets, or browser memory. Node process RSS was 59.8 MB before and 66.1 MB after (sampled peak 66.1 MB); heap was 10.4 MB before and 11.8 MB after; CPU time was 31 ms user / 0 ms system. Exact output: [`benchmark-output.log`](../../artifacts/phase-00/document-engine/benchmark-output.log).

## Runtime and capacity gates

**Browser capacity gate: `CAPACITY_BLOCKED`; browser runtime NOT RUN.** The final post-run sample at 23:35:49–23:35:53 showed Windows available memory of 2,577, 2,564 and 2,539 MiB (2.48–2.52 GiB), committed bytes at 68.58–68.78%, and paging at 0.5, 9.0 and 0 pages/sec. A preceding sample window at 23:35:02–23:35:06 had similar available memory (2,439–2,575 MiB) but transient paging of 24–213 pages/sec. Against the recorded 2–3 GiB Chromium + Next/browser planning envelope, available memory remains at its lower edge and does not establish safe headroom with noteOS Docker services still present. The Next app was not installed, built or started, and no Chromium worker was launched. No API response, browser sync state, local database contents, UI count, or 0/20 result was collected in this spike. The existing Watermelon initial-pull root cause remains unknown. Snapshot and running-container evidence: [`capacity-and-docker.txt`](../../artifacts/phase-00/document-engine/capacity-and-docker.txt).

After the Node run, a read-only `docker ps` showed noteOS Web, API, Redis and MySQL all **healthy**; `dev-hub-caddy` was running. PowerSync and MongoDB were not active. A read-only Docker events query returned no `oom` event in the previous hour. No Docker service, image, setting, database, or volume was changed for 00-B. This observation does not establish Docker VM free memory or per-container limits. The last controlled recovery record is [00-R.3](recovery-00-r.md#recovery-00-r3--controlled-workload-reduction-2026-10-20); its Docker VM memory reading was not remeasured for this run.

## Laravel contract tests

**Four tests: NOT RUN / BLOCKED.** The tests are in `api/tests/Feature/SyncPullContractTest.php` and use Laravel `RefreshDatabase`; `api/phpunit.xml` selects SQLite `:memory:` for isolation. Cases are: 20-fixture initial pull, empty initial pull, incremental update, and tombstone IDs. PHPUnit `11.5.57` is in `composer.lock` and `phpunit/phpunit` is a Composer `require-dev` dependency, but the existing API image runs `composer install --no-dev` and `composer dump-autoload --no-dev`; the running vendor tree therefore has no test runner. No Composer install, image build, API mutation, or test database operation was attempted. A follow-up test-only PHP 8.4 runtime with dev dependencies and SQLite support is needed; it should use the existing in-memory isolation and must not mount another project's data.

| Contract case | Result |
| --- | --- |
| Initial pull with 20 fixtures | NOT RUN |
| Initial pull with 0 fixtures | NOT RUN |
| Incremental update | NOT RUN |
| Tombstone / deleted IDs | NOT RUN |

## Native editor research

The checked-in Expo baseline is SDK `57.0.30`, React Native `0.86.0`, React `19.2.3`. Expo's compatibility table aligns SDK 57 with that RN/React pair. No Metro build, simulator, Xcode build, or real iPhone / iOS IME test ran.

| Candidate | Current package version checked 2026-10-20 | Fit and limits |
| --- | --- | --- |
| Native `TextInput` Quick Capture | Built-in React Native | Source-only prototype converts the current string to paragraph nodes while preserving whitespace and code points. Telex/VNI, Japanese IME composition, autocorrect, keyboard dismissal, and iOS persistence behavior remain untested. |
| `@10play/tentap-editor` | `1.1.0` | Full editor based on Tiptap/ProseMirror using a WebView bridge; upstream lists RN 0.74+ and WebView 13.7+ with Expo development-client/native rebuild requirements. Its architecture is the closest fit for shared ProseMirror JSON, but JSON serialization and the current SDK 57/RN 0.86 build were not verified here. Treat compatibility as a candidate, not a pass. |
| `@expensify/react-native-live-markdown` | `0.1.343` | Native TextInput with styled Markdown ranges and string value/change callbacks, not a ProseMirror JSON editor. Its compatibility matrix includes RN 0.79–0.86 and requires the New Architecture; it also adds Worklets / Expensify dependencies and a native rebuild, and is not an Expo Go validation path. Better suited to a Markdown-oriented capture surface with explicit conversion/loss handling than the canonical full rich editor. |

No native editor was selected. Real-device IME and keyboard evidence is still required. The Expo, Tiptap, TenTap and Live Markdown documentation used for this comparison is linked from [architecture-decisions.md](architecture-decisions.md#00-b--document-engine-and-editor-spike).

## Reproduction and limits

```powershell
Set-Location spikes/phase-00/gate1/web/packages/document-engine
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run benchmark
```

The browser and iPhone portions remain BLOCKED, not failed. No sync engine decision, Gate 1 PowerSync run, Gate 2 work, Phase 01 work, or other-project change occurred.

## Phase 00-B1 audit addendum (2026-10-21)

**Document integrity: PASS after focused validation fixes.** Schema v1 uses the configured Tiptap/ProseMirror `doc` root and the same node/mark extensions used by the editor. Unsupported schema versions, unknown nodes/marks at any depth, unknown fields, and unknown attributes return a non-editable result before the editor can open them. ProseMirror serialization normalizes attribute objects through a JSON round trip; repeated canonical JSON round trips are stable. Text content, marks, and supported attributes are retained. Plain-text conversion splits only on LF, retains empty lines, boundary whitespace, CR characters, Unicode code points, and combining sequences, and applies no Unicode normalization.

The audit found two missing lossy-export warnings and incomplete type checks for Tiptap attributes. Validation now rejects non-string/non-null ordered-list `type` and non-string/non-null Link `target`, `rel`, `class`, or `title`. Plain-text projection warns when it drops a code block language; Markdown warns when it cannot retain an ordered-list marker style. Unknown nested nodes and deeply nested marks are covered by fixtures and remain blocked without changing the source. These changes do not expand schema v1.

The source-only React Native Quick Capture imports `plainTextToCanonicalDocument` directly from the shared document-engine package. It emits the same `{schemaVersion:1,type:"doc",content:[...]}` structure, with each LF-separated line represented as a paragraph. This verifies shared source/contract wiring only; Metro bundling, IME composition, and native editing are not verified.

Regression suite: **30 passed, 0 failed** (Node built-in test runner). Added coverage for unknown nested nodes, deeply nested unknown marks, corrupt known attributes, actual Japanese Kanji/Kana, lossy export warnings, and batched read-only projection calls. Existing coverage verifies unsupported v2 read-only behavior, Vietnamese combining sequences, whitespace, and repeated JSON reloads. Exact B1 output: [`b1-node-test-output.txt`](../../artifacts/phase-00/document-engine/b1-node-test-output.txt).

**Browser gate: `CAPACITY_BLOCKED`; NOT RUN.** Read-only Windows samples at 07:05:40, 07:05:44 and 07:05:47 showed 1,524 / 1,512 / 1,531 MiB available, 70.78% / 70.95% / 70.77% committed, and 50.76 / 53.42 / 1.00 pages/sec. With about 1.5 GiB available and observed paging activity, no server, install, build, browser, or worker was started. No screenshot, browser console, edit/save/reload, unsupported UI, or browser Unicode evidence exists. Docker services were not queried during B1, so current container health is unverified; no Docker lifecycle/configuration action was taken. Raw samples: [`b1-capacity-snapshot.txt`](../../artifacts/phase-00/document-engine/b1-capacity-snapshot.txt).

### Native compatibility evidence

The checked-in baseline is Expo SDK 57.0.30, React Native 0.86.0, React 19.2.3. Expo's SDK 57 compatibility table specifies RN 0.86 and React 19.2.3 ([Expo SDK reference](https://docs.expo.dev/versions/latest/)). No native build or device validation ran.

| Candidate | Compatibility and data fit | Evidence boundary |
| --- | --- | --- |
| TenTap | A React Native rich-text editor based on Tiptap and ProseMirror; upstream documents New Architecture support from RN 0.73.5 and installation of `@10play/tentap-editor` plus `react-native-webview`, followed by iOS CocoaPods. Expo Go is limited to basic usage; broader use needs a development client and native rebuild. This is the closest architectural fit for ProseMirror JSON. | Tiptap itself exposes `getJSON()` ([persistence docs](https://tiptap.dev/docs/editor/core-concepts/persistence)), but upstream does not establish that this repository's schema v1 extensions, TenTap bridge round trip, or Expo SDK 57 app build work. No native package was installed or built. [TenTap README](https://github.com/10play/10tap-editor) |
| React Native Live Markdown | Native TextInput replacement with a string `value` / `onChangeText` API and parser-produced Markdown ranges; it is not a ProseMirror JSON document editor. Requires New Architecture, `react-native-worklets` >=0.7, `expensify-common` >=2.0.115, and `html-entities` 2.5.3 when using its default parser. It includes native code, needs an iOS pod install and rebuild, and does not support Expo Go. Upstream's matrix lists versions 0.1.331+ with RN 0.79-0.86, including this repo's RN 0.86 baseline. | The upstream describes native text selection, spellcheck, and autocomplete, but this does not verify Vietnamese Telex/VNI or Japanese IME composition in this app. It also does not establish canonical JSON preservation or Expo build success. [Live Markdown README](https://github.com/Expensify/react-native-live-markdown) |

**Laravel follow-up proposal (not run):** add a test-only PHP 8.4 CLI image/layer using the repository's existing `composer.lock` and `composer install` with development dependencies; do not run `composer update` or modify the production image. Include the locked PHPUnit version and `pdo_sqlite`/SQLite support. Run only `SyncPullContractTest` with `api/phpunit.xml`'s SQLite `:memory:` configuration, with no production or shared-project database mount. No image was built and the four contract cases remain NOT RUN.

**Recommendation:** complete Spike 00-B only after a safe single-worker Chromium run can verify create/edit/save/reload and unsupported read-only handling, then validate the test-only Laravel runtime. Do not infer browser or native PASS from Node evidence. Keep the sync engine and native editor undecided. No Gate 1 sync, Gate 2, Phase 01, Docker setting/service, volume, or other project was touched in B1.
