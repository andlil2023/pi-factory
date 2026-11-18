import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type FactoryEventType =
  | 'RUN_STARTED' | 'RUN_COMPLETED' | 'RUN_BLOCKED'
  | 'TASK_STARTED' | 'TASK_COMPLETED' | 'TASK_BLOCKED'
  | 'AGENT_STARTED' | 'AGENT_COMPLETED' | 'AGENT_FAILED'
  | 'VERIFICATION_PASSED' | 'VERIFICATION_FAILED'
  | 'REVIEW_APPROVED' | 'REVIEW_CHANGES_REQUESTED' | 'REVIEW_BLOCKED'
  | 'REPAIR_STARTED' | 'CHECKPOINT_CREATED' | 'FINAL_VERIFICATION_PASSED'
  | 'FINAL_VERIFICATION_FAILED' | 'PLAN_REVISED';

export interface FactoryEvent {
  timestamp: string;
  runId: string;
  type: FactoryEventType;
  taskId?: string;
  agent?: string;
  attempt?: number;
  message?: string;
  details?: Record<string, string | number | boolean | null>;
}

export type EventInput = Omit<FactoryEvent, 'timestamp' | 'runId'>;
export type EventListener = (event: Readonly<FactoryEvent>) => void;

export interface EventBusOptions {
  runId: string;
  logFile?: string;
  consoleOutput?: boolean;
  clock?: () => Date;
  writeLine?: (line: string) => void;
}

export class FactoryEventBus {
  private readonly options: EventBusOptions;
  private readonly listeners = new Set<EventListener>();
  private readonly clock: () => Date;
  private readonly writeLine: (line: string) => void;
  private pending: Promise<void> = Promise.resolve();
  private failure: Error | undefined;
  private closed = false;

  constructor(options: EventBusOptions) {
    this.options = options;
    if (!options.runId.trim()) throw new Error('runId is required');
    this.clock = options.clock ?? (() => new Date());
    this.writeLine = options.writeLine ?? console.log;
  }

  subscribe(listener: EventListener): () => void {
    if (this.closed) throw new Error('Event bus is closed');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(input: EventInput): FactoryEvent {
    if (this.closed) throw new Error('Event bus is closed');
    if (this.failure) throw this.failure;
    const event: FactoryEvent = {
      ...input,
      timestamp: this.clock().toISOString(),
      runId: this.options.runId,
    };
    if (this.options.consoleOutput !== false) {
      const scope = [event.taskId, event.agent, event.attempt === undefined ? undefined : `attempt=${event.attempt}`]
        .filter(Boolean).join(' ');
      this.writeLine(`[${event.timestamp}] ${event.type}${scope ? ` ${scope}` : ''}${event.message ? ` — ${event.message}` : ''}`);
    }
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* observers must not interrupt orchestration */ }
    }
    if (this.options.logFile) {
      const path = this.options.logFile;
      const line = JSON.stringify(event) + '\n';
      this.pending = this.pending.then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, line, 'utf8');
      }).catch((cause: unknown) => {
        this.failure = cause instanceof Error ? cause : new Error(String(cause));
      });
    }
    return event;
  }

  async flush(): Promise<void> {
    await this.pending;
    if (this.failure) throw this.failure;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
    this.listeners.clear();
  }
}
