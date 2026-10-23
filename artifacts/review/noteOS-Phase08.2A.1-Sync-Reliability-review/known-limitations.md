# Known Limitations and Follow-up

- No physical iPhone or actual mobile browser hardware validation was available; the WebKit test used a 390×844 viewport.
- No real-data pilot, pairing, personal notes, or backup import was performed. Architecture review remains required before activation.
- Audio and timestamp anchors are local-only and are not synchronized. A separate privacy, quota, resumability, and recovery design is required before media transfer.
- Conflict resolution preserves local and remote versions and offers explicit retention as a separate local note. Reliable publication of the selected resolution across devices is not implemented; the local copy remains visibly pending/review.
- Browser versions and benchmark numbers are environment-specific synthetic measurements, not production SLOs.
- Build reported a Next.js workspace-root warning because the Phase 00 parent and web spike both contain lockfiles; build completed successfully.
