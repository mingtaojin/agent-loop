# Task resource closeout implementation

## Figure it out

- [x] Read the Principles section of poteto-mode.
- [x] Phase A: Frame.
- [x] Phase B: Design the workflow.
- [ ] Phase C: Run the loop.
- [ ] Phase D: Keep the audit trail.
- [ ] Phase E: Verify and hand back.

## Throughput checkpoint

- Blocking first steps. Fetch latest main, isolate worktree, preserve original changes, ground lifecycle/resources, compare two design sketches, run baseline checks.
- Independent workstreams. Two grounding readers and independent design candidates write separate artifacts. One implementation owner writes coupled lifecycle/model/tests. Lead owns audit and PR delivery.
- Shared mutable state. Original checkout is protected. SQLite and Task transitions stay under the existing single Runtime owner and task lanes. No concurrent code writers.
- Smallest safe decomposition. One feature PR because lifecycle, safe cleanup and caller guidance must agree atomically. A single code owner keeps resource identities and completion guards consistent.

## Workflow

1. Ground current lifecycle and resource-release contracts.
2. Compare two concrete type and module designs; synthesize one owner/API.
3. Implement data model, project actions, lifecycle guards and restart-safe cleanup with Runtime integration tests over real SQLite/files/Git.
4. Update coordinator/Worker guidance and user documentation.
5. Run typecheck, build and full suite; drive an isolated Runtime acceptance fixture.
6. Run independent enforced read-only review and independent behavioral verification of the exact candidate.
7. Push scoped branch, open PR, verify current head/base and merge to main.
8. Verify remote merge, protect original dirty checkout, report deployment separately.

## Definition of done

The published spec is implemented at the agreed Runtime seam. Eligible task-owned resources are removed after explicit coordinator closeout. Protected and historical resources survive. Completion persists cleanup intent and retries safely across restart. Followups never reactivate completed Tasks. Coordinator scoped artifacts can be cleaned without ending its Task. Exact PR head passes tests and independent review and is actually merged into remote main. No running service is restarted or deployed.

## Rigor and scope

High rigor because filesystem deletion is irreversible. Expected scope is one data owner for resources/closeout plus integration into existing project action, Runtime lifecycle, workspace provider and guidance. Actual deletion acceptance uses disposable fixtures only. Source/worktree protection and before/after checks are mandatory.
