# Native approvals and retired project decision cards

ProjectRuntime project decision cards are retired. `project_action` rejects `request_decision`, and the Feishu adapter has no project card sender or decision handler. An old `agent_loop_card` button or form callback returns an explicit read-only toast. It does not write a receipt, ledger record, coordinator input or CardKit update. A callback containing both retired and native fields also receives the read-only result.

Historical project records, receipts, card identities and `project_decision_card` input provenance retain their stored formats and remain readable. Execution selects an active inbox view that excludes this historical provenance. Pending, held, failed and uncertain project card inputs cannot start or steer a turn, answer a question, reopen work or block an ordinary input after restart. Pause, recovery, resume and attachment retry do not rewrite those historical rows. Full history reads retain their original status and payload. No migration or deletion is required.

Native Codex approval cards remain active. Their buttons and authenticated token bind a response to the owner, task, chat, Thread, turn, request ID and connection epoch. The existing durable queue, duplicate rejection, uncertain outcome handling and Codex responder remain in use. Command, file-change and permission requests retain their response mapping. Native `question` requests continue to accept ordinary text answers through the question responder. Ordinary messages do not become native approvals.

Project coordination continues through existing owner text, Agent messages and the project `record` operation. This change adds no natural-language approval interpreter or new decision workflow. Other messages and cards retain their existing routes. Deployment, service restart and production-state changes still require their existing separate authorization.

## Local checks

Run the focused behavior suites and repository checks with Node 24 or newer:

```sh
npx tsx --test test/feishu-decision-cards.test.ts test/project-runtime.test.ts test/runtime.test.ts test/platforms.test.ts test/codex.test.ts test/service.test.ts
npm run check
npm test
npm run build -- --outDir <artifact-scope>/build
```

The retirement tests use disposable SQLite stores and controlled Feishu and CardKit APIs. They cover rejected generation, read-only historical callbacks, restart and input consumption boundaries. The native regression suites exercise card delivery, callback identity checks, approval receipts, Codex protocol responses and question replies. These local runs do not establish real tenant behavior.

## Verification limits

A real Feishu tenant check requires separate authorization. Tenant event delivery, client rendering, CardKit network behavior, granted scopes, callback latency and the owner-visible state of previously sent cards are not verified by local fixtures. An old external card may still show its original buttons, but its callback returns the read-only result. This change does not update or delete external historical cards.
