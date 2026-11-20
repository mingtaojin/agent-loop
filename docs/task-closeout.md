# Task closeout

New Tasks receive a separate `artifacts-*` directory under their task data directory. Each input includes the current scope IDs and absolute paths in additional context. Stable Thread instructions describe their use without embedding the changing inventory. Execution cwd, original attachments and control records remain separate. Agents pass this path to supported output flags or TMPDIR. Runtime does not intercept arbitrary shell writes.

## Artifact actions

`allocate_artifacts` accepts `requestId`, `label` and optional `parent`. Without parent it creates a fresh child of the task data directory. An explicit parent must be the project's canonical directory or a real directory inside a newly owned worktree. Runtime creates a fresh child and never adopts existing external contents. New Runtime worktrees receive physical ownership records. Restoring historical associations does not enroll them.

`register_artifact` accepts `requestId`, `scopeId`, `path` and `disposition`. Dispositions are `temporary`, `undelivered`, `delivered`, `superseded` and `abandoned`. Delivered artifacts require a `reference`. An undelivered file protects its entire containing scope. Updates must identify the same physical file. Coordinators can supply `taskId` to update a Worker in their project, including delivery after completion.

## Completion action

Only the project coordinator can record completion of its Worker. A final answer, idle state, pause or failure does not complete a Task.

```json
{"action":"complete_task","requestId":"complete-123","taskId":"worker-task-id","outcome":"delivered","summary":"The agreed result was delivered","deliveryReferences":["https://example.test/result"]}
```

Outcome is `delivered` or `terminated`. Completion stores the conclusion, immutable history and the current inbox sequence in one SQLite transaction. It does not seal scopes, create cleanup operations, delete files or interrupt execution. Native questions and approvals keep their existing delivery and authorization rules. The receipt is `{operationId, taskId}`. Repeating the same request returns the original receipt without recording another completion or closing later work. Reusing its request ID with different content fails.

`{"action":"status","section":"closeout"}` returns `lifecycle`, `completionHistory`, `scopes` and cleanup `operations`, with project pagination and caller visibility. Workers see their own ledger; coordinators can query project Tasks. The dashboard displays current work, completion history and resource cleanup independently.

## Explicit cleanup

Only the coordinator can request cleanup of its own scopes or a Worker in the same project, including a completed Worker. The request names each owned artifact or worktree scope:

```json
{"action":"cleanup_artifacts","requestId":"cleanup-123","taskId":"worker-task-id","scopeIds":["owned-scope-id"]}
```

The response includes `{operationId, taskId, cleanup}`. Each target reports `pending`, `protected` or `removed`, its reason, and directory and branch results. A receipt alone does not mean deletion succeeded. Scope identities and local branch identity are frozen when cleanup is accepted. New scopes cannot enter that operation.

Cleanup and execution admission are mutually exclusive. New input is saved while cleanup owns admission, then delivered when its result is known. Running execution, unresolved delivery, native requests and process use keep cleanup pending. An undelivered artifact keeps its scope protected. These blocked results do not prevent later inputs from continuing the Worker. Explicit cleanup progresses during polling and restart without creating model input or interrupting execution.

## Deletion boundaries

Deletion checks physical directory and ancestor identities, registered artifact identities, Git identity, the frozen local branch head and branch incarnation, other Task references and process use. A replacement file or recreated branch cannot inherit an earlier delivery or cleanup decision. Local lsof checks cwd and open files. An unavailable or incomplete probe stays pending. Artifact deletion uses a persisted disposal path so interrupted removal can resume without adopting replacement contents. A containing resource waits until every nested scope has been removed, then rechecks absence at its original and disposal locations, including locations inside a relocated parent.

New worktree enrollment binds branch ownership to the physical reflog creation identity and first entry. Normal commits can append to that reflog. A missing, rewritten or replaced anchor, a filesystem without a usable creation timestamp, or an older ledger without an enrollment anchor leaves worktree and branch removal pending. Explicit cleanup additionally freezes the current branch identity and head.

If a Worker already removed its owned worktree and local branch, Runtime reconciles verified absence of the worktree and nested scopes without recreating resources. All surviving ancestors must retain their recorded identities. A missing branch with a remaining worktree or Git registration blocks destructive cleanup, including nested scopes. An extant replacement or conflicting Git registration remains protected.

Explicit cleanup can discard dirty, untracked, ignored and unmerged work in newly owned worktrees and deletes their local task branches. Ordinary `release_workspace` retains its existing conservative checks and does not delete branches. Shared project roots, original inputs, project records, other Tasks and unknown or active use stay protected. Cleanup never stops deployed services, dissolves groups, deletes remote branches or scans historical resources.

## Follow-up work

New user input or an Agent message continues the same Worker and Thread. The task, execution profile, group and prior completion history stay intact. Only an accepted input after the completion inbox sequence reopens current work; retries and historical pending rows do not. Pause still requires explicit resume.

After cleanup, additional input reports removed scopes and the current resources. `ensure_workspace` can acquire another worktree for the same repository using a persisted new resource generation, path and branch. Old tombstones and cleanup retries cannot remove the replacement. `allocate_artifacts` creates a new artifact scope when needed. The coordinator may choose a new task with `predecessorTaskId` when the work calls for it.

## Upgrade behavior

Before recovery, the Runtime turns each old completion into a historical record and records the existing inbox sequence. Explicit old cleanup remains recoverable. An old implicit completion cleanup is retained as evidence and stops deleting. Untouched scopes are unsealed when their physical identity matches. Interrupted disposal paths and partial worktree removal keep their frozen identities and results. A new explicit request can select a retained scope and continue from that exact disposal identity. Migration neither starts a new turn nor replays historical follow-ups.

## Verification

Run `npm run verify:closeout` for disposable Runtime acceptance with real SQLite, filesystem, Git and child-process usage checks. Model and Feishu interfaces are controlled substitutes. Adapter protocol tests separately check that usage probes never resume a retained Thread. These tests do not establish live model, Feishu or business-instance cleanup acceptance.
