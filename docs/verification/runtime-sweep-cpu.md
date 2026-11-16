# Runtime sweep CPU and responsiveness

The user wants coordinator messages to remain responsive without saturating the Agent Loop process. The change reuses validated project documents and gives each task ownership of its pending cleanup and advancement. A slow cleanup no longer blocks other tasks, including subsequent polling rounds. Shutdown waits for that work before closing the database.

## Result

Five alternating runs per version used compiled JavaScript, Node 24.16.0, the same generated fixture, and the original 2-second execution poll. Each run lasted about 9 seconds. CPU time fell from a median 5,003 ms to 1,362 ms, a 72.8% reduction. The measured ranges were 4,478–5,196 ms before and 1,314–1,505 ms after.

| Measurement | Base median | Candidate median |
| --- | ---: | ---: |
| CPU as a fraction of one core | 55.6% | 15.1% |
| Idle-window CPU as a fraction of one core | 53.0% | 13.4% |
| First coordinator message receipt to execution | 541 ms | 36 ms |
| Scheduled message arrival to reply, all messages | 1,943 ms | 1,444 ms |

All ten runs completed five sweeps, three native executions and three exact replies. Each rejected three duplicate arrivals without duplicate execution or output. Persisted inbox, outbox and native receipt assertions passed with zero runtime diagnostics. The fixture has 73 tasks, 1,405 resolved historical inputs, project documents of approximately 474 KB and 113 KB, and 320 previously sent final outputs. It exercises all 72 project members as idle tasks; it is not a copy of production task statuses or native history.

Separate CPU profiles attributed about 3,007 ms to project-document reads before and 530 ms after. Repeated parsing and schema/history validation were the measured limiter. The remaining work includes reading metadata, cloning detached public snapshots and processing historical outputs. Profiled invocations are excluded from the timing comparison. The initial aspiration of an 80% reduction in whole idle CPU was not reached; the measured idle reduction is about 75%.

[Machine-readable results](runtime-sweep-cpu.json) contain every accepted trial, work counts, compiled source fingerprints and profile summaries. No production payloads are included.

## Behavior verification

- The full suite passed 651 tests. TypeScript checking and compilation passed.
- Project tests cover detached mutable snapshots, same-transaction reads, rollback, committed changes from another connection, and corruption after a warm cache read.
- The slow-cleanup regression fails on the base. The candidate delivers two successive coordinator replies while an unrelated cleanup remains blocked.
- The shutdown regression fails on the base with a closed-database access. The candidate drains the cleanup and permits a harmless tick after shutdown.
- Existing cleanup-admission, unknown-delivery, paused-task and recovery tests remain in the full suite.

## Reproduce

Build a separate checkout of base commit `e28324c87a71ada4149e5e0e7c468a6e39f85012`, and build the candidate. Run the candidate's harness against each compiled checkout. Use the same harness file for both sides.

```sh
npm run build
TMPDIR=/tmp node --import tsx scripts/benchmark-runtime.ts --compiled --source /path/to/base --label base --output /tmp/base.json
TMPDIR=/tmp node --import tsx scripts/benchmark-runtime.ts --compiled --source /path/to/candidate --label head --output /tmp/head.json
```

Alternate the two commands five times with unique output filenames. On macOS the reported trials used `caffeinate -i` to prevent idle system sleep during measurement. Capture profiles separately by adding `--profile /tmp/runtime.cpuprofile`. The optional `--shape revisions` adds revision history for correctness stress.

The local runtime binds a temporary Unix capability socket. A sandbox that prohibits local sockets fails before measurement and cannot produce an acceptance result. One early candidate preflight also had a 12-second timer gap and missing replies. It failed and was excluded; the cause of that scheduling gap was not established. Raw failures remain in the local measurement directory. All reported alternating trials used the same idle-sleep protection and completed the required work.

These results cover real AgentLoop scheduling, SQLite persistence, project validation and output flushing with fake Codex, Feishu and GitHub ports. They do not establish live-provider, Feishu tenant or deployed-service acceptance. Final-response discovery still follows the configured polling interval. No database schema or persisted task/thread identity changes are part of this patch.
