Status: ready-for-agent

# Worker group reply once

Version: 1.0, 2026-11-20.

The owner reported that one reply appeared twice in a task group and authorized investigation and repair. Source message `om_x100b60cad3b554b8c4b2cba1d5b3e75`, project group `oc_586b1866902382e0db4dff8d25c0f3f7`, sender `ou_5c280b16780ac4016c7455a276b2d95b`. Original text was “需要定位修复下这个问题,看着像是同一条消息往群里发送了两遍”. This source was checked in a read-only inbox query.

The screenshot matches model discussion task `281cb9db-aad5-4322-9dda-bedabc67bc5d`, task group `oc_d73a9b9860b485000b27f193de585cd1`. An intermediate report and a paraphrased ordinary final were independently published in one turn. Each has its own sent outbox row. This is separate publication identity, not a transport retry.

## Agreed scope

Coordinator instruction `duplicate-reply-explicit-identity-decision-v1` accepts a minimal explicit acknowledgement under the authorized bug repair scope. It is a coordinator technical judgment, not a new owner product authorization. Instruction `duplicate-reply-continue-implementation-v1` confirms implementation should continue.

Use one publication path for one answer. Ordinary terminal replies use final. A report receipt can guide a Worker to explicitly acknowledge an already accepted report when it has no new reply. The acknowledgement binds the original task, Thread, Turn and report request. It selects one exact prospective final for omission from chat. No visible protocol marker is required. All unmarked final prose remains deliverable.

## Acceptance

- Exercise the real local AgentLoop report receipt, native tool handler and capability bridge with fake external transports.
- A compliant report, acknowledgement and final produces one group publication through retries and restart.
- Report and acknowledgement admission preserve original binding after partial failure or a later-turn retry.
- Missing, malformed, stale, foreign-task, foreign-thread and foreign-turn references cannot suppress a legitimate final.
- A distinct final, including one after steering or after an acknowledged final, is still published.
- A report queued for delivery remains durable when the final is acknowledged. Failed or dropped reports cannot be mistaken for completed delivery. A queued receipt does not claim transport delivery.
- Native questions, permissions and approvals retain their existing identities and routing.

## Exclusions and limits

No text similarity classification or blanket final suppression. Historical unmarked report plus paraphrase remains two publications. No generic messaging protocol, live test messages, DB mutations, deletion, merge, deployment or service restart. Independent verification is arranged by the coordinator. Preserve other worktrees and the model selection task.

## Evidence

Thread `01a1f79c-d053-7942-9d37-245335533c92`, turn `01a1f7a4-b353-73a0-9abb-c071e28ded4a`.

- Report request `worker-model-discussion-round-3-v1`, tool call `call_J0abcnvpIy4JeTbbRKqkcY2Q`, at 2026-11-20T06:31:01.168Z. Sent outbox `829881d81fc491bcf057773000fc0f7d`.
- Final item `msg_0472062dcc870590016affe93d3ee487d185c1d0c564fd084f`, at 2026-11-20T06:31:28.655Z. Sent outbox `4d6d878746ae7f87ba6a5cf702c384f7`.
- Each ID equals the first 32 hex digits of sha256(taskId + ':' + its publication key). Keys are `worker-report:<requestId>` and `agent-output:<threadId>:<turnId>:<itemId>`.
- Outbox retains transport status but no remote Feishu message ID. These facts establish independent logical publications, not a count of network requests.
