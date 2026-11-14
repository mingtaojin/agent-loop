---
status: accepted
---

# Keep Feishu history backfill outside task execution lanes

Feishu history requests run outside the per-task execution lane. A successful fetch writes deduplicated owner messages and advances the history cursor before scheduling task advancement; a slow or failed fetch cannot delay a live user message for that task. Reconnects request one coalesced backfill pass, while the periodic collection remains a fallback. Failure notices use durable per-task state so a transient outage does not flood the task group.
