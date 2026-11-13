# Task closeout

New Tasks receive a separate `artifacts-*` directory under their task data directory. Each input includes the current scope IDs and absolute paths in additional context. Stable Thread instructions describe their use without embedding the changing inventory. Execution cwd, original attachments and control records remain separate. Agents pass this path to supported output flags or TMPDIR. Runtime does not intercept arbitrary shell writes.

## Artifact actions

`allocate_artifacts` accepts `requestId`, `label` and optional `parent`. Without parent it creates a fresh child of the task data directory. An explicit parent must be the project's canonical directory or a real directory inside a newly owned worktree. Runtime creates a fresh child and never adopts existing external contents. New Runtime worktrees receive physical ownership records. Restoring historical associations does not enroll them.

`register_artifact` accepts `requestId`, `scopeId`, `path` and `disposition`. Dispositions are `temporary`, `undelivered`, `delivered`, `superseded` and `abandoned`. Delivered artifacts require a `reference`. An undelivered file protects its entire containing scope. Updates must identify the same physical file. Coordinators can supply `taskId` to update a Worker in their project, including delivery after completion.

## Completion action

Only the project coordinator can complete a Worker or verifier. A final answer, result report, idle state, pause or failure does not complete a Task. The coordinator verifies delivery or explicit abandonment before submitting the action.

```json
{"action":"complete_task","requestId":"closeout-123","taskId":"worker-task-id","outcome":"delivered","summary":"The agreed result was delivered; temporary work can be released","deliveryReferences":["https://example.test/result"]}
```

Outcome is `delivered` or `terminated`. Completion and the frozen cleanup intent share one SQLite transaction. Completion is owned by the closeout ledger, separately from mutable Task execution snapshots. The immutable action receipt is `{operationId, taskId}`. Repeating the same action continues that operation; changing content under the same request ID fails.

`{"action":"status","section":"closeout"}` returns live ledgers with `lifecycle`, `scopes` and `operations`, using normal project pagination and caller visibility. Workers and verifiers see only their own ledger; coordinators can query project Tasks. Every frozen target reports `pending`, `protected` or `removed`, its reason, and directory and branch results. A receipt alone does not mean deletion succeeded. Summary and delivery references survive deletion.

An in-flight allocation or execution admission rejects completion until the same request can be retried. Uncertain input delivery and pending approvals must be reconciled before completion. A running turn can finish after completion is recorded. Runtime never interrupts it to reclaim files. Cleanup progresses after explicit actions, during polling and on restart without waking a model.

## Native request boundary

The final completion transaction checks the adapter's authoritative unresolved-request state. This includes requests that have not been clicked and responses awaiting native acknowledgement. A provider without this protection cannot complete a threaded Task.

After completion, late native requests receive only denial or protocol error responses. Runtime does not grant permissions or manufacture user answers. An uncertain denial leaves execution use busy and cleanup pending. Completed Threads are excluded from adapter resumption and recovery. Already permitted execution can still finish; cleanup waits for actual idleness and process-use checks. Protocol fixtures verify response frames and acknowledgement handling. Real-provider progress after a question error remains unverified.

## Deletion boundaries

Deletion checks physical directory and ancestor identities, registered artifact identities, Git identity, the frozen local branch head and branch incarnation, other Task references and process use. A replacement file or recreated branch cannot inherit an earlier delivery or cleanup decision. Local lsof checks cwd and open files. An unavailable or incomplete probe stays pending. Artifact deletion uses a persisted disposal path so interrupted removal can resume without adopting replacement contents. A containing resource waits until every nested scope has been removed, then rechecks absence at its original and disposal locations, including locations inside a relocated parent.

New worktree enrollment binds branch ownership to the physical reflog creation identity and first entry. Normal commits can append to that reflog. A missing, rewritten or replaced anchor, a filesystem without a usable creation timestamp, or an older ledger without an enrollment anchor leaves worktree and branch removal pending. Completion additionally freezes the current branch identity and head.

If a Worker already removed its owned worktree and local branch, Runtime reconciles verified absence of the worktree and nested scopes without recreating resources. All surviving ancestors must retain their recorded identities. A missing branch with a remaining worktree or Git registration blocks destructive cleanup, including nested scopes. An extant replacement or conflicting Git registration remains protected.

Explicit completion can discard dirty, untracked, ignored and unmerged work in newly owned worktrees and deletes their local task branches. Ordinary `release_workspace` retains its existing conservative checks and does not delete branches. Shared project roots, original inputs, project records, other Tasks and unknown or active use stay protected. Cleanup never stops deployed services, dissolves groups, deletes remote branches or scans historical resources.

## Follow-up work

Completed Tasks cannot resume Threads, restore worktrees, start execution or approve old native requests. Read-only execution-use checks do not call `thread/resume`. Live and offline follow-ups retain original provenance and route once to the coordinator. Forwarded messages cannot answer an unrelated coordinator native question, and attachment downloads use the original message identity. The coordinator answers historical questions from records. New work uses `dispatch` with `predecessorTaskId`; the new Task receives the old summary and delivery references and allocates independent resources.

## Coordinator housekeeping

Coordinators allocate a separate scope for each dispatch or inspection. `cleanup_artifacts` takes `requestId` and `scopeIds`, freezes those scopes and leaves the coordinator Task open. The coordinator finishes its current turn so mechanical cleanup can proceed. Subsequent work allocates a fresh scope. New scopes and durable project records are outside old operations.

## Verification

Run `npm run verify:closeout` for disposable Runtime acceptance with real SQLite, filesystem, Git and child-process usage checks. Model and Feishu interfaces are controlled substitutes. Adapter protocol tests separately check that usage probes never resume a retained Thread. These tests do not establish live model, Feishu or business-instance cleanup acceptance.
