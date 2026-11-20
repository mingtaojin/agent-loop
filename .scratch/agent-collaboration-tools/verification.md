# Collaboration verification

Runtime candidate: ece0b569a7765a6f559f8fdf8d0604abc9491772.

## Automated checks

- TypeScript check and build passed after all implementation slices were integrated. The compiled CLI help runs.
- Messaging plus reminder integration passed 150 tests.
- Lifecycle, messaging, reminders and Worker identity integration passed 174 tests.
- Full serial suite passed 769 tests after raising only the fake daemon fixture request budget from one to five seconds. Product timeouts are unchanged. The intermittent case passed alone on both baseline and head.
- Independent source review found three continuation edge cases. All six new regression scenarios failed before the fix and passed after it. The corrected candidate passed 202 related tests and the complete serial suite of 775 tests, with no failures or skips. TypeScript check, build and compiled CLI help also passed. Independent re-review returned PASS+NOTES. The real model and Feishu acceptance also returned PASS+NOTES; the notes are the explicit scope limits below.

## Ticket evidence map

| Ticket | Evidence and observed behavior |
| --- | --- |
| 01 Agent messages | `test/project-runtime.test.ts` covers native sends while the sender continues, recipient start and steer, transactional acceptance, lost acknowledgements, references and routing boundaries. `test/project-codex.test.ts` checks authenticated native tools and rejects retired actions. |
| 02 Human group messages | `test/project-runtime.test.ts` covers explicit coordinator replies, ordinary Worker output, uncertainty and destination binding. Real provider acceptance passed; see acceptance.md. |
| 03 Worker groups | Runtime tests cover concurrent coordinator and Worker creation, reuse, unknown creation results, missing groups and unchanged Worker input routing. |
| 04 Dispatch | Runtime tests cover Feature dispatch without business authorization fields, preserving supplied scope, migration of old receipts and immediate dispatch/message. Worker identity suites retain configured profile and ownership checks. |
| 05 Reminders | `test/reminders.test.ts` covers idle and running recipients, cancellation races, atomic firing and input insertion, lost acknowledgements, restart, pause, owner boundaries and no implicit periodic work. |
| 06 Completion and cleanup | `test/task-closeout.test.ts` uses actual files, Git worktrees and child processes to verify completion preserves resources, explicit cleanup, stale resource identities, shared paths, interrupted deletion and replacement generations. |
| 07 Continuation | Closeout tests cover original Worker and Thread continuation, attachments, completion history, pause, reminders, cleanup races and reacquisition. Additional regressions cover failed turns with recovery disabled, queued input before completion while paused, and delayed provider timestamps. They pass while historical migration suppression remains intact. |
| 08 Combined migration | Runtime tests preserve legacy members, Thread, group, native approvals, execution identity and records; retired automatic inputs retain reconciliation state without replay. `test/project-codex.test.ts` exercises role updates on resume. The retained Thread CLI test invokes named tools after restart. Real model/provider acceptance passed; see acceptance.md. |

## Independent acceptance

The first real Codex and Feishu run used dedicated groups and preserved production data and services. It proved no-group Worker messaging while its original turn was active, coordinator record and explicit group response, Worker self-group creation, and reminder follow-up. It stopped on a coordinator completion call excluded by the marker-only fixture. The coordinator also omitted the required hidden final marker, while the Worker inherited that coordinator-only marker. The run stopped before the synthetic direct question was injected, so those predicates were not established by the first attempt. This is a failed acceptance run, not a full pass. The fixture now keeps tasks open explicitly, delimits role-specific instructions, parses the observed shell command wrapper and preserves failure readback. The fresh independent run passed on the corrected candidate. The runtime restrictions are unchanged by those fixture corrections.

Evidence: `/tmp/agent-loop-collaboration-live-680e3da/summary.json` and companion JSON files. Committed test summary: [test-results.txt](test-results.txt). Final full suite log: `/tmp/agent-loop-collaboration-final-full.log`. Regression reproduction: `/tmp/lifecycle-review-reproduced.log`. Source review: `/tmp/agent-loop-correctness-review.out`.

Baseline and author branch results are recorded in [baseline.md](baseline.md) and [decisions.tsv](decisions.tsv). The synthetic direct question verifies routing through `AgentLoop.receive`; it does not claim a real owner webhook. Migration, pause/restart races, continuation and cleanup use controlled integration tests, not the live marker probe.

## Final independent results

- GPT-6 Astra [source review](source-review.md) passed with scope notes at ece0b56. It rechecked all three continuation fixes, failed attachment retries, legacy suppression and probe corrections. Source review did not claim runtime execution.
- GPT-6.1 Sol independently ran real Codex and Feishu acceptance at the same runtime SHA and returned PASS+NOTES. All 13 provider receipts matched actual readback, six markers appeared once each, and SQLite integrity passed. See [acceptance.md](acceptance.md) for timestamps, group IDs, message receipts and the exact command.
- Actual HTTP and Chromium dashboard checks passed at this SHA. The model and chat adapters were fake only in this separate dashboard lane.
- Production services and data were not changed. The four groups from both attempts remain retained. Probe processes and the dashboard listener were confirmed closed.

The live lane does not claim real owner webhook delivery, production deployment or live migration. Controlled regression tests cover migration, pause/restart, continuation and resource cleanup. Subsequent evidence-only commits must preserve the reviewed runtime and prompt build bytes before merge.

The GPT-6.2 Astra decision-trail audit returned PASS+NOTES. Its one documentation flag was resolved by adding those first-run omissions above. See [trail-review.md](trail-review.md).
