# Group the dashboard task list

Status: ready-for-agent

Local implementation and verification completed on feature/dashboard-task-groups-4942d8bb. The user subsequently authorized committing and pushing this branch, opening a PR linked to GitHub Issue #2, merging that PR, and closing the issue. Service activation remains outside the scope.

- [x] Group tasks by stable project identity and then existing status.
- [x] Show tasks under every associated project, deduplicating repeated resources and global totals.
- [x] Provide project/status disclosures and accurate group counts.
- [x] Retain selection, disclosures, focus and reading anchors across polling and status transitions.
- [x] Preserve title/full-ID search, status filters and task detail/SSE identity.
- [x] Handle unassociated and historical resources without guessing identity mappings.
- [x] Verify desktop and mobile with real system WebKit and disposable fixture data.
- [x] Complete build, 370-test serial suite, read-only source review and independent acceptance.

See ../spec.md for decisions and local verification evidence. The current resident management service has not been switched to this worktree.

## Comments

The first browser attempt found an invalid fixture configuration copied from the dirty original checkout. Parsing repositorySchema defaults fixes the fixture on the independent base. No application change was needed. The initial blocked report is retained as verification/acceptance-initial-blocked.md.
