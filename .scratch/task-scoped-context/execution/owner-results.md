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
