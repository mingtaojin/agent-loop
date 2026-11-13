# Owner verification

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
