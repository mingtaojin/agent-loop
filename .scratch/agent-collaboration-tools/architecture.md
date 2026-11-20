# Collaboration implementation contract

Use design A as the base, with B’s explicit migration dispositions, live group receipt identity and paginated reminders. Both candidates selected the direct inbox/outbox shape and rejected a second replay journal. The lead initially scored both 10/10. Independent read-only GPT-6.2 Astra scored A 10/10 and B 9/10 because B’s schematic reminder union omitted immutable identity fields. The implementation includes those fields. The reviewer’s crash-window finding becomes an explicit acceptance test: restart after transaction commit but before scheduling must deliver the persisted input once. The pending inbox is the durable wake record; no second wake marker is required if recovery proves that behavior.

## Agreed public contract

- Three native tool names: project_action, send_agent_message, send_group_message. Strict schemas derive types and JSON schemas. The latter two have independent validated capability fallback ingress for retained Threads. No callable send/report/deliver_result/announce management aliases.
- Agent message arguments: requestId, taskId, text, optional references. taskId is the recipient, matching existing naming. Caller identity comes from the authenticated transport. Coordinator↔own Worker only.
- Group message arguments: requestId and text. The caller's verified current group is pinned at acceptance. Native questions, approvals, permissions and request_decision remain distinct.
- Reminder management: schedule_reminder(requestId,dueAt,text), list_reminders(offset?,limit?), cancel_reminder(requestId,reminderId). Owner comes from caller. dueAt is a finite, safe epoch millisecond in the supported date range. Overdue accepted values fire on the next due scan.
- Cleanup: cleanup_artifacts gains taskId and explicit scopeIds. Only coordinator can clean self or own Worker resources, including completed ones. complete_task persists conclusion/history without cleanup.

## Ownership

ProjectRuntime owns identity and durable operation acceptance. Store inbox/outbox own transport state. A small indexed reminder table owns schedule/cancel/fire; one transaction inserts its input and marks fired. AgentLoop owns nonblocking scheduling, pause/recovery, and original Thread input. TaskCloseout owns completion history and physical cleanup admission.

## Chosen grafts and constraints

- From A: keep taskId and require own ID for Worker open_group; avoid a new optional-target interpretation. Schedule recipient sweep without awaiting another Agent lane.
- From B: no post-upgrade publication from an unpublished old declaration. Archive it with an explicit disposition; accepted existing inbox/outbox rows keep original IDs and recovery. Retain uncertain outcomes visibly. Do not inspect historical final text to invent messages.
- From both: settle old implicit completion cleanup before recovery; retain completed history and partial deletion evidence, stop untouched implicit targets. A new explicit cleanup may use the exact preserved target identity.
- From both: fresh worktree acquisition after cleanup needs a persisted generation so old resource tombstones and frozen cleanup cannot target the replacement.
- Keep the current two-argument project-client management invocation usable; add a named-tool argument for message calls. The old business actions themselves are rejected.
- Migrate exact known Runtime-generated prompt fragments only. Preserve user goals, decisions and explicit restrictions. New developer/input context supersedes obsolete tool directions in retained conversations.

## Parallel implementation

1. Messaging branch owns tickets 01–04, protocol/fallback changes, both production role prompts, project runtime legacy result migration, affected existing tests and executable sample callers.
2. Reminder branch owns ticket 05, reminder persistence/provenance, narrow project action additions, tick/recover due scan, focused tests.
3. Lifecycle branch owns tickets 06–07, TaskCloseout migration/history, original Thread continuation, resource generation, dashboard projection and focused tests. It uses existing send tests on its base; integration migrates those calls to the new message API.

Each branch works from b053f4d in a different worktree. Integrate messaging first, reminders second, lifecycle third. Resolve shared schema/loop/runtime changes deliberately. Each branch records tests and remaining integration concerns. Final acceptance checks the combined native tools, retained Threads, actual Codex behavior, and isolated resource transitions.
