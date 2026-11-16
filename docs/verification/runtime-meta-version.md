# Project metadata revisions and live CPU follow-up

Project lookups now check a small Store-owned revision token before reading a document. An unchanged document reuses its validated representation without copying or comparing the full persisted JSON string.

The earlier payload cache reduced validation cost, but live verification at the original 2-second poll still consumed 56.41 CPU seconds in a 60.21-second window. A fresh profile attributed 5.67 of 8.33 sampled seconds to project-document lookup. The earlier generated fixture used ASCII history text. Adding Chinese history text at approximately the same document byte sizes reproduced the expensive lookup on the previous commit.

## Correctness

Tokens are unique symbols in a bounded registry of at most 256 keys. Actual local metadata changes invalidate the affected key immediately. Rollback clears the registry even when rollback itself throws. Every lookup checks SQLite `data_version` for commits from another connection. Equal-value writes retain their token.

The ledger obtains a token before reading its payload. It never attaches a newly acquired token to an older read or to the input of `save()`. Changed data still crosses the full JSON/schema/identity validation boundary. Public mutable snapshots remain detached. Eviction only causes another read; it cannot make an old token valid again.

Tests cover own writes, rollback directly followed by another transaction, changes from an external SQLite connection, deletion, corruption, an external write during `save()`, and a commit between payload read and cache insertion. No database schema or task identity changes are required.

## Measurement

Five alternating pairs used the same compiled-runtime harness, generated Unicode fixture, 73 tasks, 1,405 historical inputs and the original 2-second poll. Both sides performed five sweeps, three exact native executions and replies, and three duplicate-input checks per run. All ten trials passed with zero errors or diagnostics.

| Measurement | Merged base | Candidate |
| --- | ---: | ---: |
| Median CPU time per approximately 9-second run | 5,747 ms | 713 ms |
| CPU time range | 5,427–5,981 ms | 688–814 ms |
| Median fraction of one CPU core | 63.0% | 7.9% |
| Median idle-window fraction of one core | 58.9% | 8.2% |
| Full project payload reads during the measured region | 6,480 | 0 |
| Median receipt-to-execution latency | 87.7 ms | 8.6 ms |
| Median scheduled-arrival-to-reply latency | 2,346 ms | 1,334 ms |

CPU time fell 87.6%. Zero full-payload reads is expected for this warm, unchanged project state. Exact output and persistence assertions verify that messages still execute. Separate profiles reduced inclusive project-document time from 4,902 ms to 23.7 ms. Those profiled runs are excluded from the comparison.

A separate private metadata probe verified 360 memberships in each of five alternating pairs. Median CPU time fell from 263 ms to 17.5 ms. Production payloads are retained only in private local artifacts and are not included here.

[Machine-readable public results](runtime-meta-version.json) contain the accepted trials, operation counts and compiled-source fingerprints. The full test suite and independent acceptance are recorded on the PR. These generated-port results do not establish live-provider or Feishu tenant acceptance; the deployed process must be measured separately at the original poll interval.

## Reproduce

Build a separate checkout of base `50ae416a083dc9bb78508ef6bf42499d115f47ac` and the candidate. Use the candidate's harness for both, with the same Node version and temporary-directory settings.

```sh
npm run build
TMPDIR=/tmp node --import tsx scripts/benchmark-runtime.ts --compiled --shape unicode --source /path/to/base --label base --output /tmp/base.json
TMPDIR=/tmp node --import tsx scripts/benchmark-runtime.ts --compiled --shape unicode --source /path/to/head --label head --output /tmp/head.json
```

Alternate at least five pairs. The recorded macOS runs used `caffeinate -i` to prevent idle system sleep. Capture a separate profile with `--profile /tmp/runtime.cpuprofile`. The harness uses real SQLite, scheduling, Unix sockets and output flushing, with fake external ports. Setup, warmup, correctness checking and cleanup are outside the timed region. Runtime instrumentation and fake-port work are included. Normal polling can still delay final-response discovery by up to a poll interval.
