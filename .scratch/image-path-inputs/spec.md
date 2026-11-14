Status: ready-for-agent

# Image path inputs

Incoming images must be saved intact before delivery. Selector, formal, follow-up,
and retry inputs carry ordinary text with absolute local file references and the
original message identity. Existing text and attachment records remain intact.
Missing or unreadable files fail preparation before delivery.

## Plan

1. Reproduce it yourself on the matching surface via the control skill.
2. Binary-search the cause.
3. Plan the fix.
4. Delegate real-device acceptance on the same surface to a fresh verifier.
5. Stage the commits so the failing repro lands before the fix in git history.
   skip: No commit requested. Retain before/after evidence locally instead.
6. Run Opening a PR.
   skip: No PR requested.

## Checkpoint

Use the existing runtime fixtures and App Server protocol boundary. Prove input
types and byte preservation first, then verify tool-based image reading in an
isolated real Codex session. Do not restart the running Agent Loop service.
Record request assembly size only; model token and latency effects require
separate measurements and must not be inferred from transport input sizes.

## Progress

- Grounded in AGENTS.md, GLOSSARY.md, ADR 0007 and ADR 0008.
- Root cause observed in prepare() producing kind=image, then wireInput()
  converting it to localImage.
- Existing dirty changes recorded before edits and preserved.
- Steps 1 and 2 complete. Eight focused regression cases fail before the fix.
- Step 3 complete. prepare() now emits message-bound absolute text references
  and validates final file type, size and readability before delivery.
- Nine focused tests pass, including actual App Server request capture.
- Step 4 passes the real Codex multi-turn harness after canonicalizing the
  macOS temporary fixture root. All four RPC inputs contain text items only.
  Image-reference counts are 2, 2, 0, 1. The model uses imageView three times.
- First full test run passed 388 of 389 cases. A CLI child timed out under
  default parallel execution. The CLI test file passes in isolation. Full tests
  pass all 389 cases with bounded concurrency; no CLI source was changed.
- TypeScript no-emit check and git diff --check pass.
- A fresh verifier independently confirms correct per-turn image views, exact
  saved bytes, follow-up final answers and exit of all tracked child processes.
- Bounded DeepSeek source review reports no findings in the production change.
  Its conditional absolute-task-ID question is resolved by newTask() assigning
  randomUUID() for every production source path.
- Steps 1 through 4 are complete. Steps 5 and 6 remain skipped within the
  agreed delivery scope. Validation details and limits are in validation.md.
- User confirmed preserving external workspace changes and continuing after
  .scratch/dashboard-task-groups/ disappeared from the untracked-file list.

## Verification boundaries

Feishu and GitHub transport are local fakes in the real Codex harness. Original
PNG bytes are checked from disk. App Server RPC input is captured directly;
upstream provider payloads, token use and timeout improvement are not measured.
Existing conversation history is not rewritten. No service restart, deployment,
commit or remote tracker update is part of this task.

Rerun the regression cases with `node --import tsx --test test/image-inputs.test.ts`.
Rerun real Codex acceptance with `node --import tsx scripts/verify-image-paths.ts`.
The latter saves its outcome to live-result.json in this directory and retains
its isolated temporary fixture and protocol capture for inspection.

## Git delivery

The user subsequently authorized commit and push in message
om_x100b6066ebdc78b4dde91a7d180f4c1. Only the six source, test and verification
script files are staged. Existing unrelated hunks in the shared runtime/service
tests remain outside the index. Local investigation records stay local.
The staged tree is exported to an isolated snapshot for validation before
committing. No deployment or service restart is included in this authorization.
