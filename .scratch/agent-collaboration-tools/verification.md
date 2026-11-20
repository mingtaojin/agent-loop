# Collaboration verification

Runtime candidate before review fixes: 680e3dabb9292ada2480a6d81a77385593e023c4.

## Automated checks

- TypeScript check and build passed after all implementation slices were integrated. The compiled CLI help runs.
- Messaging plus reminder integration passed 150 tests.
- Lifecycle, messaging, reminders and Worker identity integration passed 174 tests.
- Full serial suite passed 769 tests after raising only the fake daemon fixture request budget from one to five seconds. Product timeouts are unchanged. The intermittent case passed alone on both baseline and head.
- Independent source review found three continuation edge cases. Regression tests and fixes are in progress, so the current candidate is not merge-ready.

## Ticket evidence map

| Ticket | Evidence and observed behavior |
| --- | --- |
| 01 Agent messages | `test/project-runtime.test.ts` covers native sends while the sender continues, recipient start and steer, transactional acceptance, lost acknowledgements, references and routing boundaries. `test/project-codex.test.ts` checks authenticated native tools and rejects retired actions. |
| 02 Human group messages | `test/project-runtime.test.ts` covers explicit coordinator replies, ordinary Worker output, uncertainty and destination binding. Real provider acceptance remains pending below. |
| 03 Worker groups | Runtime tests cover concurrent coordinator and Worker creation, reuse, unknown creation results, missing groups and unchanged Worker input routing. |
| 04 Dispatch | Runtime tests cover Feature dispatch without business authorization fields, preserving supplied scope, migration of old receipts and immediate dispatch/message. Worker identity suites retain configured profile and ownership checks. |
| 05 Reminders | `test/reminders.test.ts` covers idle and running recipients, cancellation races, atomic firing and input insertion, lost acknowledgements, restart, pause, owner boundaries and no implicit periodic work. |
| 06 Completion and cleanup | `test/task-closeout.test.ts` uses actual files, Git worktrees and child processes to verify completion preserves resources, explicit cleanup, stale resource identities, shared paths, interrupted deletion and replacement generations. |
| 07 Continuation | Closeout tests cover original Worker and Thread continuation, attachments, completion history, pause, reminders, cleanup races and reacquisition. Three additional edge cases from source review are being fixed before approval. |
| 08 Combined migration | Runtime tests preserve legacy members, Thread, group, native approvals, execution identity and records; retired automatic inputs retain reconciliation state without replay. `test/project-codex.test.ts` exercises role updates on resume. The retained Thread CLI test invokes named tools after restart. Real model/provider acceptance remains pending. |

## Independent acceptance

The first real Codex and Feishu run used dedicated groups and preserved production data and services. It proved no-group Worker messaging while its original turn was active, coordinator record and explicit group response, Worker self-group creation, and reminder follow-up. It stopped on a coordinator completion call excluded by the marker-only fixture. This is a failed acceptance run, not a full pass. The fixture is being corrected to keep tasks open explicitly, delimit role-specific instructions and parse the observed shell command wrapper. The runtime restrictions are unchanged by those fixture corrections.

Evidence: `/tmp/agent-loop-collaboration-live-680e3da/summary.json` and companion JSON files. Full suite log: `/tmp/agent-loop-collaboration-full.log`. Source review: `/tmp/agent-loop-correctness-review.out`.

Baseline and author branch results are recorded in [baseline.md](baseline.md) and [decisions.tsv](decisions.tsv). The synthetic direct question verifies routing through `AgentLoop.receive`; it does not claim a real owner webhook. Migration, pause/restart races, continuation and cleanup use controlled integration tests, not the live marker probe.
