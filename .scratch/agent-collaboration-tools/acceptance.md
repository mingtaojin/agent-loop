# Independent collaboration acceptance

PASS+NOTES for `ece0b569a7765a6f559f8fdf8d0604abc9491772`. A fresh verifier checked the real model and Feishu workflow, durable SQLite inputs, provider readback, and process shutdown.

The run used a clean detached checkout at `/Users/developer/IdeaProjects/agent-loop-collab-verify`. It started at `2026-11-20T22:09:16.574+08:00` and ended at `2026-11-20T22:13:28.110+08:00`.

```sh
npx --no-install tsx scripts/verify-collaboration.ts --config /Users/developer/IdeaProjects/agent-loop/config.json --env-file /Users/developer/IdeaProjects/agent-loop/.env --real-feishu --timeout-ms 600000 --evidence-dir /tmp/agent-loop-collaboration-live-ece0b56
```

The real lane used CodexAppServer, AgentLoop, SQLite, WorkspaceProvider, FeishuAdapter, and actual Feishu messages. Credentials came from the named configuration and environment file. Their contents are omitted. No production service, production database, existing group content, or Feishu WebSocket was used.

The observed sequence was:

1. One no-group Worker read the unique proof file and called `send_agent_message` once. The coordinator received durable input `agent-message:01997c7f3c7d6f4cb42c9e62d3f8cfc853ba31d82e73f1036e177fa07932e2b8` through `steer` at `2026-11-20T22:10:48.429+08:00` while the Worker original turn was active.
2. The coordinator recorded the marker at `2026-11-20T22:11:02.806+08:00`, before the Worker final. Its explicit ACK appeared in the coordinator group.
3. The Worker opened its own group. Ordinary commentary, question, and final text appeared once each without Worker `send_group_message` calls.
4. The coordinator scheduled one reminder for `2026-11-20T22:11:44.560+08:00`. It fired at `2026-11-20T22:11:44.771+08:00`, reached the original coordinator Thread, and triggered a record plus visible reminder reply.
5. A direct question injected through `AgentLoop.receive` triggered an explicit group reply. This input was synthetic. No real human webhook receipt is claimed.
6. Actual coordinator final answers contained the hidden marker, which was absent from both groups. The Worker did not copy that marker. Three repeated ticks created no extra calls or reminder inputs.

The new groups remain available for review:

| Role | Group name | Group ID |
| --- | --- | --- |
| Coordinator | Agent Loop 协作验收 1795183756574-2ec18db3 协调者 | `oc_fe058a81dfd7f4547ea2de1d05e58be6` |
| Worker | Agent Loop 协作验收 1795183756574-2ec18db3 Worker | `oc_6ea974c0c9f0efbb5622f68e9c3b8cf0` |

The independent Feishu readback found 15 messages and matched all 13 acknowledged provider receipts. Each marker below appeared exactly once:

| Marker | Provider message ID |
| --- | --- |
| `ACK_1795183756574-2ec18db3` | `om_x100b7f31010280a4b0795e239c78b8c` |
| `REMINDER_1795183756574-2ec18db3` | `om_x100b7f311995a8acb09f84a9e3da27d` |
| `DIRECT_REPLY_1795183756574-2ec18db3` | `om_x100b7f3116ec74a0cd03441667ac13c` |
| `WORKER_COMMENTARY_1795183756574-2ec18db3` | `om_x100b7f311e9650a4b3734484517a997` |
| `WORKER_QUESTION_1795183756574-2ec18db3` | `om_x100b7f311e797ca4ce77a578fc0ef1a` |
| `WORKER_FINAL_1795183756574-2ec18db3` | `om_x100b7f311e0f60accebcf96c0317589` |

The actual database contains two tasks, five delivered inputs, and one fired reminder. `PRAGMA integrity_check` returned `ok`. Source and fixture fingerprints match the run start. The checkout remains clean.

The separate dashboard check used the same source SHA, actual HTTP serving, Chromium, SQLite, and WorkspaceProvider with fake model and chat transports. It displayed `已记录完成，仍可继续` with `未请求清理`, then preserved the completion history while displaying `已清理` after removal of its temporary marker artifact. `dashboard-before.png` and `dashboard-after.png` record both rendered states.

The probe closed its Runtime and native process PIDs `52624`, `60795`. Direct PID checks found them absent. Chromium PID `52750` is absent, and `http://127.0.0.1:64122` has no listening socket. Test groups, Codex Threads, and the fixture remain retained.

The previous failed run remains separately recorded under `/tmp/agent-loop-collaboration-live-680e3da`. Its two test groups also remain retained.

Limits remain: the direct-question input was synthetic, and the live marker flow did not test old-data migration, pause or restart races, completed-task continuation, or resource cleanup. Dashboard acceptance used fake model and chat transports. This record does not claim deployment acceptance.

Raw evidence remains in `/tmp/agent-loop-collaboration-live-ece0b56`. `independent-verdict.json` indexes the proof, provider receipts, process checks, and raw files. `summary.json`, `calls.json`, `execution.json`, `runtime.json`, `database-independent.json`, `feishu-reconciled.json`, and `dashboard.json` contain the detailed evidence.
