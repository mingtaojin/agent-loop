Status: ready-for-agent

# Strict directory selection and deterministic failure recovery

Issue [#16](https://github.com/mingtaojin/agent-loop/issues/16) requires directory selection to reach the formal task or ask for a directory, without submitting a schema the service rejects or retrying a deterministic parameter error.

## Implementation

The model output uses `z.union(workspaceChoiceSchema.options)` to emit nested `anyOf`. This is the same one-line change found in PR #14 commit `90339e3`, reused with coordinator authorization. The domain discriminated union, strict fields, candidate identities, and permission checks remain authoritative.

The adapter parses the service error JSON and recognizes exactly `error.code=invalid_json_schema`. It preserves the raw RPC error detail and maps this code to `InvalidOutputSchemaError`. Selection setup preserves this error type. Runtime immediately saves failed state and diagnostics without scheduling or consuming recovery attempts. Ticks and process recovery preserve the stop. A new user message can explicitly continue the preserved task. Other failures retain the existing recovery budget.

## Candidate and integration limits

The independent candidate starts at `75e71405f7b12e121ba5b26642c8ac73d4bcc9e6`. The failing tests are committed first in `3241a63`; the fix follows in `295a9d0`.

CLI PR #17 at `db85f353` changes shared recovery and intake modules. PR #14 contains the same schema conversion. The Owner must reconcile these on the actual latest main before merging, then obtain independent verification covering that head and base. This PR does not close the Issue or deploy the fix.

## Evidence recorded on 2026-11-12

Evidence directory on the authorized Mac is `/Users/developer/IdeaProjects/agent-loop/data/tasks/89def077-7fc1-454b-898c-e619bbb4e197/evidence`.

| Check | Result and evidence |
| --- | --- |
| Historical failure | Read-only historical-instance database confirms 12 matching errors. `historical-failure.json`. |
| Before on actual configured model path | Codex 0.167.0 reports `openai` and `gpt-6.1-sol`. The original schema receives the exact HTTP 400 `choice.oneOf` rejection, with `willRetry=false`. `before-result.json`, `before-protocol.jsonl`, `before-identity.json`. |
| Failing regression | Three tests fail before the fix for schema rejection and repeated recovery. `regression-before.log`. |
| Core regression after fix | Six tests pass. Both failed-turn and RPC errors submit once, remain stopped across recovery, and allow explicit continuation with original messages and attachment bytes. HTTP 429, a prose mention of the code, and a different service code retain finite recovery. `regression-after.log`. |
| Full local tests | 485 of 485 pass with test concurrency 2. The earlier unrestricted run passes 484 of 485; its CLI shutdown timeout also passes alone. `full-tests-concurrency2.log`, `full-tests.log`, `submission-retest.log`. |
| Type check and build | Both pass. `check.log`, `build.log`. |
| Current authentication, actual service | New `anyOf` returns and validates all four choices. Every temporary fixture retains its original file and bytes. `after-auth-summary.json` and `after-auth-fixed-*-protocol.jsonl`. |
| Same authentication, original schema control | Old `oneOf` also succeeds after the authentication change. This prevents attributing the earlier failure and later success to the code change. `after-auth-original-protocol.jsonl`. |
| Original rejecting backend, new schema | Unverified. An isolated environment using the previous authentication requires coordinator approval and operations handling. Global authentication is not rolled back. |
| Read-only source preflight | The configured DeepSeek model is rejected by the current ChatGPT account with `modelNotFound`. This is not a quota error or a review pass. `source-preflight.jsonl`. |
| Independent verification | Pending coordinator assignment. |

The historical failed task belongs to the separate `/Users/developer/ydkideaproject/agent-loop` instance. It already has a selected directory and formal Thread and is idle when observed. This work does not replay or alter it. The current coordinator runs a compiled CLI worktree entry; its source HEAD does not establish the bytes used in the historical failed request.

The before probe predates separately authorized authentication maintenance. After resumption, both schemas are tested under the same resulting environment. Codex 0.167.0 reports `openai` and `gpt-6.1-sol` in both phases, but the old schema's acceptance changes across the authentication boundary. The new schema's acceptance by the original rejecting backend remains a separate gate. No credential content is evidence. No production Feishu connection, task replay, service restart, or deployment is performed by this Worker.

## Reproduce local verification

Run `node --import tsx --test --test-concurrency=2 test/*.test.ts`, `npm run check`, and `npm run build` from this worktree. The focused regression command is `node --import tsx --test --test-name-pattern='strict-schema|deterministic invalid-schema|selector (rate-limit|schema-word)' test/codex-selection.test.ts test/workspace-selection.test.ts`.

The real selector instrument is preserved locally at `.scratch/issue-16/probe.ts` with `proxy.mjs`; it loads the original instance's configuration and creates a separate temporary directory and read-only selector. Its arguments select a result label, expected choice, and an optional `original` schema mode. The original mode is compared offline to the captured failing request and has identical schema content. Real runs use the existing environment file without printing it. No persistent production platform adapter is started.

PR #14's readable failure notice currently checks `WorkspaceSelectionError`, while this candidate preserves `InvalidOutputSchemaError` separately. Eventual integration must verify both the readable user notice and immediate retry stop. This independent candidate does not rewrite the other Owner's notice.
