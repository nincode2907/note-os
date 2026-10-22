# Phase 03 — iPhone rich-text editor parity

## Status

**Source and automated checks: PASS. Physical iPhone acceptance: PENDING USER VALIDATION.** The repository now defaults to a bundled Tiptap editor for supported Canonical Document v1 notes. This work does not claim real-device keyboard, SQLite, audio, lifecycle, or Expo Go interaction results.

| Gate | Result | Evidence |
| --- | --- | --- |
| Canonical v1 editor bundle opens and edits a rich fixture | PASS | Local Chromium 156 browser check |
| Canonical marks, nested lists, task state and attachment references survive a snapshot | PASS | Browser check and bridge unit tests |
| Bridge size, session, type and generation validation | PASS | Mobile Node test suite |
| Snapshot waits for a composition session to end | PASS, simulated | Browser bridge check; not an iOS keyboard test |
| No external WebView requests | PASS | Local file browser check and restrictive CSP |
| Existing mobile unit tests and new bridge tests | PASS | 25/25 |
| TypeScript | PASS | `npm run typecheck` |
| Expo SDK dependency compatibility | PASS | `npm run expo-check` |
| Expo Doctor | PASS | 21/21 checks |
| iOS JavaScript and static asset export | PASS | `npm run export:ios` |
| iPhone Expo Go launch, input methods, SQLite and audio | PENDING | No Xcode, `simctl`, or connected iPhone was available to this runner |

## Architecture

- `react-native-webview@13.16.1` is the Expo SDK 57 recommended version and is listed as included in Expo Go by the [Expo SDK 57 WebView documentation](https://docs.expo.dev/versions/v57.0.0/sdk/webview/).
- `editor/webview-entry.js` calls the existing Web document engine's `createTiptapEditor`, so the Web and iPhone body editors use the same Canonical v1 extensions and validator. The bundled runtime does not create a second persisted document format.
- `npm run build:editor` bundles that runtime into `editor/canonical-editor.html`. Metro treats the generated HTML as a static asset. `CanonicalEditor.tsx` loads it from Expo's local asset URI with `expo-asset` and `expo-file-system`, then passes the inlined document to WKWebView. The HTML includes the runtime inline, has no script or stylesheet URLs, and sets `connect-src 'none'`. WebView navigations are allowed only to `about:blank`.
- A WebView failure preserves the current JSON. Plain paragraphs and simple task lists can use the previous native fallback. Rich content stays visible read-only until the bundled editor is available.
- SQLite remains the write authority. Native code asks for a snapshot, validates the version, session, generation and canonical document, saves through `saveNote` with the existing revision CAS, and clears a same-revision recovery journal only after a successful note transaction. The database and its schema version were not changed.
- Recovery journals now contain the full canonical document. Draft writes remain debounced at 500 ms, are flushed on app background and navigation/save transitions, and stay available after a failed SQLite write. A pending save snapshot waits for composition to finish; edits received during the save prevent that snapshot from clearing a newer draft.
- Archived, trashed, unsupported schema, and unsupported canonical documents remain read-only. Audio, title, tags, pin, search, JSON V1 backup, and note lifecycle code remain on their existing native paths.

## Reproduce automated checks

From `spikes/phase-00/gate1/mobile`:

```sh
npm run build:editor
npm test
npm run test:editor-browser
npm run typecheck
npm run expo-check
npx expo-doctor
npm run export:ios
```

The browser check uses the local bundled HTML with a synthetic React Native bridge and the canonical rich fixture. It checks heading and code-block rendering, nested ordered lists, task toggles, bold formatting, a delayed snapshot during a simulated composition event, canonical snapshot validation, and zero external requests. It does not emulate iOS keyboards or native SQLite.

Expo Doctor initially hit an Expo API timeout; a retry completed with 21/21 checks. Expo Go support for the installed WebView package is documented by Expo, but the project was not opened in the SDK 57 iPhone client during this run.

`npm audit` reports 15 high advisories in the pinned Expo 57 / React Native 0.86 development toolchain and its Metro dependency tree. The newly added WebView 13.16.1 and esbuild 0.28.2 are not among the reported vulnerable packages. No audit fix or SDK change was applied because the approved implementation explicitly keeps SDK 57.

## Physical iPhone checklist — pending

The runner has command-line developer tools only; `xcrun simctl` and Xcode are unavailable. iPhone Mirroring opened to a lock screen requiring the Mac login password, which was not available for this run. The user's iPhone and Expo Go could not be accessed. Port 8085 is currently occupied by an existing Expo process for this project, and it was left running. Use that server if it has reloaded the current source; otherwise stop only that known project server when ready, check the port again, and then use the command below. Keep the gates pending until the user confirms each on the device:

1. From `spikes/phase-00/gate1/mobile`, start Metro with `npx expo start --go --lan --clear --port 8085`. Check `lsof -nP -iTCP:8085 -sTCP:LISTEN` first. If another process is listening, use that existing Expo server or select a free port; do not terminate it to make room.
2. Open a synthetic note and a rich Canonical v1 note. Verify headings, bold/italic/strike, links, lists with nesting, task checks, quotes, code blocks, and attachment-reference labels.
3. Enter Vietnamese with Telex, Japanese Hiragana/Katakana, and converted Kanji. Mix Vietnamese with English technical terms. In code blocks, enter and edit SQL and TypeScript.
4. Select and delete text across formatted runs. Press Enter in a task item. Move the cursor while the keyboard opens and use toolbar controls without losing the selection.
5. Save after formatting and after a checkbox change. Confirm revision advances once per successful save, then leave and reopen the note and confirm semantic JSON and checked states remain.
6. Make an unsaved formatted edit, background the app, reopen it and restore the offered draft. Repeat with navigation away and a failed/conflicting save where practical; confirm the recovery draft remains available.
7. Confirm an unsupported future schema and archived/trashed notes remain read-only and unchanged.
8. Record, stop, play, rename, and export a short synthetic audio recording. Confirm the navigation guard remains active while recording.
9. Export and re-import a synthetic JSON V1 notes backup. Confirm no Web Backup V2 or IndexedDB data changed.

Do not uninstall or reinstall Expo Go as a troubleshooting step; the app's local SQLite database is user data. No database reset or migration is part of this task.

## Revisions and limits

- Expo SDK `57.0.31`; React `19.2.3`; React Native `0.86.3`; `react-native-webview` `13.16.1`; Tiptap/document engine `3.32.0`.
- Browser runtime: Chromium `156.0.8078.4`, synthetic fixture only. There are no physical-device screenshots or logs in this report.
- WebView messages are capped at 2 MiB and the canonical validator remains the final schema and link-protocol check. Notes exceeding the bridge limit remain preserved and cannot be opened for editing in this WebView path.
- The 500 ms recovery debounce cannot guarantee the final keystroke survives an immediate OS kill or WebView process crash. Do not describe crash recovery as perfect until real termination behavior is exercised on iPhone.
- Physical Japanese/Vietnamese IME behavior, caret scrolling, Expo Go initialization, actual SQLite persistence and revision conflict, app background/reopen, audio recording, and archive/trash regression remain pending user validation.
