import { isDeepStrictEqual } from 'node:util';
import type { PlannedTask } from './orchestrator.ts';
import type { FactoryRunState, TaskState } from './state-store.ts';

export interface AmendmentResult { superseded: string[]; added: string[] }

/**
 * Replace the plan of a stopped run with an operator-approved revision.
 * Accepted work is immutable and attempt history is never discarded: a task with
 * attempts is either kept unchanged or superseded by tasks with new IDs.
 * The caller validates the plan contract and holds the run lock. Throws before mutating.
 */
export function amendRunPlan(state: FactoryRunState, plan: { tasks: PlannedTask[] }, now: string = new Date().toISOString()): AmendmentResult {
  if (state.status === 'completed') throw new Error('Run is already completed; its plan cannot be amended');
  const current = Object.values(state.tasks);
  if (state.status === 'running' || current.some(task => task.status === 'running' || task.status === 'needs_review')) throw new Error('Run has active work; recover it before amending the plan');
  const previous = new Map(((state.plan as { tasks?: PlannedTask[] } | null)?.tasks ?? []).map(task => [task.id, task]));
  if (isDeepStrictEqual(plan, state.plan)) throw new Error('Amended plan does not change the current plan');
  const next = new Map(plan.tasks.map(task => [task.id, task]));
  const retired = new Set((state.supersededTasks ?? []).map(entry => entry.task.id));
  const superseded: TaskState[] = [];
  for (const task of current) {
    const definition = next.get(task.id);
    const unchanged = definition !== undefined && isDeepStrictEqual(definition, previous.get(task.id));
    if (task.status === 'completed') {
      if (!unchanged) throw new Error(`Completed task ${task.id} must remain in the plan unchanged`);
    } else if (task.attempts.length) {
      if (definition && !unchanged) throw new Error(`${task.id} has attempt history; keep it unchanged or replace it with tasks that use new IDs`);
      if (!definition) superseded.push(task);
    }
  }
  const added = plan.tasks.filter(task => !state.tasks[task.id]).map(task => task.id);
  for (const id of added) if (retired.has(id)) throw new Error(`${id} was superseded earlier; use a new task ID`);

  state.planRevisions = [...(state.planRevisions ?? []), { replacedAt: now, plan: state.plan }];
  state.supersededTasks = [...(state.supersededTasks ?? []), ...superseded.map(task => ({ supersededAt: now, task }))];
  state.plan = structuredClone(plan);
  state.tasks = Object.fromEntries(plan.tasks.map((task): [string, TaskState] => [task.id, state.tasks[task.id] ?? { id: task.id, status: 'pending', attempts: [] }]));
  state.status = 'paused';
  return { superseded: superseded.map(task => task.id), added };
}
