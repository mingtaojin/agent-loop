# 协作工具实现与交付

## Workflow

- [x] Read the Principles section of the poteto-mode skill.
- [x] Phase A: Frame
- [x] Phase B: Design the workflow
- [x] Phase C: Run the loop
- [x] Phase D: Keep the audit trail
- [ ] Phase E: Verify and hand back

## Architect

- [x] Ground
- [x] Sketch
- [x] Agree
- [x] Implement
- [x] Scrap. skip: the chosen architecture did not require replacement.

## Arena

- [x] Frame
- [x] Fan out
- [x] Cross-judge
- [x] Pick
- [x] Graft
- [x] Verify

## Throughput checkpoint

- [x] Blocking first steps. Confirm baseline, current delivery and cleanup ownership, and two implementation sketches before changing runtime.
- [x] Independent workstreams. Tools and messaging, reminders, lifecycle and continuation use separate branches. Integrate shared Runtime and schema edits sequentially.
- [x] Shared mutable state. Keep application data and existing checkout untouched. Each writer owns an isolated worktree.
- [x] Smallest safe decomposition. Implement the approved eight behavior slices. One integration PR carries the coherent API migration, with focused commits and evidence per slice.

## Done predicate

All eight approved ticket behaviors are implemented, applicable automated tests and independent review pass, and the PR is merged into main. Live acceptance reports actual results or explicit environmental limits. No service deployment is part of this change.

## Scope and rigor

Eight tickets cover 44 user stories and 56 acceptance criteria. The main risk is persisted input delivery interacting with cleanup, pause and restart. Use real SQLite and filesystem tests, inspect the actual dynamic tool surface, then independently review the exact PR head before merging. User authorized a new dedicated test project and test groups for marker-only live acceptance. Use a fresh verifier on the exact integrated artifact. No production groups, service restart or group deletion is authorized.

## Units

- [x] Baseline and architectural synthesis.
- [x] Tickets 01–04. Explicit messages, group experience, self groups and prompt driven dispatch.
- [x] Ticket 05. Durable one-shot reminders.
- [x] Tickets 06–07. Independent cleanup and original Thread continuation.
- [x] Ticket 08. Full prompt migration and integrated acceptance.
- [ ] Independent review, PR checks and main merge.

## Publication checkpoint

All eight tickets, final automated checks and independent source/live acceptance passed. The decision-trail audit returned PASS+NOTES; its documentation flag was corrected. PR [70](https://github.com/mingtaojin/agent-loop/pull/70) targets main. This record is committed before the merge action. The authoritative final merge result is the PR state and merge commit, not a prefilled checkbox.
