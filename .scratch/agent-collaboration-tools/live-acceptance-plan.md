# Live collaboration acceptance

The user explicitly authorized creating a dedicated test project and Feishu groups for marker-only acceptance. This is separate from deployment.

## Target

Use a new canonical temporary project, separate SQLite database and new Codex Threads. Copy only necessary execution and Feishu identity settings from the configured local application. Load credentials through the existing environment file without logging their values. Keep production data, existing groups and launchd untouched. The actual Feishu adapter may list bot chat metadata to reconcile the unique new fixture group IDs; read message content and write only in fixture groups. Do not start another production-bot WebSocket consumer. Keep created groups and evidence for review.

## Predicate

1. A real no-group Worker reads a unique fixture marker and sends it through send_agent_message while its original turn remains active.
2. The real coordinator receives that marker in its original Thread, performs the next tool action, and explicitly sends a marker reply to its dedicated group. Its ordinary final marker does not appear automatically in the group.
3. The Worker opens its own group and its ordinary commentary and final appear without additional group-message calls.
4. The coordinator schedules a one-shot reminder, receives it later and performs a concrete follow-up.
5. Persisted input IDs, provider message IDs and actual group readback substantiate the result. No duplicate Worker or delivery is created.

## Independent verification

A fresh verifier runs the probe at the integrated artifact identity and reports PASS, FAIL or BLOCKED. Record the commit, command, timestamps, authorized test group IDs, relevant tool calls, durable input status and real provider receipts. Distinguish a harness-injected input from a real owner webhook event. Do not report a fake transport as actual group acceptance.
