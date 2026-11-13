# Task closeout design synthesis

Base is the separate SQLite closeout ledger candidate. The existing Task JSON remains the execution/context snapshot. A single TaskCloseout owner in the existing SQLite writer owns allocation provenance, formal completion, frozen cleanup intents and per-resource receipts. No completion flag is copied into ordinary Task saves.

## Comparison

| Criterion | Task embedded aggregate | Separate closeout ledger |
| --- | --- | --- |
| Stale Task snapshot cannot erase completion | Requires changing central Store write semantics | Authority is separate by construction |
| Completion and cleanup intent atomic | One protected aggregate write | One envelope transaction in existing SQLite |
| Ownership and retry safety | Fresh scopes and frozen identity | Same core protections with one dedicated writer |
| Existing callers and adapters | Every Task writer inherits merge semantics | Existing Task writes preserved; admission reads one owner |
| API and testing scope | More Task schema/write coupling | Four scoped project operations and existing status seam |

Both candidates converge on Runtime-created fresh scopes, no arbitrary existing-path adoption, frozen allocation identities, process-use checks, new Task for followups, and conservative ordinary release. Ledger is smaller at the mutable-state boundary and avoids requiring every future Task writer to preserve destructive authority.

Grafts from embedded candidate: explicit acquire/allocate in-flight guard before acceptance, separate worktree and branch progress, durable disposal path identity for interrupted directory removal, coordinator scopes sealed independently.

The configured model pool is GPT-only and provides no eligible different-family arena judge. Cross-family judge is skipped under the explicit model configuration. Two independent Astra candidates were read end to end and compared by the lead. Independent source review and behavioral verification remain mandatory before merge.

## Contract

- project_action exposes allocation, artifact registration/delivery hold, coordinator completion+cleanup acceptance, coordinator own scoped cleanup, and live status. Exact action names stay schema-owned.
- New Task receives a fresh default artifact scope; existing Task resources remain historical unless a new scope/worktree is allocated under the mechanism.
- Coordinator acceptance atomically saves completion+frozen cleanup intent, returns a stable operation handle, and never executes deletion while holding project/task lock order in reverse.
- Runtime mechanical progress checks actual idleness, uncertainty, acquisition/usage, path/ancestor identity, sharing and process use. Unknown means pending.
- Default artifacts and Runtime-allocated fresh external children are owned; arbitrary pre-existing external contents are not adopted. Unique undelivered child protects its scope.
- Ordinary worktree release is unchanged. Explicit closeout may discard approved dirty/unmerged work and compares frozen branch identity when removing the local ref.
- Recovery checks completion before restoring resources or starting the old Thread. Live/offline followups route to coordinator, who dispatches a fresh linked Task for new work.
- Coordinator scopes can close independently and never close the coordinator Task or erase durable records.

## Known implementation decisions to prove

Use the current supported local host for actual process-use probing and disposable tests. Unsupported/incomplete probes stay pending. Do not invent adapter archival semantics; logically seal and never reuse completed execution, and prove no active/unknown directory use before deleting a selected cwd, or add a verified supported adapter capability if required. Full sandboxing against malicious same-user processes is outside this feature, but ordinary substitution and managed concurrency must be tested.

## Native request reconciliation after independent review

Two further independent designs compared immediate durable completion with safe protocol denial versus a new closing lifecycle waiting for user resolution. Choose a completion policy bound to the existing durable ledger. It avoids a second seal registry and preserves the accepted completion timing. A synchronous authoritative pending-request assertion runs inside the final SQLite acceptance transaction after async discovery. Existing native requests prevent completion; subsequently arriving requests see completed state and receive only negative protocol responses. Denial is not a user answer or an approval. Acknowledgement uncertainty keeps cleanup pending.

The closing-state alternative needs new request-bound answer UI and a broader lifecycle, and is rejected for this feature. Command/file decline and empty turn permission grants are verified against locally generated protocol bindings. Questions have no cancellation answer variant, so use a JSON-RPC error and wait for resolution/terminal evidence rather than claiming a successful transport write settled them. Sealed IDs are excluded from adapter recovery/resumption. Denial errors do not kill the shared app-server. This does not revoke already auto-permitted shell execution; cleanup still waits for actual idle and process-use checks. Real provider progression after an error and notLoaded recovery remain unverified and must fail closed.
