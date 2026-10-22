# Phase 06 UTF-8 Audit

All changed text files were read and decoded as strict UTF-8 with Python `bytes.decode("utf-8", errors="strict")` on 2026-10-22. Binary screenshots were excluded from text decoding.

**Result:** PASS — 24 text files.

## Files

- `docs/phase-06/acceptance-report.md`
- `docs/phase-06/evidence/browser-results.json`
- `docs/phase-06/evidence/editor-browser.txt`
- `docs/phase-06/evidence/expo-doctor.txt`
- `docs/phase-06/evidence/expo-install-check.txt`
- `docs/phase-06/evidence/ios-export.txt`
- `docs/phase-06/utf8-audit.md`
- `spikes/phase-00/gate1/mobile/App.tsx`
- `spikes/phase-00/gate1/mobile/archive-store.mjs`
- `spikes/phase-00/gate1/mobile/archive-v2-native.mjs`
- `spikes/phase-00/gate1/mobile/audio-anchor-store.mjs`
- `spikes/phase-00/gate1/mobile/mobile-safety.mjs`
- `spikes/phase-00/gate1/mobile/store.ts`
- `spikes/phase-00/gate1/mobile/tests/archive-v2-native.test.mjs`
- `spikes/phase-00/gate1/mobile/tests/audio-anchor-store.test.mjs`
- `spikes/phase-00/gate1/mobile/tests/mvp04-1-safety.test.mjs`
- `spikes/phase-00/gate1/web/app/globals.css`
- `spikes/phase-00/gate1/web/app/lib/archive-v2.mjs`
- `spikes/phase-00/gate1/web/app/lib/archive-v2.test.mjs`
- `spikes/phase-00/gate1/web/app/lib/audio-anchors.mjs`
- `spikes/phase-00/gate1/web/app/lib/audio-anchors.test.mjs`
- `spikes/phase-00/gate1/web/app/lib/local-notes.js`
- `spikes/phase-00/gate1/web/app/ui/audio-recorder.tsx`
- `spikes/phase-00/gate1/web/scripts/mvp-02-browser.mjs`
