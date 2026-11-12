# Feishu approval callback acceptance

Date: 2026-11-12. Related issue: [#1](https://github.com/mingtaojin/agent-loop/issues/1).

## Verified behavior

The installed SDK returned code500 without a toast when the old handler rejected a duplicate action. The repaired handler returns code200 with an explicit error toast. A successful action still waits for durable receipt before it returns an information toast and a receipt card without buttons.

The owner clicked fresh cards in their actual Feishu client. The test used the candidate adapter's primary WS connection and a separate real Runtime, SQLite store and native Codex instance. Only exact marker commands in an isolated directory were permitted. The production approval policy was not changed.

| Case | Server and native result |
| --- | --- |
| Approve | One confirmed approve row, command completed with exit0, one exact marker occurrence. |
| Reject | One confirmed reject row, native command declined, no reject marker. |
| Expired card | Explicit error toast, no new decision or command effect. |
| Injected handler failure | Explicit error toast, no new decision or command effect. |
| Controlled duplicate replay | Explicit error toast, no additional row or marker occurrence. |

The owner confirmed no timeout and removed buttons on the approve/reject receipt cards. Direct read-only database and marker inspection was reproduced by a fresh verifier. The duplicate replay was synthetic and was not counted as another genuine approve click. The injected failure used completed request keys and was not a physical SQLite fault.

The bot message API did not expose the owner's updated card view. Its readback was recorded as a limitation; the owner's observation and returned receipt payload were kept separate.

The initial candidate passed 380 compiled tests and the build. That result belongs to the original accepted candidate. Integration checks on the PR's current base are recorded separately in the PR. Temporary acceptance instrumentation was removed after the real-client run.

## Remaining evidence limit

The original incident has no correlated callback arrival, response or transport timing. The reproduced exception path and the successful acceptance run do not identify its unique historical cause. Global database busy-timeout policy is unchanged.
