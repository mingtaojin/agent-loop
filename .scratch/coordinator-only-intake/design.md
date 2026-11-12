# Mandatory coordination design

Use the existing Task row as a threadless intake record. This keeps request IDs,
inbox ordering, attachment ownership, and CLI receipts stable. A new `purpose`
discriminant distinguishes `intake`, `execution`, and unreadopted `legacy` rows.
ProjectLedger remains the only authority for execution roles.

`AgentLoop.advance` resolves intake or adopts legacy work before any formal
execution. `setup`, turn delivery, approvals, resume, and workspace operations
require project membership. Temporary read-only selection Threads remain
separate. Intake never creates an engineering workspace or task group.

ProjectRuntime owns a persistent catalog of explicit projects and projects
resolved from the configured engineering root or local repository roots. It
creates one coordinator per canonical project. Discovery never expands the
configured GitHub source list. Unknown project choices remain clarification.

All three ingress APIs persist intake. The coordinator receives the original
materials and stable intake ID, then uses `dispatch(intakeTaskId)` to promote
that record into a worker. Promotion preserves source, inbox, cached attachment
paths and request identity. Delegation instructions are present before the first
worker turn. A second dispatch cannot promote the same intake again.

Existing execution tasks acquire membership in place from saved resources and
repository/project mappings. Ambiguous tasks keep their artifacts and accept
clarification but cannot start new unowned work. Existing members never change
project. Adoption preserves paused/failed state and native approval identity.

## Comparison

Candidate A separates intake into its own registry and receipt protocol. It
isolates execution types but duplicates source identity, inbox/attachment state,
and recovery. Candidate B reuses those existing structures and adds one formal
execution boundary. Choose B for the smaller persisted model and stable CLI
request identity. Graft A's requirement to fence every execution entry and keep
automatic project definitions separate from GitHub collection targets.

Both candidates were read in full and screened against architect's design red
flags. A different-family cross-judge was skipped because subagent model
overrides are not authorized by the available tool instructions. A fresh source
review and compiled Runtime verification remain required before delivery.

## Throughput checkpoint

Baseline: 474 existing checks passed; the two new acceptance tests fail on the
old ingress behavior. Work touches the Task schema, catalog/project runtime,
loop/CLI entry points, prompts, and their tests. Split project/catalog ownership
from loop/ingress ownership. Verify that seam first, then migrate the affected
runtime test fixtures to coordinated execution rather than preserve ordinary
creation as a hidden test mode.
