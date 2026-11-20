# Baseline

Base commit: b053f4d0268e02213e07ea61d7a1cfa7db0049a3.

- npm run check passed.
- npm test ran 765 tests: 764 passed, 1 failed.
- The failure also reproduces when running only test/worker-execution-identity.test.ts. The case named “an adopted historical Worker blocks before unavailable saved resources can change its state” expects running but sees failed. The recovery path touches saved resources before the historical identity boundary. This predates the collaboration implementation.
- PR 66 changes the old report/final suppression path, which this specification replaces with distinct Agent and group tools. PR 68 changes closeout projection and dashboard presentation. Both were open at baseline inspection; neither branch was imported or modified.

Raw local logs: /tmp/agent-loop-collaboration-baseline.log and /tmp/agent-loop-collaboration-baseline-identity.log.
