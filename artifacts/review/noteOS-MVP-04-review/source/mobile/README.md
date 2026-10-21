# noteOS MVP-04 iPhone prototype (Phase 00 spike)

This is an isolated Expo application under the Phase 00 validation spike. It is not the production noteOS app and does not modify the Web database.

## Local setup

Requirements: Node.js 24, npm, full Xcode with iOS platform support, and an iPhone or iOS Simulator. SDK 58 currently uses a development build; Expo Go support is not assumed.

```sh
npm install
npm run expo-check
npm run start
```

For a simulator or attached iPhone, use a local Xcode Personal Team if available. Generate the native project with `npx expo prebuild --platform ios`, open the generated `.xcodeproj` under `ios/` in Xcode, select the Personal Team for the app target, and follow Xcode's local signing, device trust, and Developer Mode prompts. Then use `npm run ios`. No Apple credentials belong in this repository. Microphone access is requested only when Record is tapped.

## Prototype boundaries

- SQLite stores the complete note record and canonical document JSON. Writes compare the expected revision in one SQL `UPDATE`; imports are all-or-nothing on duplicate IDs.
- Shared Web canonical validation and `noteos.local-backup` v1 parser are imported from `../web`. Unknown/future documents remain readable and read-only.
- Native editing is limited to plain paragraphs and a single-level task list with plain text. Other valid schema-v1 rich-text structures stay read-only.
- Audio uses `expo-audio` with the app document directory selected, then verifies the finalized file before inserting `complete` metadata. If the app backgrounds while recording, it tries to stop and records an `interrupted` item. SQLite metadata and audio bytes are separate writes; abrupt termination can still require recovery.
- Notes backup contains no audio. Audio is shared separately.

## Available checks

```sh
npm run expo-check
npm run typecheck
npm test
npm run export:ios
```

The JS export does not build or launch iOS native code. Mark app installation, persistence across app restart, microphone behavior, device screenshots and hardware flows BLOCKED until Xcode and a simulator or physical iPhone are available.
