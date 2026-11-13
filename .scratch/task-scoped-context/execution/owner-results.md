# Owner verification

## Record visibility

- Baseline `node --import tsx --test --test-name-pattern='task record sentinels|record acknowledgements sanitize' test/project-runtime.test.ts` failed both regressions. Task A text changed Task B instructions and appeared in Task B record response. Captured in `visibility-baseline-red.log`.
- After the scope and egress change, `node --import tsx --test test/project.test.ts test/project-runtime.test.ts` passed all 65 tests. Captured in `visibility-tests.log`.
- `npm run check` passed.
- Manual diff review before commit removed volatile records from stable instructions, preserved old record and receipt bytes, and checked scope defaults and composite record identity. No new dependencies or runtime state changes.
