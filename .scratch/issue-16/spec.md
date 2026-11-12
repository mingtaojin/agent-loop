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
| Full local tests | 484 of 485 pass. The CLI shutdown submission case returns `unknown_outcome` during its 15-second wait. It passes alone on rerun in 5.2 seconds. `full-tests.log`, `submission-retest.log`. |
| Type check and build | Both pass. `check.log`, `build.log`. |
| Actual service after fix | Pending coordinator notice after separate authentication maintenance. |
| Independent verification | Pending coordinator assignment. |

The historical failed task belongs to the separate `/Users/developer/ydkideaproject/agent-loop` instance. It already has a selected directory and formal Thread and is idle when observed. This work does not replay or alter it. The current coordinator runs a compiled CLI worktree entry; its source HEAD does not establish the bytes used in the historical failed request.

The before probe predates separately authorized authentication maintenance. After resumption, the original and fixed schemas must be compared under the same resulting authentication environment. No credential content is evidence. No production Feishu connection, task replay, service restart, or deployment is performed by this Worker.
