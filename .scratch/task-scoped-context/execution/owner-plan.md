# Implementation checkpoint

The implementation uses `RecordScope` with project, task(taskId), and coordinator variants. Legacy records retain absent scope. A caller projection filters every project read before pagination. Record responses are narrow acknowledgements. Project CAS and request fingerprints remain global.

`Activity` expresses running evidence or a need for full reconciliation. It has no delivery-history IDs. Full inspection remains mandatory for startup, terminal history and uncertain delivery. Exact turn and connection epoch bind tool callbacks, including callbacks before turn-start continuation.

`Supervision` persists enabled or paused independently of Task pause. Timer creation requires actionable workers. Only an unsent pending supervision input may be superseded, with an audit reason.

Units and checks:

1. Visibility, scope identity, legacy receipts. Add sentinel regressions and capture baseline failures, implement ledger/projection, run project tests.
2. Separate volatile additionalContext and stable instructions. Add wire/context regressions, implement dynamic context and activity checks, retain full reconciliation tests.
3. Persistent supervision and local timeout isolation. Add fixture regressions for pause/restart, healthy-thread approval preservation, late resume and lazy recovery.
4. Review diff manually before each narrow commit. Run typecheck, build and full test suite. Record exact results and residual limits.

Root owns workflow, specification, independent verification and merge. This owner does not spawn agents, operate live services, call models, access production state, or change the original conflicted checkout.
