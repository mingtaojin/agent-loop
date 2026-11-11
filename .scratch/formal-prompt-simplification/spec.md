Status: ready-for-agent

# Formal task prompt simplification

On 2026-11-07 the user approved simplifying formal task prompts and retaining both developerInstructions and additionalContext. Both transports must use the same current template; neither owns separate workflow rules.

## Decisions

- Replace the long prompt with the reviewed four-paragraph text.
- Remove the duplicate English contract from AgentLoop.
- Use prompts/task.md as the default when engineering.promptPath is omitted. Resolve it from the application location in source and compiled runs, independently of the working directory.
- Preserve same-Thread update delivery, the application-context replacement prefix, environment metadata, legacy workspace access, native approval, and directory selection.
- Documentation describes the source and delivery of the prompt and links to its content instead of restating the interview procedure.
- Verify loading, old-thread instruction updates, successive clarification, discussion-only scope, and a fully specified technical task. Build and restart the local service after verification, preserving task bindings.

## Work plan

1. Pin the behavior contract first. Existing transport regression checks and prior live marker evidence establish the two-channel contract; add loading regression cases before code changes.
2. Name the structure the code is missing. One file-backed prompt string, reused in the existing transports.
3. Name the target shape. Keep the existing currentPrompt/instructions methods and adapter interfaces; no new function boundary or architecture layer.
4. Subtract before you add. Delete the hidden contract and hardcoded alternate default.
5. Move in small behavior-preserving steps. Delegate loader and service tests; edit prompt and docs in the main thread.
6. Prove behavior on the real artifact. Source/compiled loading checks, existing transport tests, real model conversation, build, and live service readback.
7. Confirm the change is worth keeping. Workflow text has one maintained source and less repetition.
8. Rebase into small ordered commits / Opening a PR. Skip: this project directory has no Git metadata and no Git delivery was requested.

throughput checkpoint: loader/tests and prompt/docs have disjoint write sets; real conversation starts when the short template is available.

## Validation

Implementation, validation, and local activation are complete. Source tests passed 250/250 in a serial run, the build passed, and 6 focused compiled tests passed from /tmp. Real conversations verified successive clarification, discussion-only scope, a fully specified change, and instruction refresh in the original Thread. Local activation passed with a new live process and advancing heartbeat; all five existing task bindings were preserved. See verification.md for evidence and test limits.
