# Physical-device acceptance — pending

No real iPhone result is claimed. Before production Audio Sync can be enabled, the owner should test with disposable notes and audio:

1. iPhone Safari/PWA over cellular with Tailscale active; confirm HTTPS and pairing.
2. Create a normal note with no privacy level; explicitly authorize only that note for `PRIVATE_SERVER` text Sync.
3. Confirm the Mac acknowledges the privacy value before the iPhone offers audio approval.
4. Attach a short disposable recording, separately approve audio, and confirm upload/download by hash between iPhone Safari and Mac Chrome.
5. Repeat with an already attached local recording; verify the text-only authorization reaches the server without uploading audio early.
6. Remove a local downloaded chunk, reload, reconnect, and verify recovery without duplicates.
7. Repeat a recovery with network loss; verify resume after reconnect.
8. Make offline metadata/bookmark edits on both devices; confirm conflict review retains both sets of bookmarks.
9. Verify `DEVICE_ONLY` stays local unless explicitly changed and that no other note enrolls.
10. Verify persistence after Safari reload and app restart; do not claim Docker restart unless tested separately.

Production Audio Sync stays OFF until this physical acceptance is recorded.
