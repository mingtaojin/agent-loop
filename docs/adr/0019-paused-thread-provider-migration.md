---
status: accepted
---

# Migrate paused tasks away from incompatible execution Threads

When a paused task's saved Codex Thread belongs to a provider that the current role configuration cannot resume, Agent Loop archives the old Thread binding and clears the task's `threadId` and `turnId` while preserving the task's paused state, group, resources, inputs and approvals. The next explicit resume creates a fresh Thread with the current role configuration and receives one durable migration context input. This avoids automatic execution and preserves the operator's pause decision while giving the task a valid path to continue later.
