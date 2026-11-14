Status: ready-for-agent

# Implement coordinator group message and Feature authorization policy

Implement the behavior in the parent specification.

## Scope

- Add the coordinator-only `announce` project action with typed ordinary text delivery.
- Keep direct project-group user replies visible.
- Keep GitHub event and Worker report replies inside the coordinator Thread and execution history unless the coordinator announces them.
- Preserve native request, approval, permission, and Runtime failure notifications.
- Enforce the Feature proposal boundary in coordinator guidance and the project handoff path.
- Allow read-only Feature investigation while requiring a project-group authorization before implementation dispatch.
- Preserve existing authorized Feature Tasks.

## Acceptance

- Focused AgentLoop integration tests cover every visible and hidden message path.
- Duplicate announce requests are idempotent and changed retries conflict.
- Non-coordinators and cross-project callers cannot announce.
- A GitHub Feature cannot become an implementation Worker without recorded project-group authorization.
- An investigation-only Feature task cannot modify business code by its handoff contract.
- Type checking, build, focused tests, and the full local test suite pass.

## Comments

The design is recorded in the parent specification and ADRs 0017 and 0018. Deployment and service restart are outside this task.
