Status: ready-for-agent

# Resume failed tasks from owner follow-ups

The calibration-plugin task exhausted its recovery budget after model transport
failures. Four later owner messages remain pending because failed tasks return
before draining their inbox. Restarting the gateway or service does not clear
that state.

An owner follow-up received after failure must reopen the same task and Thread,
including already-persisted and offline messages. Revalidate saved resources
before reopening. Preserve explicit operator pauses, bounded automatic recovery,
input deduplication, and reconciliation of unknown delivery outcomes. Source
updates must not reopen failed tasks. A pending message already considered by a
failed recovery must not repeatedly reset its budget.

Verify the regression before and after the fix, run the runtime and service
tests plus type checking/build, then reload the launchd service and confirm
delivery of the original pending messages and fresh execution in the same Thread.

## Verification

- Before the fix, four targeted regression checks fail because the task stays
  failed or never reaches resource revalidation. See red.log.
- After the fix, all seven added regressions and all 309 project tests pass.
  Type checking and build pass. See all-tests.log, check.log and build.log.
- The launchd service was reloaded once from an idle state. PID changed from
  89229 to 94406. All nine task Thread/chat/resource identities were preserved.
- The calibration task resumed Thread 01a1c4f0-17b4-7340-a87d-cfee35e5f809,
  consumed all four pending owner messages, and produced new model text and
  real tool calls inspecting the calibration plan and retained worktrees.
  See live-acceptance.json and the repeatable read-only verify-live.py.
- This verifies recovery of the task; the calibration feature itself is still
  being implemented by its original Agent.
