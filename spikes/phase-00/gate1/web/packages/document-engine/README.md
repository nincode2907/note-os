# noteOS document engine spike

Phase 00-B prototype for a versioned ProseMirror/Tiptap canonical document. It is isolated under the Gate 1 web workspace; it does not alter sync services or Compose profiles.

## Contract

Persist `{ "schemaVersion": 1, "type": "doc", "content": [...] }`. The ProseMirror JSON `doc` is canonical. Supported nodes are paragraph, heading, blockquote, bullet/ordered lists, task list/items, code block, hard break, text, and the spike-only inline `attachmentReference`. Supported marks are bold, italic, strike, and link. The attachment node stores only an opaque ID and display label; it does not imply bytes, upload, storage, or privacy behavior.

Schema validation rejects malformed trees and unsafe link protocols. Future versions, unknown nodes/marks, and unknown fields or attributes return `unsupported` and are not editable. Plain text and Markdown are derived projections; projections surface loss warnings. Checklist Markdown uses the GFM extension. The browser route saves canonical JSON to a spike-specific localStorage key; this has not been browser-tested.

## Reproduction

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run benchmark
```

Tests use Node's built-in runner and do not need MySQL, Laravel, Docker, or a browser. The benchmark covers 100, 1,000, and 5,000 word single-paragraph documents with 5 warmups and 30 measured iterations per operation. Its JSON encode/decode measurement is a local-save proxy, not a browser localStorage benchmark.

## Web / mobile prototypes

- Web route: `/editor` in the Gate 1 Next app. Browser start/build is intentionally not part of this run due the available-memory gate.
- iPhone Quick Capture source: `spikes/phase-00/gate1/mobile/document-engine-prototype/QuickCapture.tsx`. It uses a multiline native `TextInput` and the pure text converter. No Metro, simulator, Xcode, or real iPhone run was performed.
