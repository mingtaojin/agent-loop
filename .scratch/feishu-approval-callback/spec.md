# Approval callback response

Status: ready-for-agent

Implementation: complete locally. Full serial suite 380/380, TypeScript check and build pass.

Acceptance: local SDK/Runtime verified; real Feishu client acceptance blocked and historical click root cause unproven. No deployment.

An authenticated Feishu approval click must receive an explicit interaction response after its durable receipt. Native resolution continues through the existing task lane and cannot be replayed by a duplicate callback.

## Verified behavior before the fix

The installed SDK probe returns `code: 200` and an info toast for the first accepted click. If the handler rejects a duplicate action, the SDK returns `code: 500` with no toast. Real AgentLoop and SQLite integration tests fail for both approve and reject when the duplicate exception escapes the callback. Existing native-resolution gate and restart tests pass.

The Runtime already inserts the approval before returning and schedules native resolution without awaiting it. Moving receipt acknowledgement before persistence would weaken the current contract and does not address the observed branch.

## Selected design

Keep the existing `Promise<void>` action-handler contract and stable per-request database key. Convert callback failures to an error toast at the Feishu adapter boundary. Record safe correlation metadata for failures. A successful action response replaces the card buttons with an explicit receipt, distinguished from native confirmation or command completion.

The independent design comparison considered a typed cross-layer receipt union as an alternative. It would change domain, ports, Runtime and adapter to classify outcomes. The bounded repair keeps these contracts and uses the existing handler success/failure boundary.

## Verification

- First approve and reject create exactly one durable row before the callback succeeds.
- Gated native confirmation does not hold up the callback.
- Same and conflicting duplicate clicks do not create another row or native call.
- Expired, invalid, unauthorized and persistence-failure paths return accurate feedback without a success receipt.
- An error in diagnostic reporting cannot turn failure feedback into SDK rejection.
- The installed SDK probe returns a 200 envelope with explicit failure toast for duplicate handler failure.

## Evidence limits

The original screenshot was downloaded without modification. Its SHA-256 matches `1d4ed685276b2ec43ea5006d0a0ed2e68ce98fe544f9c51a7dfad933193a421e`.

The historical click has no correlated callback duration or wire-response capture. The reproduced exception path is not proof of the screenshot's exact cause. A source observation that SQLite has a five-second busy timeout is also not evidence that database contention occurred in that incident. Global persistence policy is outside this patch.

No production restart, deployment, original-card replay, external message, Git commit or PR is part of this repair. Actual Feishu client rendering and disappearance of the reported timeout require separate authorized client acceptance with the fixed artifact.

References: [official callback receiving guide](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/receive-and-handle-callbacks), [card callback response structure](https://open.feishu.cn/document/feishu-cards/card-callback-communication).
