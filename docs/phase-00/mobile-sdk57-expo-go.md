# Mobile prototype — Expo SDK 57 / Expo Go alignment

**Scope:** MVP-04.1 iPhone prototype under `spikes/phase-00/gate1/mobile` only. No Web application source, canonical schema, IndexedDB, recording recovery rules, revision checks, or backup contract changed.

## Result

| Gate | Status | Evidence |
|---|---|---|
| SDK and dependency alignment | PASS | Expo 57.0.31, React 19.2.3, React Native 0.86.3, and SDK 57 versions of the Expo modules listed below. `npm ls` and Expo Doctor showed no SDK 58 duplicates after correcting the stale `expo-asset` install. |
| Expo compatibility checks | PASS | `npx expo install --check` with `EXPO_OFFLINE=1`: “Dependencies are up to date” (the CLI warns offline validation is less reliable). `npx expo-doctor@latest`: 21/21 checks passed. |
| TypeScript | PASS | `npm run typecheck` |
| Automated prototype tests | PASS | `npm test`: 17 passed, 0 failed. |
| iOS JavaScript export | PASS | `npm run export:ios`: iOS bundle exported (3 MB, 943 modules). This is not a native build or device run. |
| Metro in Go mode | PASS | `npx expo start --go --lan --clear --port 8085`; Metro status endpoint returned `packager-status:running`, and the manifest reported `runtimeVersion: exposdk:57.0.0`. LAN host observed during this run: `192.168.20.170:8085`. Port 8081 was occupied by Docker, so port 8085 was selected explicitly. The captured command output did not include a visible QR image. |
| Physical iPhone launch and workflows | BLOCKED | No iPhone was connected to this session and no scan or on-device checks were performed. The user-reported Expo Go Client 57.0.9 was not independently inspected. |

## Dependency changes

| Package | SDK 57 version |
|---|---:|
| `expo` | 57.0.31 |
| `react` / `react-dom` | 19.2.3 |
| `react-native` | 0.86.3 |
| `expo-audio` | 57.0.5 |
| `expo-asset` | 57.0.20 |
| `expo-document-picker` | 57.0.3 |
| `expo-file-system` | 57.0.7 |
| `expo-sharing` | 57.0.24 |
| `expo-sqlite` | 57.0.4 |
| `react-native-safe-area-context` | 5.7.0 |
| `react-native-screens` | 4.26.2 |
| `@types/react` | 19.2.18 (satisfies `~19.2.0`) |

Expo CLI selected compatible versions and added `expo-asset` as a direct dependency after the first bundle exposed a stale SDK 58 copy. This also removed the duplicate SDK 58 asset/constants modules. The app already used SDK 57-compatible SQLite exclusive transactions, `File`/`Paths`, document picker and sharing calls, audio permission APIs, and `directory: 'document'`; no compatibility edits to those behaviors were needed.

## Expo Go limits and device evidence

The app config no longer includes the `expo-dev-client` plugin, and `start` now runs `expo start --go`. The native-only command is named `ios:native-build-only`.

`expo-file-system` remains configured with `enableFileSharing`. This changes native iOS document-sharing entitlements when a native project is built; Expo Go is a fixed native binary and cannot apply that configuration. Therefore Files-app access to the app's document directory is not claimed for Expo Go. The app's in-app backup share sheet uses the Expo Go included `expo-sharing` module and is a separate capability. The audio, sharing, SQLite, and asset config plugins affect native builds only; they do not change the Expo Go binary.

Expo's current [SDK mismatch guidance](https://docs.expo.dev/troubleshooting/expo-go-version-mismatch/) says the iOS App Store Expo Go stops at SDK 54 and SDK 55+ builds are not available there. The [SDK 57 release notes](https://expo.dev/changelog/sdk-57) state that an SDK 57 Go build is available separately for iOS. The supplied Client 57.0.9 may be such a build, but its provenance and compatibility were not verified here. Expo documents that [Expo Go cannot add custom native code or configuration](https://docs.expo.dev/faq/). A physical scan is required to establish that this exact client accepts the SDK 57 manifest and that native features work.

Still unverified on a real iPhone: initial launch, home/editor navigation, create/edit, pin/tags, restart persistence, JSON import/export, microphone permission, record/stop/play/export/delete, interruptions, and recovery. Keep the audio/native gate BLOCKED until these are exercised on device; the export and Metro results are not substitutes.

## Reproduction and rollback

Use Node 22.13 or later (this run used Node 24.21.0). From the mobile directory:

```sh
npm ci
npx expo install --check
npx expo-doctor@latest
npm run typecheck
npm test
npm run export:ios
npx expo start --go --lan --clear --port 8085
```

The online `expo install --check` attempt could not establish TLS to Expo's service; the offline check and local Expo Doctor both passed. `npm install` reported 15 high-severity advisories; no audit auto-fix was run because it can make unrelated dependency changes.

To roll back the alignment commit, use `git revert <alignment-commit>` and run `npm ci` in the mobile directory with a compatible Node version. This restores the prior tracked manifest, lockfile, and config without clearing app or database data.
