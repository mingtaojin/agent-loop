## Scores

| Criterion | A | B | Evidence |
| --- | ---: | ---: | --- |
| Tool contract | 2 | 2 | Both expose independent `send_agent_message` and `send_group_message` tools, enforce coordinator↔own Worker routing, and bind human sends to the caller’s current group. A is explicit about rejecting aliases and spoofed identities. [A](/Users/developer/IdeaProjects/agent-loop-collaboration/.scratch/agent-collaboration-tools/design-a.md:35) [B](/Users/developer/IdeaProjects/agent-loop-collaboration/.scratch/agent-collaboration-tools/design-b.md:20) |
| Durable delivery | 2 | 2 | Both reuse inbox/outbox state, commit acceptance atomically, schedule after commit, retain unknown-ack reconciliation, and keep sender execution independent of recipient processing. [A](/Users/developer/IdeaProjects/agent-loop-collaboration/.scratch/agent-collaboration-tools/design-a.md:24) [B](/Users/developer/IdeaProjects/agent-loop-collaboration/.scratch/agent-collaboration-tools/design-b.md:14) |
| Lifecycle | 2 | 2 | Both separate completion from cleanup, preserve the original Thread and Worker execution identity, retain paused inputs, defer execution during destructive work, and permit later reopening. [A](/Users/developer/IdeaProjects/agent-loop-collaboration/.scratch/agent-collaboration-tools/design-a.md:152) [B](/Users/developer/IdeaProjects/agent-loop-collaboration/.scratch/agent-collaboration-tools/design-b.md:90) |
| Migration | 2 | 2 | Both preserve historical rows and identities, provide retained-Thread fallback ingress, quarantine legacy delivery state, avoid replaying ordinary historical finals, and require explicit cleanup after migration. [A](/Users/developer/IdeaProjects/agent-loop-collaboration/.scratch/agent-collaboration-tools/design-a.md:178) [B](/Users/developer/IdeaProjects/agent-loop-collaboration/.scratch/agent-collaboration-tools/design-b.md:96) |
| Maintainability and verification | 2 | 1 | A gives clearer ownership boundaries, schema-derived protocol types, ticket seams, and a live probe. B has the same broad structure, but its `Reminder` union omits the reminder ID, owner, request ID, and fingerprint needed for cancellation and retry identity. [A](/Users/developer/IdeaProjects/agent-loop-collaboration/.scratch/agent-collaboration-tools/design-a.md:99) [B](/Users/developer/IdeaProjects/agent-loop-collaboration/.scratch/agent-collaboration-tools/design-b.md:52) |

**Totals**  
A scores **10/10**. B scores **9/10**.

## Recommendation

Use **A as the base**. Its `taskId` naming follows existing project action conventions such as `dispatch`, `complete_task`, and `open_group`. Document that this field is the recipient task for agent messages. [project.ts](/Users/developer/IdeaProjects/agent-loop-collaboration/src/project.ts:51)

Graft these parts from B.

- Retain Feishu provider message IDs, exact binding generations, and explicit uncertain-state handling for group sends. [B](/Users/developer/IdeaProjects/agent-loop-collaboration/.scratch/agent-collaboration-tools/design-b.md:30)
- Use B’s high-water input sequence language for reopen decisions and its explicit migration outcome matrix for pending, contradictory, and unproven legacy deliveries. [B](/Users/developer/IdeaProjects/agent-loop-collaboration/.scratch/agent-collaboration-tools/design-b.md:91)
- Add B’s retry normalization and paginated self-scoped reminder queries, while keeping A’s fuller reminder schema and atomic transaction wording. [B](/Users/developer/IdeaProjects/agent-loop-collaboration/.scratch/agent-collaboration-tools/design-b.md:79)

B also rejects newly submitted reminders whose deadline has already passed. The approved spec leaves overdue handling open, while A explicitly makes overdue reminders eligible on the next scan. A’s behavior fits the recovery requirement more directly.

## Shared blocking flaw

Both designs depend on a post-commit sweep. A says to request a sweep after commit and use polling as recovery. B says to schedule promptly and recover committed rows after restart. Neither design states the exact startup ordering or a durable wake marker proving that a process crash between database commit and scheduler invocation is observed before normal admission.

Make this an implementation and acceptance gate. Simulate exit immediately after committing a message or firing a reminder, restart, and verify exactly one input reaches the existing drain path. Both designs are otherwise source-complete sketches, not implementation evidence.