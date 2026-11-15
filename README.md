# PI Factory — Event Bus integration

Copy `src/orchestrator.ts`, `src/factory-cli.ts`, and `tests/orchestrator-events.test.ts` into your existing PI Factory repository. The previously installed `src/event-bus.ts` is required but unchanged.

Run:

```powershell
npm run check
npm test
```

The CLI now creates `.factory/runs/<run-id>.events.jsonl` in the target repository and prints events while executing. The orchestrator emits lifecycle events for task execution, agent calls, verification, review, repairs, checkpoints, and final verification. This patch does not stream individual PI tokens or tool calls.

The event log is observational, not a source of truth for task status. The existing state store remains authoritative.
