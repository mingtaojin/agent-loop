# Implementation checkpoint

The implementation uses `RecordScope` with project, task(taskId), and coordinator variants. Legacy records retain absent scope. A caller projection filters every project read before pagination. Record responses are narrow acknowledgements. Project CAS and request fingerprints remain global.

`Activity` expresses running evidence or a need for full reconciliation. It has no delivery-history IDs. Full inspection remains mandatory for startup, terminal history and uncertain delivery. Exact turn and connection epoch bind tool callbacks, including callbacks before turn-start continuation.

PR #28 supersedes the earlier unreleased supervision pause plan. Coordination uses explicit events only. Remove its timer generator, supervision action/state and superseded inbox status. Keep upstream strict retirement to dropped for definitely undelivered generated copies and preserve attempted-delivery evidence. Task pause remains unchanged.

Units and checks:

1. Visibility, scope identity, legacy receipts. Add sentinel regressions and capture baseline failures, implement ledger/projection, run project tests.
2. Separate volatile additionalContext and stable instructions. Add wire/context regressions, implement dynamic context and activity checks, retain full reconciliation tests.
3. Event-only coordination and local timeout isolation. Keep upstream event and retirement tests, Task pause/restart, healthy-thread approval preservation, late resume and lazy recovery. Correct the native probe to distinguish retained intakes from authorized execution.
4. Review diff manually before each narrow commit. Run typecheck, build and full test suite. Record exact results and residual limits.

The integration owner updates the scoped specification, ADR, glossary and local design to match PR #28. Root owns workflow, independent verification and GitHub delivery/merge. This owner does not spawn agents, operate live services, call models, access production state, or change the original conflicted checkout.
