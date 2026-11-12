# Dashboard task groups

Status: ready-for-agent

## Goal

Show tasks under project groups, then status groups. Keep tasks easy to find as their output changes and the task count grows.

## Confirmed decisions

- 2026-11-12: Group by project, then by existing task status. Source: GitHub issue #2 and its recorded user decision.
- 2026-11-12: Implement and complete local verification. User message: om_x100b60664da348b4df7e320172f3cef.
- 2026-11-12: Show a task in every associated project. Every occurrence opens the same task. Count the overall task total by unique task ID. User message: om_x100b606644d520acdfcec7539502795.
- 2026-11-12: Develop in an independent Git worktree, preserving parallel changes in the original checkout. User message: om_x100b6066614ebc84c0547f6de8a09e7. Worktree branch: feature/dashboard-task-groups-4942d8bb, base: 894c24d.
- 2026-11-12: Commit and push this independent branch, open a PR linked to Issue #2, merge the PR, and close the issue. User message: om_x100b60676ec4c480c1d909549002558. This authorization supersedes the initial local-only delivery boundary.

## Acceptance

- Both project and status groups have disclosure controls and accurate counts.
- Tasks without project resources appear in an unassociated group.
- Search by title and full task ID and the status filter remain available.
- Polling preserves selection, disclosures, and the list reading position.
- Output and updatedAt changes alone do not reorder tasks.
- A status transition moves each occurrence to its new status group without changing the selected detail or its event stream.
- Verify desktop and narrow-screen behavior in a real local browser, including a scrolling list and multiple refreshes.

## Implementation rules

- Use the exact saved project ID for modern resources and the case-insensitive full repository name for historical resources. Keep their identity namespaces separate. Labels and task worktree paths do not identify projects.
- Sort projects by label with stable identity as tie-break and the unassociated group last. Derive status order from the existing filter. Sort tasks by createdAt descending then full ID, independent of updatedAt.
- Default project and status groups to expanded. Keep normal and filtered disclosure choices separately. Filtering reveals matching groups by default; clearing filters restores normal disclosures.
- Retain DOM nodes by project, status group, and project/task occurrence identity. Restore reading anchors after structural changes without following a moved task into a different status group.
- Keep the existing visual language and task detail behavior. On narrow screens use a bounded vertical grouped list.

## Delivery boundary

Deliver this feature through an independent branch and a PR linked to Issue #2, then merge that PR and close the issue. Preserve unrelated worktrees and changes. Service deployment and restart remain outside the scope.

## Comments

- The initial issue only registered a requirement. The later user message explicitly authorizes implementation and local verification.

## Implementation and local verification

Implemented in src/dashboard-page.ts on feature/dashboard-task-groups-4942d8bb, based on 894c24d. Only the page source changes; runtime task state, persisted resource identity, API projection, and event-stream ownership retain their existing contracts.

- Type checking and build passed. The complete suite passed serially with 370 tests and zero failures. An earlier concurrent run had three initialization timeouts in unchanged selector tests; that entire file passed separately with 21 tests and zero failures.
- Real system WebKit passed at 1440x1000 and 390x844 with isolated SQLite fixtures. The fixture starts with 78 unique tasks and grows to 79 after insertion. Membership, counts, fold state, title/full-ID search, status filters, untrusted titles, same-task stream retention, and project reassociation passed.
- Reading-anchor offset stays 25.46875 px before insertion, after insertion, and after the selected task changes status, at both viewports. This measures the same visible row relative to the list viewport at each change.
- A fresh DeepSeek verifier completed browser acceptance and a cross-model audit with no flags. An enforced read-only source review reported no correctness findings.
- Source SHA-256: d4017103c600c940ed6f37c116312524e4414c045a8db712bc3b549ccd17b87c.

Local evidence is in verification/acceptance.md, verification/browser-results.json, verification/source-review.md, verification/tests-serial.log, verification/desktop.png, and verification/mobile.png. Rerun browser acceptance with python3 .scratch/dashboard-task-groups/verify-browser.py in this worktree. The harness uses macOS system WebKit and disposable local data, not the resident service.

The original local acceptance preceded Git delivery. The delivery branch subsequently incorporates main at fbdaa8b; that upstream change does not modify the dashboard page or API. Git delivery status is recorded by the PR linked to Issue #2. No deployment or resident-service restart is included. Historical repository and modern project identities remain separate because the snapshot does not establish cross-namespace equivalence. Disclosure state persists for the page lifetime; browser reload persistence is outside this requirement.
