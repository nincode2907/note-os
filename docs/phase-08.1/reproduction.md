# Reproduction with isolated synthetic data

From repository root, use Node 24 on the host only for Playwright tools. The application and SQLite tests run in the pinned Node 22 Alpine container. The old docker-compose.yml experimental stack must remain stopped.

```sh
docker build -f spikes/phase-00/gate1/web/Dockerfile -t noteos-web-phase081 spikes/phase-00/gate1/web
docker compose -f docker-compose.sync-foundation-test.yml up -d --wait
docker exec noteos-sync-foundation-test-web-1 node /verification/fixture.mjs init
docker exec noteos-sync-foundation-test-web-1 node /verification/fixture.mjs state
```

On a NEW test volume only, run `docker exec noteos-sync-foundation-test-web-1 node /verification/fixture.mjs seed`. It refuses to replace existing fixture records. Retain volumes; do not use volume rm or down -v. Use a separate named volume if a new isolated dataset is needed.

Run Node tests by mounting the Web source read-only at /app in a disposable Node 22.21.1-alpine container, working directory /app, capped at 768 MiB / 2 CPUs, with `node --test --test-concurrency=1 app/lib/*.test.mjs sync-server/*.test.mjs` then `npm run test:documents`.

Production-runtime persistence/routing/unavailable-volume verification: `node spikes/phase-00/gate1/web/scripts/sync-foundation-runtime.mjs` (recreates ONLY the synthetic container).

The browser harness needs the existing ui-lens Playwright installation and matching Chromium/WebKit binaries. Generate temporary localhost TLS files `/tmp/noteos-phase081-tls.key` and `.crt` using openssl; do not commit or archive the private key. Then run `node spikes/phase-00/gate1/web/scripts/sync-foundation-browser.mjs`. It uses new browser contexts, an ephemeral loopback-only HTTPS proxy, private capture of pairing codes and synthetic IndexedDB records. It writes screenshots/results without credentials.

For existing browser regression scripts set NOTEOS_TEST_URL=http://127.0.0.1:15720 and set each script’s NOTEOS_MVPxx_EVIDENCE directory to the review evidence directory. Run mvp-05-quick-capture-browser.mjs, mvp-03-browser.mjs and mvp-02-browser.mjs. The audio harness uses a fake Chromium microphone.

The strict live check takes NOTEOS_LIVE_HTTPS_URL equal to the discovered Tailscale URL. It must run with Mac Tailscale connected: `node spikes/phase-00/gate1/web/scripts/sync-foundation-live-check.mjs`. It expects the live API to remain disabled and never opens a personal browser profile. A stopped Tailnet/DNS prerequisite is PENDING rather than a passed HTTPS check.

After test evidence capture: `docker compose -f docker-compose.sync-foundation-test.yml stop web`. Keep the volume for review. See rollback.md for restoring ONLY the previous live Web image.
