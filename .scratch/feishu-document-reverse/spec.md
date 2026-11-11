# Newest messages first

Status: ready-for-agent

The user explicitly requested reversing the progress document and then restarting the local service. Render messages newest first, preserve each message's line order, omit tools, and retain the latest conversation within the existing 3000-line budget. Keep original task/document/tab identities.

The existing conversation remains chronological internally. Only document rendering and the oldest-message retention boundary change. Test observable message order, multiline reading order, and line-cap eviction. Run the focused conversation/publisher/adapter checks and type/build checks. Then perform the already authorized launchd restart once and read actual Feishu blocks to verify descending timestamps, exact saved content and healthy runtime.

If restart interrupts the supervising conversation, first reconcile `restart-before.json`, current launchd PID, heartbeat, task identities and publication state. Do not repeat the restart when the PID already changed. Run the live verifier only after publication completes.

Local preflight passed all 42 focused tests, type checking and build. User authorization includes the restart. A before-restart snapshot is saved in restart-before.json. After interruption, reconcile PID first, then run `node --env-file=.env --import tsx .scratch/feishu-document-reverse/verify-live.mjs`; it reads actual Feishu blocks and asserts descending message timestamps. Do not rerun a restart whose new PID is already observed.
