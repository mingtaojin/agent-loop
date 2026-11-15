# Feishu approval and project decision cards

This change has local adapter, Runtime, SQLite and restart coverage. The test suite uses controlled Feishu API and CardKit doubles. It does not prove behavior in a real tenant.

The native approval card remains bound to one Worker task, Thread, turn, request ID and connection epoch. The project decision card is a separate action type bound to the project coordinator and project group. A project decision is recorded in the project ledger and inserted as a coordinator input with `project_decision_card` provenance. It never calls the native approval responder.

Both cards use an authenticated opaque token, owner and chat validation, bounded visible text, one-shot receipt handling, runtime expiry, persisted card and message identity, CardKit sequence and UUID state, and an `uncertain` terminal state. Unknown delivery or update outcomes do not replay the business operation.

Real tenant acceptance remains a separate gate. The target app must have the tenant permissions required by the message send, card create, CardKit update, group lookup and event subscription APIs. Verify the exact scope names in the current Feishu developer console for the target App ID before testing. The owner account must be able to operate both cards in the Worker task group and project coordination group.

The tenant run must record the App ID, granted tenant scopes, callback event payloads with secrets removed, client versions, card and message IDs, CardKit response codes, and SQLite card receipts. Exercise owner approve and reject, preset and custom decision submission, duplicate submission, expired card, cross-group or cross-card token, Runtime restart recovery, and CardKit processing and final updates. A local fixture pass does not count as evidence for these tenant cases.

Not verified in this implementation are real tenant form callback shape, Card JSON 2.0 client rendering, CardKit update behavior, tenant permission grants, callback latency, and owner-visible final card state. Deployment, restart and production data changes were not performed.
