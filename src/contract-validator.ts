import Ajv2020Module from "ajv/dist/2020.js";
const Ajv2020 = Ajv2020Module.default;

import type { ErrorObject, ValidateFunction } from "ajv";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type ContractName = "plan" | "implementation" | "review";
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
  implementation: "implementation.schema.json",
  review: "review.schema.json",
};

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
    options: { expectedTaskId?: string; expectedReviewer?: string } = {},
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

type Task = { id: string; dependencies: string[] };
type Decision = { affectedTasks: string[] };
type Plan = { tasks: Task[]; decisions: Decision[] };
type Implementation = { taskId: string; outcome: string; blockers: string[] };
type Review = { taskId: string; reviewer: string; verdict: string; findings: { severity: string }[]; limitations: string[] };

function validateSemantics(
  contract: ContractName,
  value: unknown,
  options: { expectedTaskId?: string; expectedReviewer?: string },
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
  } else if (contract === "implementation") {
    const report = value as Implementation;
    if (report.outcome === "implemented" && report.blockers.length > 0) add("/blockers", "Implemented report cannot contain blockers");
    if (report.outcome === "blocked" && report.blockers.length === 0) add("/blockers", "Blocked report requires at least one blocker");
  } else {
    const report = value as Review;
    const blocking = report.findings.some(f => f.severity === "blocking");
    if (report.verdict === "approved" && blocking) add("/findings", "Approved review cannot contain blocking findings");
    if (report.verdict === "changes_requested" && !blocking) add("/findings", "Changes requested requires a blocking finding");
    if (report.verdict === "blocked" && report.limitations.length === 0) add("/limitations", "Blocked review must explain its limitation");
  }

  if (contract !== "plan") {
    const report = value as Implementation | Review;
    if (options.expectedTaskId && report.taskId !== options.expectedTaskId) add("/taskId", "Report task ID does not match assigned task");
  }
  if (contract === "review" && options.expectedReviewer && (value as Review).reviewer !== options.expectedReviewer) {
    add("/reviewer", "Reviewer ID does not match assigned reviewer");
  }
  return issues;
}
