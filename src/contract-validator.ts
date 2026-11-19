import Ajv2020Module from "ajv/dist/2020.js";
const Ajv2020 = Ajv2020Module.default;

import type { ErrorObject, ValidateFunction } from "ajv";
import { readFile } from "node:fs/promises";
import { posix, resolve, win32 } from "node:path";

export type ContractName = "plan" | "plan-review" | "implementation" | "review" | "ui-evidence" | "impact" | "spec-review";
export type ValidationIssue = {
  stage: "json" | "schema" | "semantic";
  path: string;
  message: string;
};
export type ValidationResult<T = unknown> =
  | { valid: true; value: T; issues: [] }
  | { valid: false; issues: ValidationIssue[] };

const CONTRACTS: Record<ContractName, string> = {
  plan: "plan.schema.json",
  "plan-review": "plan-review.schema.json",
  implementation: "implementation.schema.json",
  review: "review.schema.json",
  "ui-evidence": "ui-evidence.schema.json",
  impact: "impact.schema.json",
  "spec-review": "spec-review.schema.json",
};

/** Task size gate for new and amended plans: one task must fit one implementer session. */
export const MAX_ACCEPTANCE_CRITERIA = 5;
export const MAX_CRITERION_LENGTH = 300;
export interface ValidationOptions {
  expectedTaskId?: string;
  expectedReviewer?: string;
  /** Enforce only when accepting a new or amended plan; persisted plans stay loadable. */
  enforceTaskSize?: boolean;
}

export class ContractValidator {
  private readonly ajv = new Ajv2020({ allErrors: true, strict: true });
  private readonly validators = new Map<ContractName, ValidateFunction>();

    private readonly contractsDirectory: string;

    constructor(contractsDirectory: string) {
        this.contractsDirectory = contractsDirectory;
    }

  async validate<T = unknown>(
    contract: ContractName,
    input: string | unknown,
    options: ValidationOptions = {},
  ): Promise<ValidationResult<T>> {
    let value: unknown = input;
    if (typeof input === "string") {
      try {
        value = JSON.parse(input);
      } catch (error) {
        return {
          valid: false,
          issues: [{ stage: "json", path: "", message: error instanceof Error ? error.message : "Invalid JSON" }],
        };
      }
    }

    const validator = await this.getValidator(contract);
    if (!validator(value)) {
      return {
        valid: false,
        issues: (validator.errors ?? []).map((error: ErrorObject) => ({
          stage: "schema" as const,
          path: error.instancePath || "/",
          message: `${error.message ?? "Schema violation"}${error.params && "additionalProperty" in error.params ? `: ${String(error.params.additionalProperty)}` : ""}`,
        })),
      };
    }

    const issues = validateSemantics(contract, value, options);
    return issues.length > 0 ? { valid: false, issues } : { valid: true, value: value as T, issues: [] };
  }

  private async getValidator(contract: ContractName): Promise<ValidateFunction> {
    const cached = this.validators.get(contract);
    if (cached) return cached;
    const schemaPath = resolve(this.contractsDirectory, CONTRACTS[contract]);
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    const validator = this.ajv.compile(schema);
    this.validators.set(contract, validator);
    return validator;
  }
}

type Task = { id: string; dependencies: string[]; acceptanceCriteria: string[]; criterionChecks?: Array<{ criterion: number; checks: string[] }> }; 
type Decision = { affectedTasks: string[] };
type Plan = { tasks: Task[]; decisions: Decision[] };
type Implementation = { taskId: string; outcome: string; blockers: { kind: string; question?: string; proposedSplit?: string[] }[] };
type Review = { taskId: string; reviewer: string; verdict: string; findings: { severity: string }[]; limitations: string[] };
type Impact = { affectedModules: { path: string; change: string }[]; consequences: string[] };

// Permit an optional final sentence terminator, but not a second sentence or line.
function isSingleSentence(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !/[\r\n\u0085\u2028\u2029]/u.test(text)
    && !/[.!?]+["'”’»\])}]*\s+\S/u.test(trimmed);
}

function validateSemantics(
  contract: ContractName,
  value: unknown,
  options: ValidationOptions,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (path: string, message: string) => issues.push({ stage: "semantic", path, message });

  if (contract === "plan") {
    const plan = value as Plan;
    const ids = new Set<string>();
    for (const [index, task] of plan.tasks.entries()) {
      if (ids.has(task.id)) add(`/tasks/${index}/id`, `Duplicate task ID: ${task.id}`);
      ids.add(task.id);
    }
    for (const [index, task] of plan.tasks.entries()) {
      const mapped = new Set<number>();
      for (const [mappingIndex, mapping] of (task.criterionChecks ?? []).entries()) {
        if (mapping.criterion >= task.acceptanceCriteria.length) add(`/tasks/${index}/criterionChecks/${mappingIndex}/criterion`, 'Criterion index is out of range');
        if (mapped.has(mapping.criterion)) add(`/tasks/${index}/criterionChecks/${mappingIndex}/criterion`, 'Duplicate criterion mapping');
        mapped.add(mapping.criterion);
      }
      for (const dep of task.dependencies) {
        if (!ids.has(dep)) add(`/tasks/${index}/dependencies`, `Unknown dependency: ${dep}`);
        if (dep === task.id) add(`/tasks/${index}/dependencies`, "Task cannot depend on itself");
      }
    }
    for (const [index, decision] of plan.decisions.entries()) {
      for (const taskId of decision.affectedTasks) {
        if (!ids.has(taskId)) add(`/decisions/${index}/affectedTasks`, `Unknown affected task: ${taskId}`);
      }
    }
    const tasks = new Map(plan.tasks.map(t => [t.id, t]));
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) { add("/tasks", `Dependency cycle involving ${id}`); return; }
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dep of tasks.get(id)?.dependencies ?? []) if (tasks.has(dep)) visit(dep);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of ids) visit(id);
    if (options.enforceTaskSize) {
      for (const [index, task] of plan.tasks.entries()) {
        const path = `/tasks/${index}/acceptanceCriteria`;
        if (task.acceptanceCriteria.length > MAX_ACCEPTANCE_CRITERIA) add(path, `${task.id} has ${task.acceptanceCriteria.length} acceptance criteria; the limit is ${MAX_ACCEPTANCE_CRITERIA}. Split the task`);
        for (const [criterion, text] of task.acceptanceCriteria.entries()) {
          if (text.length > MAX_CRITERION_LENGTH) add(`${path}/${criterion}`, `Criterion has ${text.length} characters; the limit is ${MAX_CRITERION_LENGTH}. State one checkable behavior per criterion`);
        }
      }
    }
  } else if (contract === "impact") {
    const impact = value as Impact;
    for (const [index, module] of impact.affectedModules.entries()) {
      const path = module.path;
      if (!path.trim() || posix.isAbsolute(path) || win32.isAbsolute(path) || /^[a-z]:/i.test(path) || path.split(/[\\/]/).includes("..")) {
        add(`/affectedModules/${index}/path`, "Path must be repository-relative and must not contain a .. segment");
      }
      if (!isSingleSentence(module.change)) add(`/affectedModules/${index}/change`, "Change must be single-line, one-sentence text");
    }
    for (const [index, consequence] of impact.consequences.entries()) {
      if (!isSingleSentence(consequence)) add(`/consequences/${index}`, "Consequence must be single-line, one-sentence text");
    }
  } else if (contract === "implementation") {
    const report = value as Implementation;
    for (const [index, blocker] of report.blockers.entries()) {
      if (blocker.kind === "decision_needed" && !blocker.question) add(`/blockers/${index}`, "A decision_needed blocker requires a question");
      if (blocker.kind === "task_too_large" && (blocker.proposedSplit?.length ?? 0) < 2) add(`/blockers/${index}`, "A task_too_large blocker requires a proposedSplit of at least two parts");
    }
    if (report.outcome === "implemented" && report.blockers.length > 0) add("/blockers", "Implemented report cannot contain blockers");
    if (report.outcome === "blocked" && report.blockers.length === 0) add("/blockers", "Blocked report requires at least one blocker");
  } else if (contract === "review") {
    const report = value as Review;
    const blocking = report.findings.some(f => f.severity === "blocking");
    if (report.verdict === "approved" && blocking) add("/findings", "Approved review cannot contain blocking findings");
    if (report.verdict === "changes_requested" && !blocking) add("/findings", "Changes requested requires a blocking finding");
    if (report.verdict === "blocked" && report.limitations.length === 0) add("/limitations", "Blocked review must explain its limitation");
  }

  if (contract === "implementation" || contract === "review" || contract === "ui-evidence") {
    const report = value as Implementation | Review;
    if (options.expectedTaskId && report.taskId !== options.expectedTaskId) add("/taskId", "Report task ID does not match assigned task");
  }
  if (contract === "review" && options.expectedReviewer && (value as Review).reviewer !== options.expectedReviewer) {
    add("/reviewer", "Reviewer ID does not match assigned reviewer");
  }
  return issues;
}
