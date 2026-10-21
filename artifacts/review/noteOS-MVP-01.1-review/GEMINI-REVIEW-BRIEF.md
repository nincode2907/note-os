# Independent review brief — noteOS MVP-01.1

Review the supplied report and patch as an independent code reviewer. The approved scope is MVP-01 local-first Web quality acceptance. Do not choose a Sync Engine, reopen architecture decisions, or propose MVP-02/Phase 01 work as part of this review.

Focus on correctness and risks Codex may have missed:

1. **IndexedDB durability and concurrency:** transaction boundaries, expected revisions, multi-tab races, deletion after a concurrent restore, and behavior when records disappear.
2. **Autosave and recovery journal:** ordering of local journal writes and IndexedDB saves, stale-revision handling, failed-write recovery, and whether user drafts can be silently discarded.
3. **Permanent deletion and backup safety:** whether deletion is gated on the intended lifecycle/revision, whether the backup wording overstates protection, and whether the UI distinguishes a download request from a saved copy.
4. **Import/export integrity:** complete validation before writes, collisions, malformed documents, future schema preservation, and unsupported data opening read-only.
5. **Canonical document validation:** especially empty-document normalization and whether unknown schema content remains byte/value-preserved when opened.
6. **Privacy/offline claims:** whether core Web note workflows depend on external services or disclose note content; distinguish static code evidence from the browser test that blocked non-loopback requests.
7. **Release limits:** audit finding for WatermelonDB `0.28.0`, missing real-iPhone and full OS-offline evidence, untested storage eviction/quota, and the simulated rather than process-kill recovery test.

Return:

- Findings ranked by severity with file/line references and concrete impact.
- Any false PASS claim or missing evidence.
- Minimal fixes needed before accepting MVP-01.1.
- Whether the documented limits are acceptable for a single-device Web MVP handoff.

Do not claim runtime verification beyond the supplied logs/screenshots. Do not assume you can access the original repository or run new workloads; the ZIP is the complete review artifact.
