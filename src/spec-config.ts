import { posix, win32 } from 'node:path';
import type { AgentModel } from './agent-adapters.ts';

export interface GitHubProjectConfig { owner: string; number: number; iterationField?: string }
export interface SpecificationsConfig {
  store?: 'local' | 'github';
  local?: { directory?: string };
  github?: { label?: string; repository?: string; project?: GitHubProjectConfig };
}

/** Defaults are applied by consumers, leaving the loaded configuration unchanged for run recovery. */
export const defaultSpecificationStore = 'local';
export const defaultSpecificationDirectory = '.factory/specs';
export const defaultSpecificationLabel = 'factory-spec';
export const defaultIterationField = 'Iteration';

export function specificationAgents(agents: {
  planner: AgentModel; reviewer: AgentModel; planReviewer?: AgentModel;
  impactAnalyst?: AgentModel; specReviewer?: AgentModel;
}): { impactAnalyst: AgentModel; specReviewer: AgentModel } {
  return { impactAnalyst: agents.impactAnalyst ?? agents.planner, specReviewer: agents.specReviewer ?? agents.planReviewer ?? agents.reviewer };
}

function object(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${key}; expected an object`);
  return value as Record<string, unknown>;
}
function nonempty(value: unknown, key: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${key}; expected a non-empty string`);
}

export function validateSpecificationsConfig(value: unknown): void {
  if (value === undefined) return;
  const config = object(value, 'specifications');
  if (config.store !== undefined && config.store !== 'local' && config.store !== 'github') throw new Error('Invalid specifications.store');
  if (config.local !== undefined) {
    const local = object(config.local, 'specifications.local');
    if (local.directory !== undefined) {
      const key = 'specifications.local.directory';
      nonempty(local.directory, key);
      const directory = local.directory as string;
      if (directory.includes('\0') || posix.isAbsolute(directory) || win32.isAbsolute(directory) || /^[A-Za-z]:/.test(directory) || directory.split(/[\\/]/).includes('..')) throw new Error(`Invalid ${key}; expected a repository-relative directory without .. segments`);
    }
  }
  let project: unknown;
  if (config.github !== undefined) {
    const github = object(config.github, 'specifications.github');
    if (github.label !== undefined) nonempty(github.label, 'specifications.github.label');
    if (github.repository !== undefined && (typeof github.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(github.repository))) throw new Error('Invalid specifications.github.repository');
    project = github.project;
  }
  if (project === undefined && config.store === 'github') throw new Error('Invalid specifications.github.project; required for github store');
  if (project !== undefined) {
    const p = object(project, 'specifications.github.project');
    nonempty(p.owner, 'specifications.github.project.owner');
    if (!Number.isSafeInteger(p.number) || (p.number as number) <= 0) throw new Error('Invalid specifications.github.project.number');
    if (p.iterationField !== undefined) nonempty(p.iterationField, 'specifications.github.project.iterationField');
  }
}
