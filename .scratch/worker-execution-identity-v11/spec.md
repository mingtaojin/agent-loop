Status: ready-for-agent

# Worker execution identity

Version: v1.2

## Problem Statement

Agent Loop currently reads the shared worker execution profile whenever it creates, resumes, or observes a Worker Thread. A configuration reload can therefore change an existing Worker’s model or reasoning effort. Removing a profile can also make a historical Worker inherit a different profile or fail without preserving the original choice.

## Solution

At Worker creation, the coordinator selects one complete model and reasoning-effort pair from the configured Worker allowlist. Agent Loop stores that selection with the Worker task and uses the stored identity for every later turn, observation, pause recovery, and service restart. Configuration changes affect only Workers created after the change. If a historical Worker has no reliable saved original identity, Agent Loop stops before choosing a replacement and reports the ambiguity for coordination.

## User Stories

1. As a project coordinator, I want to select a Worker model and reasoning effort from configured complete pairs, so that each Worker starts with an intentional execution identity.
2. As a project coordinator, I want different Workers to use different allowed pairs, so that the selected capability matches each assignment.
3. As a project coordinator, I want an unavailable pair to be rejected at Worker creation, so that no model and effort combination outside the allowlist can run.
4. As a project coordinator, I want a model and effort to be validated as one pair, so that Agent Loop never crosses a model from one entry with an effort from another entry.
5. As a Worker, I want my selected identity saved with my task, so that later turns use the same model and reasoning effort.
6. As a Worker, I want follow-up messages to use my original identity, so that conversation behavior does not change after configuration reload.
7. As a Worker, I want pause and resume to retain my identity, so that recovery does not silently switch execution capability.
8. As an operator, I want a service restart to restore each Worker’s saved identity, so that restart recovery preserves task behavior.
9. As an operator, I want changing the allowlist to affect only new Workers, so that existing work remains stable.
10. As an operator, I want deleting an allowed pair to leave existing Workers usable with their saved identity, so that configuration cleanup does not rewrite history.
11. As a coordinator, I want the coordinator’s own execution profile to keep using the coordinator configuration, so that Worker selection does not expand or alter coordinator model behavior.
12. As a coordinator, I want historical Workers to use their recorded original identity when reliable provenance exists, so that migration preserves the actual prior choice.
13. As a coordinator, I want an ambiguous historical identity to be surfaced as a blocker, so that the system never guesses from the current instance default.
14. As an operator, I want a failed model call to retain its selected identity, so that retry behavior does not become an unannounced model fallback.
15. As a reviewer, I want the persisted identity to be visible in task state and test fixtures, so that restart and legacy behavior can be audited.

## Implementation Decisions

- Define the Worker execution identity as one validated execution profile containing the backend, model, and reasoning effort. Treat the model and reasoning effort as an inseparable pair.
- Store the Worker allowlist as a single nonempty list of complete execution profiles. Accept the previous single-profile input as a one-entry list at configuration loading. Validate a dispatch selection against an allowlist entry by structural equality, including backend, model, and reasoning effort.
- Extend Worker dispatch input so the coordinator supplies the selected complete profile. Reject a missing or non-allowlisted selection instead of synthesizing a profile from separate model and effort values.
- Persist the selected profile in the task snapshot at the point the task becomes a Worker execution. Keep it across turns, pause, resume, restart, provider migration, and configuration reload.
- Resolve execution for a Worker from its persisted task identity. Resolve execution for a coordinator from the current coordinator role profile. Do not apply Worker snapshots to coordinator tasks.
- Preserve an existing task’s saved identity even when the current allowlist changes or no longer contains that entry. The allowlist constrains creation, not historical execution.
- Inspect durable task state and any reliable existing execution identity before resuming a historical Worker. Use only the complete, valid legacy task-scoped model and effort metadata as a historical original-value source, and persist the source keys. If no reliable original value exists, preserve task, group, Thread, native approvals, operator pause and held inputs, and report one execution-identity blocker before any execution. Never substitute the current Worker profile.
- Keep the dispatch and execution identity validation at the project execution boundary. The loop passes the resulting profile to the Codex port and does not reselect it.
- Base the model feature directly on current main `3260549ec6b42b27fd62373b7b25dc391119ae0e`. Preserve its report, native request, capability, and Worker group message behavior. The cancelled single-config feature is not a dependency.

## Testing Decisions

- Test observable execution behavior. Assert the profile sent to Thread creation, resume, observation, and new turns rather than private maps or helper calls.
- Test dispatch validation for an allowed pair, a crossed pair, a missing selection, and a pair removed from the current allowlist after creation.
- Test task persistence by constructing a Worker, reloading the store, and continuing the Worker with changed configuration. The Codex port must receive the saved profile.
- Test pause and resume, provider restart recovery, and multiple turns with the same saved profile.
- Test historical tasks with reliable saved provenance and tasks without reliable provenance. The first resumes with its recorded identity; the second reports a blocker and never uses the current default.
- Reuse existing project dispatch, project Codex, execution configuration, and runtime recovery fixtures. Add no test that asserts private implementation structure.

## Out of Scope

- Runtime model switching, per-turn reselection, manual Worker profile editing, or automatic model fallback.
- New backend support, dashboard changes, coordinator model selection changes, or a separate verifier role.
- Credential storage, credential redaction, and the cancelled single-config migration.
- Deployment, service restart, live database edits, merge, or changes to unrelated task worktrees.

## Further Notes

- The product decisions in worker execution requirements v1.0 and v1.1 establish creation-time selection, immutable existing Worker identity, and historical preservation. Technical field names and persistence details remain implementation choices.
- The implementation must report the exact main base and resulting PR head. Independent verification is arranged by the coordinator.


## Authorization and sources

The retained v1.0 requirements have SHA256 `f645ade92f2335c37e4b7d1c6ba718876be54cf36b432acf875e8d772775b90d`. Their U1, U2, and U3 source identifiers remain authoritative for the product rules. v1.1 adds the following supplied owner message: `om_x100b60caf31598a4de137711674c7e7`, chat `oc_586b1866902382e0db4dff8d25c0f3f7`, sender `ou_5c280b16780ac4016c7455a276b2d95b`: "历史worker继续沿用原来它本身的模型和推理强度. 先让worker调用to-spec形成文档然后使用poteto-mode进行开发."

The coordinator confirmed the historical fail-closed boundary in task `c9edaf14-f18a-42de-841e-d963e1f520cc`, event `worker-model-historical-fail-closed-v1`: complete legacy keys restore with source; missing, partial, or unreliable provenance preserves task state and emits one blocker without execution or defaults. This is a sourced coordinator instruction within the implementation grant, not a native approval or deployment authorization.

The coordinator relayed owner cancellation of PR63 in event `model-pr63-cancelled-rebase-v1`. Version v1.2 removes that dependency and rebases only the authorized model feature onto main `3260549ec6b42b27fd62373b7b25dc391119ae0e`. Existing environment credential loading remains the main contract. This is a technical base revision; the v1.1 product and implementation authorization remains unchanged. All verification must be refreshed on this base.
