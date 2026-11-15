# Event Bus module

Copy `src/event-bus.ts` and `tests/event-bus.test.ts` into your PI Factory repository.

Run:

```powershell
npm run check
npm test
```

## Example (integration in a later step)

```ts
const bus = new FactoryEventBus({
  runId,
  logFile: join(repository, '.factory', 'runs', `${runId}.events.jsonl`),
});
bus.emit({ type: 'TASK_STARTED', taskId: 'T001' });
// ...
await bus.close();
```

This module is not yet wired to `src/orchestrator.ts` or `src/factory-cli.ts`. It records only explicitly emitted events. Avoid putting secrets or raw prompts into `message` or `details`.
