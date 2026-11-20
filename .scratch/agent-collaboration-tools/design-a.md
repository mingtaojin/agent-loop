# Collaboration tools design A

This design implements the approved eight tickets as one final contract. Workers can proactively drive their coordinator. The AI decides workflow. Runtime owns identity, project boundaries, durable delivery, pause, and resource safety. This is a source-grounded sketch at `b053f4d`, not an implementation or acceptance result.

## Components

`project.ts` owns schemas for project management and the two new message tools. `ProjectRuntime` owns project membership, recipient authorization, stable operation receipts, and message acceptance. `Store` owns the existing inbox and outbox plus the new reminder rows. `AgentLoop` owns scheduling, execution admission, and transport reconciliation. `TaskGroups` owns group identity and creation recovery. `TaskCloseout` owns completion history and owned-resource cleanup, with separate commands for those concerns. The Codex adapter parses dynamic calls and verifies the active Thread, Turn, and connection epoch. The capability bridge authenticates its task before reaching the same runtime functions.

The existing input route is already the correct transport. `Store.receive` inserts a unique input ID. `AgentLoop.drain` steers a running Turn or starts a Turn on the saved Thread. It checks `seenInputIds` before resolving uncertain delivery. These are implemented at `src/store.ts:177` and `src/loop.ts:1110`. New messages and due reminders enter this route. They do not gain their own execution queue.

## Whole-shape alternatives

| Shape | Persistence and transport | Assessment |
| --- | --- | --- |
| A. Add typed commands to the current runtime and reuse inbox/outbox | Collaboration content and provenance live in inbox rows. Group delivery uses outbox rows with a pinned group binding. Reminder rows generate one inbox row transactionally. Completion history stays in the closeout ledger. | Selected. Each effect has one durable owner. Existing recovery handles actual backend uncertainty. |
| B. New collaboration service with messages, subscriptions, timer scheduler, and lifecycle event handlers | A separate message ledger feeds another delivery worker, which eventually calls the current inbox. Completion and cleanup become event subscribers. | Reject. It duplicates delivery state and creates a second crash boundary between message acceptance and inbox insertion. Event subscribers hide who changes task state. It is larger without adding a required capability. |
| C. One universal project action with message destinations and lifecycle modes | Keep everything in `project_action`, with `channel`, `kind`, and generic `target` fields. | Reject. Two action variants are not two independent tools. Destination options expose transport choices to callers and allow incompatible field combinations. |

A does not require a generic collaboration bus, a new execution scheduler, or a workflow state machine. Split the existing closeout command rather than replacing the resource safety implementation.

## Flow

1. The adapter verifies the calling Thread and active Turn, then parses the named tool's own schema. It never accepts a caller identity from arguments.
2. `ProjectRuntime` resolves membership and validates the target. It creates a stable message ID from project, caller, tool, and request ID. In one SQLite transaction it checks the payload fingerprint, inserts the recipient inbox row, and saves the receipt.
3. `AgentLoop` requests a recipient sweep after commit. It does not await the recipient's lane from inside the sender's tool handler. A recipient that is itself waiting for a tool response cannot deadlock the sender. Existing polling remains the recovery fallback.
4. The recipient consumes the durable input while the sender can continue its original Turn. A later sender failure cannot revoke it. A correction is another explicit message.
5. A paused recipient keeps the input held. A completed recipient reopens current work only when real new input is admitted. Both use the original Thread and saved Worker execution identity.
6. A group tool call instead inserts an outbox row. It never inserts another Agent's inbox row. Worker automatic assistant output remains a separate producer of the same human transport.
7. A due reminder transaction changes `scheduled` to `fired` and inserts the deterministic self-input. The ordinary input route handles pause, active Turns, and uncertain backend acknowledgement.

Immediate delivery means durable acceptance plus immediate scheduling eligibility. It does not promise that a busy, paused, failed, or disconnected recipient has processed the content. Tool receipts and queries distinguish those facts.

## Boundaries and caller usage

Expose three named dynamic tools. `project_action` keeps management. `send_agent_message` and `send_group_message` are genuinely separate tool definitions with separate schemas. Do not keep `send`, `report`, `deliver_result`, or `announce` aliases inside `project_action`.

```ts
send_agent_message({
	requestId: 'result-42',
	taskId: coordinatorTaskId,
	text: 'Implementation is ready. Please verify and decide the next step.',
	references: ['https://github.com/example/repository/pull/42'],
});
send_group_message({ requestId: 'user-answer-9', text: 'The change is ready for your review.' });
project_action({ action: 'open_group', requestId: 'discussion', taskId: myTaskId });
project_action({ action: 'schedule_reminder', requestId: 'check-ci', dueAt: 1800000000000, text: 'Check the PR checks and proceed if ready.' });
project_action({ action: 'list_reminders' });
project_action({ action: 'cancel_reminder', requestId: 'cancel-ci', reminderId: savedReminderId });
project_action({ action: 'complete_task', requestId: 'complete-42', taskId: workerId, outcome: 'delivered', summary: 'Merged and verified.', deliveryReferences: ['https://github.com/example/repository/pull/42'] });
project_action({ action: 'cleanup_artifacts', requestId: 'cleanup-42', taskId: workerId, scopeIds: [savedScopeId] });
```

The coordinator can message only its own Workers. A Worker can message only its own project's coordinator. Self-messaging and Worker-to-Worker messaging are rejected. Self-reminders are the explicit self-input capability. All roles can send human messages only to their currently associated group. No arbitrary `chatId`, project ID, sender ID, or target for reminders is accepted.

Only the coordinator dispatches Agent Loop Workers. Keep the complete execution-profile allowlist, creation deduplication, and immutable Worker execution identity. Delete `dispatch.mode`, `dispatch.authorization`, Feature-specific message lookup, source revision and scope fingerprint checks, and Runtime-added investigation text. Keep actual user restrictions in the task description and role prompt.

`open_group.taskId` can stay required. The Worker supplies its own supplied task ID. Runtime permits that exact self-target or a coordinator's own Worker. This avoids an optional-target interpretation branch while preserving the current coordinator caller shape.

Native approvals, permissions, questions, and runtime errors retain their existing channels. Do not route ordinary Agent content through native approval paths. The current `request_decision` card capability can remain if it remains a distinct native human-decision function. Refactor its implementation away from the deleted `announce` action and heading categories.

## Schema and function sketches

The names below are intended implementation signatures, not new layers that forward identical arguments.

```ts
const agentMessageSchema = z.strictObject({
	requestId: idSchema,
	taskId: idSchema,
	text: textSchema,
	references: z.array(textSchema).max(100).default([]),
});
const groupMessageSchema = z.strictObject({ requestId: idSchema, text: textSchema });
type AgentMessage = z.infer<typeof agentMessageSchema>;
type GroupMessage = z.infer<typeof groupMessageSchema>;

// Adapter request union. Tool name determines argument shape.
type ProjectToolCall =
	| { tool: 'project_action'; arguments: ProjectAction }
	| { tool: 'send_agent_message'; arguments: AgentMessage }
	| { tool: 'send_group_message'; arguments: GroupMessage };

// Runtime entry points own policy and durable acceptance.
ProjectRuntime.sendAgentMessage(callerId, message, assertActive): MessageReceipt;
ProjectRuntime.sendGroupMessage(callerId, message, assertActive): MessageReceipt;
ProjectRuntime.scheduleReminder(callerId, action): ReminderReceipt;
ProjectRuntime.cancelReminder(callerId, action): ReminderReceipt;
ProjectRuntime.listReminders(callerId): Reminder[];

// Store owns timer persistence and the single atomic transition.
Store.fireDueReminders(now): string[]; // Returns recipient task IDs for sweep eligibility.

// Completion and cleanup have different contracts.
TaskCloseout.complete({ taskId, callerId, projectId, requestId, fingerprint, conclusion }): CompletionReceipt;
TaskCloseout.reopenForInput(taskId, input): void;
TaskCloseout.acceptCleanup({ taskId, callerId, projectId, requestId, fingerprint, scopeIds }): CleanupReceipt;
TaskCloseout.reserve(taskId): () => void; // Resource admission only.
```

Schema-derived types stop untyped RPC values at the adapter and bridge. There is one named-tool registry in the Codex adapter. Generate JSON schemas from the same exported schemas used by the capability client. Keep the call union internal to the transport boundary. The domain runtime receives parsed domain arguments.

Message acceptance uses the existing project receipt mechanism with a tool-aware fingerprint. Reusing the same request ID for different content or a different tool is rejected consistently. A stable receipt contains message ID and recipient identity. Current delivery status comes from the matching inbox or outbox row, not an acceptance-time status copied forever into a receipt. Status must show sender, recipient, content, references, current delivery state, and error. Coordinator sees project messages. Worker sees messages where it is a participant.

For inbox provenance add `category: 'collaboration_message'` with caller task ID, project ID, event/message ID, and references. Preserve the existing `kind: 'agent'` distinction from user evidence. A referenced user message remains an Agent assertion unless Runtime resolves the actual saved source. Never accept supplied `senderId` as trusted provenance. Reminder provenance can be a small `kind: 'reminder'` variant carrying reminder ID and owner task ID.

Use a dedicated indexed reminder table because due-time scans and cancellation are first-class operations.

```sql
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  project_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('scheduled','fired','cancelled')),
  input_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  UNIQUE(task_id, request_id)
);
CREATE INDEX reminders_due ON reminders(state, due_at);
```

`fireDueReminders(now)` uses the same database transaction to create `reminder:<id>` input and change state to `fired`. Firing means enqueueing, not model execution. Cancellation changes only `scheduled` rows. If firing wins the transaction, cancellation returns `fired` and does not withdraw accepted input. Repeated cancellation returns the same terminal state. Validation checks finite safe epoch milliseconds and nonblank text. An overdue reminder is eligible on the next scan. No recurring interval is exposed.

Do not add a second message-content table just to restate inbox content. Add a bounded Store query for inputs carrying collaboration provenance. For explicit group messages, persist a narrow delivery-binding record alongside outbox content, containing task ID, accepted chat ID, group generation, request ID, and output ID. Do not misuse Worker turn-body metadata for this purpose. A group rebinding cannot silently send an accepted message to a different group.

## Completion and resource safety

`TaskCloseout.accept` currently creates frozen cleanup targets and writes completion together at `src/task-closeout.ts:211`. `AgentLoop.projectAction` then immediately advances cleanup at `src/loop.ts:178`. Both couplings must disappear.

Keep current work and completion history separate in the ledger.

```ts
type CurrentWork = { kind: 'open' } | { kind: 'completed'; completionId: string };
type Completion = {
	id: string;
	requestId: string;
	callerId: string;
	fingerprint: string;
	outcome: 'delivered' | 'terminated';
	summary: string;
	deliveryReferences: string[];
	at: number;
	inputSequence: number;
};
// Ledger adds completions: Completion[] and uses CurrentWork for lifecycle.
// Cleanup operations contain only explicit cleanup intents.
```

Recording completion does not seal scopes, create cleanup operations, interrupt the Turn, delete files, drain inputs, or redirect future inputs. A Turn may still finish after the coordinator records a result. Its native requests and tool identity checks continue to work. Completion is a business conclusion, not an execution lock.

Reopen current work on admission of actual fresh user, collaboration, or reminder input. Save the transition before execution and retain completion history. Use the accepted input sequence to distinguish new work from pre-completion history. A paused task stores new input without reopening execution. Repeated delivery and restart do not create repeated reopen records. Do not use unrelated source refreshes or a migration pass as a reason to start completed tasks.

Delete completion-as-permission checks throughout `assertActiveTask`, `capabilityActivity`, `advance`, `drain`, resource reservation, group output callbacks, workspace operations, control, and approval entry points. Replace them with the actual relevant pause, active Turn, membership, native-request, or cleanup-admission check. Delete `forwardCompletedInputs` entirely. Audit each occurrence rather than replacing it with one differently named broad gate.

Cleanup keeps the existing physical identity, inode, ancestry, branch generation, foreign resource, process-use, native uncertainty, and undelivered-artifact protections. `cleanup_artifacts` gains a required target task ID and accepts explicitly named owned artifact or worktree scopes. Coordinator authorization permits itself or its own Worker. A completed target is permitted. Already removed scope IDs return their existing result; conflicting resource identity never becomes permission to delete a replacement.

Keep the current `reservations`, `destructing`, and `progressing` admission mechanism. Schedule cleanup progression before recipient execution admission in a sweep. During destructive work new input stays durable and admission waits. Do not hold a global project lane across filesystem or network operations. Do not let a permanently protected cleanup monopolize execution forever. Once the attempt records a protected or blocked result and releases its destructive reservation, execution can continue with the actual resource status. A later attempt must reacquire and recheck resource use.

The execution cwd is the protected project directory at `src/loop.ts:577`. Cleanup of additional owned worktrees therefore need not replace the Thread. Remove released worktree associations from active resources while retaining their cleanup history. On later `ensure_workspace`, allocate a new resource generation with a new resource ID, path, and branch. Current deterministic repository resource IDs and `released-resource` tombstones at `src/loop.ts:718` otherwise cause a new allocation to be filtered back out by `persist`. Keep generation changes local to actual reallocation, not every input or every resume.

## Prompt and retained Thread migration

Copy the approved `.scratch/agent-collaboration-tools/prompts` role texts into production prompts. Tool naming can be made concrete without changing their workflow guidance. `ProjectRuntime.instructions` currently injects the conflicting owner-report requirement and success-gated deliverable policy at `src/project-runtime.ts:297`. Replace it with identity, tool use, provenance, and retry guidance. Keep project-specific instructions and actual task goals.

`AgentLoop.instructions` composes role, resource, project, capability, saved delegation, and environment text. Every input also receives `ProjectRuntime.context`. Update both paths. Existing Codex threads retain tool definitions, and `thread/resume` intentionally does not retrofit `dynamicTools`. The existing current-runtime-instructions replacement in `src/adapters/codex.ts:453` provides the instruction update channel, not new tools.

Extend the authenticated capability fallback with three explicit commands or endpoints for the three named tools. For example, retain `/project` for management and add `/agent-message` and `/group-message`. Have `project-client` accept a required named tool argument and select exactly one schema and endpoint. The instructions tell retained Threads to invoke the concrete missing tool through that fallback. New Threads receive all three dynamic tools. Never create a new Thread just to obtain new tool definitions.

Saved delegation text may contain Runtime-added investigation instructions or old operational instructions. Do not regex-delete arbitrary user prose. Preserve the saved source and task objective. Stop appending old boilerplate in new delegations. For old delegations, replace only exact known Runtime-generated fragments with versioned current-runtime guidance, preserving user-authored scope and actual investigation restrictions. Add explicit supersession guidance for old runtime tool instructions in the new developer context. Historical transcript items remain historical data.

The approved spec supersedes the coupling in ADR 0016, the Runtime evidence gates in ADR 0018, the owner-gated routing in ADR 0021, and the success-gated delivery mechanism in ADR 0024. Implementation should record these changes in one superseding ADR and update obsolete glossary terms and operational docs. This sketch does not edit those files.

## Existing data reconciliation

Run versioned idempotent migrations before normal scheduling. Preserve task IDs, members, Thread IDs, group IDs and generations, model identity and source, native requests, pause state, intake state, and project records.

Old report rows and published deliverable records remain queryable history. Link already-created coordinator inbox events to their existing delivery IDs. Do not create a second input for them. Uncertain existing inputs keep existing reconciliation and cannot be guessed delivered or blindly resent.

A legacy pending deliverable declaration is not an accepted immediate collaboration message. Reconcile its exact Thread and Turn using read-only execution evidence. If a matching coordinator inbox entry already exists, preserve that entry and classify the declaration accordingly. If no entry exists, archive the declaration with an explicit migration outcome and evidence. A confirmed successful old Turn may be converted once under its original deterministic delivery key only if the migration establishes that the old contract actually authorized publication. Unfinished, failed, interrupted, or unprovable declarations remain retained and visibly unresolved or retired, without a new wakeup. No final text is scanned to infer a message. Delete the live pending-result machine after this bounded migration.

Convert the old completion object into one completion-history record with stable identity and its original summary and time. Copy existing cleanup operations as legacy cleanup history. Do not generate targets from a completed flag. For old automatic completion cleanup that has not started, mark the intent retired under the new contract and keep resources. If deletion already partially ran, reconcile actual disposal paths and identity. Record removed parts and protect remaining parts until an explicit cleanup request. Never regenerate a missing file or resume a new deletion merely because upgrade discovered completion. Existing explicit scope cleanup intents remain explicit and can recover normally.

Import must not wake historical completed tasks. Existing uncertain input remains visible for reconciliation. Actual post-upgrade new input follows the reopened-original-Thread contract. Keep migration outcomes queryable rather than silently dropping pending legacy records.

## Ticket ownership and acceptance seams

| Ticket | Primary files | Smallest high-value checks |
| --- | --- | --- |
| 01 Agent messaging | `project.ts`, `project-runtime.ts`, `store.ts`, `domain.ts`, `loop.ts`, `ports.ts`, `adapters/codex.ts`, `workspace-bridge.ts`, `project-client.ts` | Real SQLite full-runtime test sends from a no-group Worker while its Turn remains running; coordinator starts or steers; sender later fails; same message stays delivered. Retry and lost-ACK restart produce one recipient input. Reject spoofing, peers, and cross-project targets. |
| 02 Group messaging | Same tool boundary files, `loop.ts`, `store.ts`, `worker-chat-turn.ts`, Feishu adapter and query readers | Distinct dynamic-tool names. Coordinator direct-question final creates no automatic group output; explicit call sends one. Worker commentary, questions, and final retain normal forwarding. Lost ACK stays uncertain or reconciles from actual evidence. No input is created by human output. |
| 03 Self group | `project-runtime.ts`, `task-groups.ts`, prompt composers | Worker self-open and coordinator-open converge to one group through existing `TaskGroups` lane and operation recovery. Another Worker target is rejected. Existing group generation must match. |
| 04 Dispatch | `project.ts`, `project-runtime.ts`, role prompts, dispatch client fixtures | Feature dispatch without mode or authorization succeeds using the selected allowed profile. Worker dispatch is rejected. Reused Worker identity cannot change. Actual user scope survives prompt composition. |
| 05 Self reminder | `project.ts`, `project-runtime.ts`, `store.ts`, `domain.ts`, `loop.ts` | Controlled clock covers before due, due while active, due while paused, cancellation before and after fire, restart, duplicate scans, and zero reminders. Inbox receives one deterministic input. |
| 06 Completion and cleanup | `task-closeout.ts`, `project-runtime.ts`, `loop.ts`, status/dashboard readers | Completion preserves real files and creates zero cleanup targets. Explicit cleanup addresses Worker scopes. Real worktree, open-file process, wrong inode, original directory, and shared-resource protections remain effective. |
| 07 Continue original Worker | `loop.ts`, `task-closeout.ts`, resource allocation path, prompt context and dashboard readers | Complete then user input and Agent input reuse exact Thread and execution identity. Cleanup concurrency holds input. Cleanup then reallocation uses new resource generation. Old completion remains queryable. Pause remains paused across restart. |
| 08 Integrated migration | `prompts/*`, prompt composers, adapter/fallback fixtures, migration fixtures, `scripts/project-coordinator-probe-tasks.ts`, relevant docs | Snapshot old database shapes, upgrade twice, restart, verify no replay and no new Worker or Thread. Exercise retained-thread fallback against missing new tool definitions. Verify no live legacy routes remain. |

Use existing `test/project-runtime.test.ts`, `test/task-closeout.test.ts`, `test/project-codex.test.ts`, `test/worker-execution-identity.test.ts`, and existing coordinated fixtures. Do not make a helper-test suite that mirrors new branches. The parent reports baseline typecheck passing and 764 of 765 tests passing, with the historical identity adoption test failing alone. Reproduce or compare that exact failure before attributing it to this work.

For real acceptance, adapt `scripts/project-coordinator-probe-tasks.ts` in an isolated temporary data directory and project checkout. Use current permitted execution configuration, a real Codex coordinator and Worker, a known task marker, and no production service restart. Capture dynamic calls or capability calls, durable message IDs, sender Turn still running, recipient input/continuation, and the reminder's next action. The existing probe's Feishu substitute proves no actual group delivery. Human-group acceptance separately needs an explicitly authorized test group. Record that portion as blocked if no target is authorized; do not silently use production groups.

## Gotchas and design screen

The project-wide serial lane currently surrounds most actions. Durable message insertion can use a short synchronous transaction and request deduplication. Network group creation and cleanup cannot block all project messages. Recipient wakeup must be scheduled after acceptance without awaiting another Agent lane.

General Feishu outbox sends at `src/loop.ts:1282` preserve `sending` as `uncertain` after restart and do not automatically reconcile plain messages. A message tool must expose that actual state. Extend transport evidence lookup only if Feishu supplies a stable identity that proves acceptance. Repeating a UUID beyond any verified deduplication window is not proof of exactly-once delivery.

`retireObsoleteInputs` and coordinator publish markers contain old report semantics. Update retirement to preserve new collaboration messages, and remove coordinator final auto-publish logic and `markCoordinatorAnnouncement` coupling. Retain native-request notifications. Remove dead success-result invalidation calls from faults, pause, observation, and rotation.

The selected shape passes the red-flag screen with these restrictions. Runtime owns role policy and acceptance. Store owns atomic rows. Loop owns delivery. Closeout owns resource mutation. No helper chain splits validate, load, save, and publish into public stages. No second message queue copies inbox state. No legacy aliases offer two ways to send the same message. Tool schemas generate protocol schemas so lists do not drift. Completion and cleanup share a ledger owner but expose distinct commands and cannot trigger each other.

Model the Domain changed the design to separate current work, immutable completion history, reminder state, and transport state. Make Operations Idempotent changed acceptance and timer firing to atomic inserts with stable identities, and required explicit outcomes for partial legacy effects. Type System Discipline changed the transport to a tool-discriminated union and schema-derived argument types. Those principle leaf skills were read for this sketch.
