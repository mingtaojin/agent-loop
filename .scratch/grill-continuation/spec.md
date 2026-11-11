Status: ready-for-agent

# Continuous clarification

The user reports that automatic grill-with-docs use asks one isolated question instead of continuing through the outstanding decisions. On 2026-11-07 the user authorized the proposed correction to the project guidance.

## Agreed behavior

Within the current requirement, establish known facts and confirmed decisions, identify unresolved decisions and their dependencies, then ask one eligible question at a time. Record each answer before examining the remaining decisions. Continue the interview until the relevant facts and user decisions are settled. Do not infer whole-plan approval from one answer, repeat settled questions, or invent extra decisions. Preserve existing implementation authorization and discussion-only scope.

The Agent owns this behavior. Runtime message routing and the installed global skills stay outside this change.

## Work

- Reproduce it yourself on the matching surface. Completed through the reported conversation and its actual skill-read and follow-up records; a deterministic prompt failure is not established.
- Binary-search the cause. Existing investigation traced the mismatch to project guidance ending clarification after a confirmation, without requiring the remaining decisions to be checked.
- Plan the fix. Update prompts/task.md and docs/prompts/task.md; no function boundary changes.
- Verify on the same surface. Run a real Codex conversation through the project adapter in an isolated fixture. Check separate questions, recorded answers, no early implementation, and continuation under existing authorization. Feishu client acceptance remains separate.
- Stage the commits so the failing repro lands before the fix in git history. Skip: the project directory has no Git repository and no commit was requested.
- Run Opening a PR. Skip: no PR requested.

throughput checkpoint: one bounded prompt/document change; independent editing and conversation-fixture preparation.

## Validation

Completed for the scoped change. See verification.md for the real conversation, file assertions, existing routing regression checks, and acceptance limits.

## Comments

2026-11-07: Updated prompts/task.md and docs/prompts/task.md. The real conversation asked about format, recorded JSON, then separately asked about internal costs. The implementation file remained absent until both decisions were answered. After the second answer it generated the requested configuration under the original implementation authorization. No Runtime or global skill changes were needed.
