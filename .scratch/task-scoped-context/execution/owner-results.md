# Owner verification

The sections before "Event-only integration" describe historical candidates. Their checks do not establish acceptance of the integrated source. PR #28 supersedes the unreleased supervision pause design.

## Record visibility

- Baseline `node --import tsx --test --test-name-pattern='task record sentinels|record acknowledgements sanitize' test/project-runtime.test.ts` failed both regressions. Task A text changed Task B instructions and appeared in Task B record response. Captured in `visibility-baseline-red.log`.
- After the scope and egress change, `node --import tsx --test test/project.test.ts test/project-runtime.test.ts` passed all 65 tests. Captured in `visibility-tests.log`.
- `npm run check` passed.
- Manual diff review before commit removed volatile records from stable instructions, preserved old record and receipt bytes, and checked scope defaults and composite record identity. No new dependencies or runtime state changes.

## Dynamic context and activity

- Baseline `node --import tsx --test --test-name-pattern='dynamic project callbacks validate|turn context is separate' test/project-codex.test.ts` failed. A real local child received a full-history read during tool validation, and start/steer omitted the supplied record context. Captured in `activity-baseline-red.log`.
- `node --import tsx --test test/project-codex.test.ts test/codex.test.ts test/runtime.test.ts test/project-runtime.test.ts test/service.test.ts test/workspace-selection.test.ts` passed all 248 tests. Captured in `activity-tests.log`.
- `npm run check` passed. The additional coordinator self-target case passed in `context-tests.log`.
- Coverage includes a callback before the start response, stale turn/epoch rejection, no record-only turns, separate delivery markers, native approval identity, unknown input reconciliation exactly once, and full startup inspection.
- Lead review found that an explicit task record addressed to the coordinator was omitted from its context. That target now appears only for the coordinator, with a focused regression.
- Manual diff review kept Activity distinct from history snapshots. Activity carries no seenInputIds and cannot publish terminal outputs or settle delivery. Dynamic and shell project actions recheck turn identity after entering their serialization lane.

## Supervision

- Baseline `node --import tsx --test --test-name-pattern='supervision does not wake' test/project-runtime.test.ts` failed with one timer input instead of zero for settled workers. Captured in `supervision-baseline-red.log`.
- `node --import tsx --test test/project.test.ts test/project-runtime.test.ts test/runtime.test.ts` passed all 106 tests after implementation, including receipt-write rollback and old pause replay after resume/restart.
- Project supervision is durable and independent of Task pause. Ordinary owner inputs remain accepted. Only pending timer inputs become superseded, with a reason. Delivering and uncertain timers retain their evidence.
- Manual diff review checked action authorization, atomic state/receipt persistence, and the input-preparation race before marking delivery.

## Timeout containment and thread recovery

- Baseline `node --import tsx --test test/codex-isolation.test.ts` failed its three original real-child scenarios. A read timeout invalidated healthy B, a resume timeout invalidated healthy B, and missing A rejected collective transport recovery. Captured in `timeout-baseline-red.log`.
- The focused Codex, project and Runtime run passed all 197 tests before the final two transport cases were added.
- Final transport coverage also reconciles an accepted start whose response timed out without sending a second start, and permits a definite resume failure to retry after its cause clears. Only unknown resume outcomes remain quarantined.
- ThreadLoad now distinguishes unloaded, pending, ready, uncertain and failed. A request timeout retains only the original resume completion handler. Actual exit, invalid protocol and write failure still invalidate the connection epoch. Recovery initializes the shared transport and loads original Threads on demand.
- Manual diff review checked late-response parsing, epoch checks after awaited history, exact callback identity, and bounded Runtime recovery. No health RPC, per-task process, input replay or automatic native approval was added.

## Final owner checks

- `npm run check` passed.
- `npm run build` passed.
- `npm test` passed all 555 tests, with zero failures, cancellations or skips. The complete output remains local in `execution/final-tests.log`.
- `git diff --check` passed.
- Final scope regression places distinct sentinels in records, Issue body/title, comments, outputs, native prompts, resources and intake material. B and verifier status sections exclude A data. Legacy record retry preserves the original document bytes.
- The role prompts and project guide document task defaults, explicit routing, global CAS, filtered paging, separate turn context, supervision pause and request-local timeout recovery.

## Limits and handoff

These are isolated SQLite Runtime tests and local protocol subprocess checks. No model, real Feishu group, live service, production database, remote machine or deployment was used. No speedup or incident-origin claim is made.

Existing Thread history is retained, so previously injected material is not erased. Scope filtering does not isolate files in a shared project directory. An unresolved resume timeout blocks only that Thread until its original response or a real transport replacement supplies a new epoch. Full startup and terminal reconciliation remain intentional.

Root owns independent final-head verification, specification/ADR/glossary completion, GitHub delivery and merge. Its two pending specification sentences remain unstaged by this owner. The original conflicted checkout was not changed.

## Unsettled-input supervision correction

- Reproduced the independent failure with `node /tmp/agent-loop-final-acceptance-20261114/unknown-only-supervision.mjs /Users/developer/.codex/worktrees/agent-loop-scoped-review-20261114`. The compiled 2bed8d64 artifact exited 1 and created one supervision reminder for an idle, completed worker with zero pending inputs, no requests, no scheduled recovery and one uncertain input. Evidence is in `/tmp/agent-loop-unknown-only-fix-20261114/baseline-external.log`. The original failure JSON and log are preserved there as `original-failure.json` and `original-failure.log`.
- Commit 23af787 adds delivering-only and uncertain-only regressions plus pending, running and scheduled-retry controls using the existing fixture. Before the fix, the two negative cases failed with `1 !== 0` while all three controls passed. Command was `node --import tsx --test --test-name-pattern='supervision does not wake for|supervision wakes for' test/project-runtime.test.ts`. Evidence is `regression-red.log` in the same temporary directory.
- `hasActionableWorker` now counts only pending queue inputs. Existing active execution, scheduled recovery and paused, failed or blocking-request exclusions retain their original predicates. Supervision does not change the worker Task, Thread, requests, resources, input IDs, status, provenance or delivery error. Delivering and uncertain input evidence remains available for Runtime reconciliation.
- `node --import tsx --test test/project.test.ts test/project-runtime.test.ts test/runtime.test.ts` passed all 112 tests. `npm run check` and `npm run build` passed. `npm test` passed all 560 tests with zero failures, cancellations or skips. `git diff --check` passed. Complete local outputs remain in `/tmp/agent-loop-unknown-only-fix-20261114` and are not committed.
- The unchanged external reproducer then ran against `/Users/developer/.codex/worktrees/agent-loop-task-scoped-context-20261113` and exited 0. It observed zero new reminders, an idle/completed worker, zero pending inputs and one uncertain input. New evidence is `fixed-external.log` and `fixed-external.json`. The reproducer SHA-256 remains `9c5dec4d9542a835d45592621d24aa5687e48a68f56e1fb152a4fe3d26e8c372`. Its original failure JSON was restored byte-for-byte after the run.
- This correction used only temporary local fixtures, SQLite and protocol subprocesses. No live service, production state, model, Feishu or remote machine was used. No deployment, push or merge was performed. Root still owns independent final-head verification and delivery.

## Event-only integration

The integration uses upstream commit 2e7be2eb77e899508e6e42b2cad952504ce85689, PR #28. Its accepted event-only architecture replaces the branch-only periodic supervision action, state, actionable-worker predicate and superseded inbox status. These were never deployed and are deleted rather than retained as compatibility APIs. RecordScope, stable instructions plus additionalContext, Activity, exact callback identity and request-local timeout recovery remain.

The seven merge conflicts were docs/project-coordinator.md, prompts/coordinator.md, prompts/worker.md, src/loop.ts, src/project-runtime.ts, src/store.ts and test/project-runtime.test.ts. Event routing, strict retirement identity checks and dropped terminal status follow upstream. Scoped record guidance, lightweight activity, history reconciliation and transport recovery remain from this branch. Upstream event tests remain intact. Spec, issue record, local design, ADR-0014 and glossary now reflect the supersession.

Independent native acceptance at 85040d8 failed before any model turn because the probe expected one total task after collection. The actual runtime correctly retained one execution coordinator plus three authorized unbound intakes for Issues 101, 102 and 104. The stale assertions existed in both cbd597e and PR #28. This was a probe failure, not quota, authentication or a runtime regression. Prior evidence remains at /tmp/agent-loop-final-acceptance-round2-20261114 and live-1794588948304-c9ef7ce5.

The corrected probe checks all original task/source identities, exact authorized execution membership and strict unbound/no-thread intake states. Initial collection requires pending; routed intakes may become idle while awaiting delegation. Only Issue 101 may be promoted; Issues 102 and 104 remain intakes. Idle and restart checks concern executions while checking remaining intakes separately. Existing native tool, marker, role, provenance, single-effect and read-only checks remain. A local runtime regression exercises collection, dispatch and restart and rejects extra tasks, hidden intake threads, substituted source identity and unauthorized promotion.

Throughput checkpoint: one owner writes this isolated worktree. Type checking precedes focused integration tests, adapter tests, build and the complete suite. No independent agent shares write access. Root owns the subsequent fixed-head compiled and native verification and GitHub delivery. No model, live service, production state, real Feishu, remote machine, push or deployment is authorized for this integration owner.

The first local probe regression rejected an existing valid transition. `routeSelectedIntake` sets a routed intake to idle while keeping it unbound and without a Thread or Turn. The probe now requires pending immediately after collection and permits only pending or idle afterward. This changes the probe assertion, not the Runtime. The first focused run failed on this assertion; the corrected run is recorded below.

### Integrated owner checks

- `npm run check` passed after the merge and probe correction.
- `npm run build` passed.
- `node --import tsx --test test/project.test.ts test/project-runtime.test.ts test/project-catalog.test.ts` passed all 128 tests. Output is local in `integration-project-tests.log`.
- `node --import tsx --test test/project-codex.test.ts test/codex.test.ts test/codex-isolation.test.ts test/runtime.test.ts test/service.test.ts test/workspace-selection.test.ts` passed all 210 tests. Output is local in `integration-adapter-tests.log`.
- `npm test` passed all 602 tests with zero failures, cancellations or skips. Output is local in `integration-full-tests.log`.
- `git diff --check` passed. A byte comparison against pinned upstream confirmed its appended event tests, `retireObsoleteInputs` implementation and complete `src/store.ts` remain unchanged.
- Manual diff review checked the seven conflict resolutions, retained scope and adapter changes, probe assertions, and documentation. No new source comments, dependencies, compatibility scheduler or generated logs are staged. Production source under `src` has 48 added and 89 removed lines relative to 85040d8, a net reduction of 41 lines.

The source checks above cover the integrated implementation, not real model acceptance or deployed behavior. The branch remains local for root to freeze and verify before PR delivery. The original conflicted checkout, frozen review checkout and root decisions.tsv were not changed. The local design file was updated in place and remains ignored, as before.
