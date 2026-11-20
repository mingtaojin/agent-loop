# Design rubric

Score each candidate from 0 to 2 on each criterion. Zero means missing or incorrect, one means workable with a named gap, two means complete and supported by source.

1. Tool contract. Two independent message tools enforce coordinator↔own Worker routing and separate human delivery without a second public route.
2. Durable delivery. Reuse persisted inbox/outbox and unknown-ack reconciliation; do not recreate an independent messaging runtime.
3. Lifecycle. Completion, cleanup admission and resumed original Thread preserve identity, pause and filesystem constraints.
4. Migration. Existing Threads get usable tool ingress and updated instructions; old delivery/completion state cannot replay or newly delete resources.
5. Maintainability and verification. Small ownership boundaries, no competing writers or duplicated schema lists, observable tests and a realistic live probe.
