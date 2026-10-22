# Security review — Phase 08.1 changed scope

Scope: enrollment, device sessions, private metadata, preview, SQLite persistence and proxy routing. Code and isolated production-runtime tests; no personal note fixture or destructive production test.

## Activation gate remains closed

Read-only local Tailscale inspection preserved both Serve mappings (:443 -> 15800, :8443 -> 15700), each reported tailnet-only. No Funnel, public bind or policy edit was added. The effective network-map packet filter includes the entire Tailscale IPv6 range as a source with wildcard destinations/all ports. This is broader than an owner-approved-device allowlist. The admin policy source and approval of all members/devices were not verified. No claim is made that an unapproved device was actually observed reaching the app. Real-data API remains disabled.

Local full-backup verification is also pending. Synthetic tests do not clear that gate.

## Implemented defenses

Owner-local CLI issues a random 72-bit one-time pairing code, valid for 120 seconds, displayed only to an interactive terminal. Only its SHA-256 hash is stored. A writer transaction commits one-time redemption and device enrollment together. Five attempts per code and ten per 120-second global window are persisted across new codes/restarts. Device tokens are random 256-bit values, stored only as hashes, expire after 30 days and are checked for revocation on every private request. Owner CLI can revoke any device; browser endpoint revokes only its own session.

Browser credentials use HttpOnly, SameSite=Strict, host-only cookies scoped to the private API path. HTTPS uses Secure and a __Secure-prefixed name; loopback HTTP has a separate development cookie. No token is returned in JSON, query strings, localStorage, logs or screenshots. Browser POSTs require exact configured Origin, allowlisted Host, same-origin fetch metadata when supplied, JSON content type and a custom header. No permissive CORS is configured. All metadata reads require a valid device session. Responses are no-store/nosniff; error bodies omit SQL, paths and request data. Bounded JSON and exact fields reduce parser/preview resource exposure. Canonical SQL inputs use parameter binding. Runtime is non-root.

## Residual risks and findings

- Activation blocker: broad effective Tailnet acceptance and incomplete device/backup approval. Scope access grants manually before enabling; existing policies were not changed.
- Cookies are scoped by hostname/path, not TCP port. The other application at :443 shares the Tailscale hostname with noteOS :8443. Treat it as part of the cookie trust boundary; it could receive a matching-path cookie. Before activation, approve that trust or arrange an independently isolated hostname through architectural review. No Serve mapping was changed in this phase.
- Same-origin script compromise/XSS can still act using an HttpOnly session. This milestone does not eliminate CSRF/XSS or add E2EE.
- Global pairing limits intentionally trade brute-force resistance for possible enrollment denial by another allowed Tailnet client; the service is personal and disabled by default.
- node:sqlite is experimental in Node 22.21.1. The driver is tested in the actual Alpine image, but future production activation still needs architecture review and backup/recovery validation.
- `npm audit` reports two pre-existing moderate dependency entries: @babel/runtime and historical @nozbe/watermelondb. New sync handlers do not import WatermelonDB. No automatic upgrade or audit fix was applied; this is not a clean dependency audit claim.

No critical/high code finding was confirmed in the implemented preview/auth paths by the performed tests. This is bounded evidence, not a claim of complete application security. Physical iPhone/Expo credential and backup checks remain pending.
