Status: ready-for-agent

# Require project coordination for every new request

The user requires every project to use its own coordinator. Remove Runtime's
fallback that turns a GitHub Issue, Feishu direct message, or CLI submission
straight into an independent execution task.

## Acceptance

- Every newly created formal execution Thread belongs to a coordinator or a
  coordinator-delegated worker/verifier.
- Matching GitHub Issues are delivered to their project's coordinator. An
  unregistered repository cannot fall back to an ordinary worker.
- Feishu direct messages and CLI submissions select a project and deliver the
  complete request, attachments, and provenance to that coordinator.
- An unknown or ambiguous project remains an intake clarification, without an
  execution Thread or engineering changes.
- Project identity is canonical and durable. Retried inputs and restarts do not
  duplicate coordinators, delegated work, or delivery.
- Existing tasks keep their group, Thread, inputs, resources, and native approval
  association. Existing project ownership never changes silently. Legacy tasks
  acquire a coordinator before new engineering work can continue.
- The live Agent Loop repository also uses a project coordinator. OpenTest's
  repository, assignee, and Bug filters remain in force.
- Playbook decisions remain agent-owned. Runtime does not encode engineering
  phases or dispatch work automatically on behalf of a coordinator.

## Boundaries

Keep project discovery under the configured engineering root. Discovery does
not expand GitHub collection scope. Preserve unrelated dirty changes and all
existing task artifacts. Do not create external GitHub Issues for this work.

## Grounding

`AgentLoop.collectSources` currently routes project repositories to
`ProjectRuntime.collect`, but creates ordinary tasks for other repositories.
`receive` and `submit` independently create ordinary tasks as well. `setup`
creates a group before selecting its engineering entry and formal Thread.
`ProjectRuntime` already provides durable project membership, idempotent
dispatch, event delivery, and session rotation on the existing Task engine.
ADR 0010 made projects optional. This request makes coordination mandatory.

## Workflow

- [x] Read the Principles section of poteto-mode.
- [x] Phase A: Frame. Record scope, baseline, and the acceptance predicate.
- [x] Phase B: Design the workflow. Compare two independent type/API sketches.
- [x] Phase C: Run the loop. Implement and verify each unit below.
- [x] Ground / Sketch / Agree / Implement / Scrap (architect; scrap only if needed).
- [x] Add and verify intake persistence, project resolution, and recovery.
- [x] Remove ordinary creation from GitHub, Feishu, and CLI entry points.
- [x] Verify legacy adoption and absence of duplicate groups or Threads.
- [x] Update configuration examples, prompts, domain docs, and regression tests.
- [x] Phase D: Keep the audit trail at each implementation checkpoint.
- [x] Phase E: Verify and hand back. Check the actual compiled Runtime and
  delivery state, then independently review before integrating or restarting.

The throughput checkpoint follows the design comparison: count touched modules,
identify an independent coding seam, and begin implementation only after the
first acceptance test distinguishes the old and new routes.

## Verification

See docs/verification/coordinator-only-intake.md. The legacy adoption probe uses a
copy of the running SQLite database and compares saved execution identities.
The actual CLI intake/delegation acceptance probe passed with controlled platforms.

Implementation and live migration completed on 2026-11-12. All 484 tests,
type checks, build, and the actual CLI acceptance probe passed. Live checks
matched launchd, listener and advancing heartbeat PIDs. All 23 original tasks
retained their group, Thread, resources and request identities. Both project
coordinator groups were read back from Feishu. New GitHub intake and an actual
coordinator dispatch were observed in the running database.

The service runs the compiled implementation from its isolated worktree with
the original configuration and data directory. The canonical checkout's
unrelated source changes remain untouched. Git delivery is recorded separately
from live deployment.
