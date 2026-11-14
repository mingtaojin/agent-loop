Status: ready-for-agent

# Issue-linked PR delivery

## Confirmed request

The user requests delivery through a working branch, a pull request linked to
the source GitHub Issue, and merging the pull request. Message ID:
om_x100b6067556984a8de3d60f2b4729f7.

Creating and merging that PR is already authorized within the clarified task
scope. Deployment and service restart remain outside the request.

## Initial evidence

- Issue #3 is open.
- Its image-path fix fbdaa8b86f216ccf661e75053c7e92736f239b46 has already been
  pushed to the remote main branch.
- A branch from that main revision has no remaining image-fix diff to merge.
- prompts/task.md currently says not to create a PR or merge by default.
  ADR 0006 assigns workflow decisions to the Agent, rather than a fixed Runtime
  business state machine. A future default change belongs in task guidance.
- Existing unrelated working-tree changes are preserved.

## Confirmed scope

The user selected re-delivery of this issue #3 through PRs in message
om_x100b60677b6430b8df62a3de7008c54. Do not reopen the settled question about
creating and merging a PR for this task. Permanent default-workflow changes are
outside this selected scope.

## Delivery plan

1. Reconcile source, branch, remote and PR state after the interrupted turn.
2. Create isolated branches for reverting the prior direct-push commit and for
   reapplying its exact patch. Preserve every unrelated working-tree change.
3. Prepare both PRs before landing either. The preparation PR references #3
   without a closing keyword. The repair PR uses Fixes #3.
4. Independently verify both changes, verify the repaired tree matches the
   originally tested tree, and retain before/after evidence.
5. Merge the preparation PR, retarget the repair PR to main and merge it after
   checks describe the current patch. Use ordinary commits without force-push.
6. Verify both PRs are merged, #3 is closed, and the final source tree contains
   the original fix. Keep deployments and service operations outside this work.

The first merge temporarily restores the pre-fix source on main. Preparing and
verifying both PRs first bounds that transition. The second merge restores the
original fix. No running service is switched by this procedure.

## Comments

Initial recovery reconciliation found no created PR or branch for this request.
gh is the selected forge because Origin is not installed.

## Completion

All six delivery-plan steps are complete.

- Preparation PR #5 merged into main as
  1141106801776374763b65f1aac2b10f0020efbd.
- Repair PR #8 was retargeted to main, verified to have a formal closing link to
  issue #3, and merged as 92ca6d7089cbe0c21d78b023c194efae88e2eb9f.
- Issue #3 automatically closed on 2026-11-12T05:28:43Z.
- The final tree equals the main tree immediately before redelivery, including
  the intervening documentation and dashboard changes. The six original fix
  file blobs and stable patch ID match the original delivered fix.
- Preparation typecheck and 66 affected tests pass. Repair's full serial suite
  passes 379 tests; after upstream integration, typecheck and 82 selected tests
  pass. Both PRs have independent DeepSeek PASS+NOTES verdicts recorded.
- Native acceptance reuses the earlier identical-patch evidence. A subsequent
  replay failed provider connection/429 and is not claimed as a new pass.
- Original working-tree file bytes remain unchanged. No service operations,
  deployment, force push or history rewrite were performed.

The main working directory retains unrelated uncommitted changes and was not
fast-forwarded across them. Remote main is verified at the repair merge commit.
See state.json, audit.json, the two verdict files and decisions.tsv for evidence.
