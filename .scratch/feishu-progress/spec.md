# Feishu execution progress cards

Status: done

## Confirmed scope

On 2026-11-07 the user accepted the recommended Feishu progress-card design and requested implementation using poteto-mode. Each execution turn sends one card to the existing task group. Updates show execution state, recent user-facing assistant text, tool activity and bounded command output. Updates are coalesced around one second. The final answer remains a separate ordinary message. Native questions and approval requests retain their existing delivery paths. Full output remains in the dashboard, with an optional configured link from the card.

Cards show the last actual event time; a heartbeat alone never claims execution progress. Restart recovery must reuse saved card identity and preserve update ordering. Progress-delivery errors must not interrupt agent work or suppress final responses. Do not backfill cards for old completed turns when the feature is first enabled.

## Workflow

- [x] `how` over the affected subsystem.
- [x] `architect` for parallel design exploration.
- [x] Write the throughput checkpoint as four todo items.
- [x] Delegate code-writing to a subagent using the configured feature model.
- [x] Verify on the matching surface.
- [x] Rebase into small, ordered commits. Skip: local project has no Git metadata, no commit requested.
- [x] If the design is contested, `interrogate` before shipping. Skip: no unresolved design dispute; independent runtime and protocol reviews completed.
- [x] Run Opening a PR. Skip: no PR requested.

## Throughput checkpoint

- Blocking first steps: establish existing event and message contracts, verify CardKit permission and API semantics, save a source baseline before changes.
- Independent workstreams: compare two designs while checking the actual Feishu API; implementation has one owner, verification is reviewed independently.
- Shared mutable state: one publisher owns each card and its sequence; no parallel source edits or runtime restart during implementation.
- Smallest safe decomposition: transport, persisted publication lifecycle and bounded presentation form one cohesive feature; verify with controlled events before live activation.

## Architectural grounding

Codex events are normalized by execution-events.ts and persisted by AgentLoop. The dashboard reads these same events. AgentLoop.observe forwards only final assistant messages; FeishuAdapter currently supports ordinary messages and approval cards. Progress publication adds an independent delivery path and does not change the execution state machine.

## Design rubric

Compare recovery correctness, isolation from execution, bounded data and API traffic, protocol idempotency, and module/interface size. Architect phases are Ground, Sketch, Agree, Implement, Scrap; agreement is already covered by the user's approved behavior and does not require another product question. Arena phases are Frame, Fan out, Cross-judge, Pick, Graft, Verify.

## Verification

Final source regression passed 221 tests with zero failures (`final-after-recovery-tests.log`). Type checking passed. Real API evidence covers same-card updates, isolated runtime restart, stream closure, separate final delivery, and exact message reconciliation without a new send. The final adapter candidate filter also passed a read-only real API lookup (`final-lookup-acceptance.json`).

The user's 2026-11-07 screenshots confirm the card itself renders on mobile. The linked dashboard fails with ERR_TIMED_OUT over 5G. The URL is a private LAN address; a local HTTP request returns 200. This does not establish external accessibility.

## Confirmed mobile decision

On 2026-11-07 the user chose "先用卡片实时输出" after the network investigation and grill-with-docs clarification. Enable cards without dashboardUrl and remove the inaccessible button from the acceptance card. Do not configure an external dashboard endpoint in this task. Local dashboard access remains available. Record activation and task-identity checks after restarting the authorized services.

## Activation

Enabled card-only output in local config and restarted the dashboard (87693 to 48562) and launchd runtime (35675 to 48650). All four tasks retain their original Thread, chat and resource identities. The other three historical tasks received no cards. The active turn published message `om_x100b61df30862ca0b089baabb5cfb39`, and two real API readbacks observed its sequence advance from 5 to 12 with new live commentary and no webpage button. Runtime heartbeat advanced. Dashboard SSE decoded turn_status without protocol error events. Evidence is in activation-acceptance.json, activation-followup.json and activation-result.json.

The first SSE probe used the wrong query parameter and was corrected. A subsequent raw substring assertion matched its own command text inside tool output; parsing SSE event lines instead verified zero stream-error events. Neither was a service defect or required application changes.

The old acceptance card's button was removed and read back successfully (mobile-link-fix.json). User screenshots establish card rendering before removal; final button removal and active live updates were verified through API readback, not a second mobile screenshot. Full regression, type check and build preceded activation, and application source did not change afterward.
