# PI Factory — Agent Instructions

## Purpose
Build a project-independent, resumable AI development factory using PI and GPT models.

## Boundaries
- The deterministic orchestrator controls state, retry budgets, approvals, and completion.
- PI runs fresh Planner, Implementer, and Reviewer sessions.
- Agent prompts and JSON contracts are separate from orchestration code.
- Factory instructions never override the target repository's own rules.

## Engineering
- Prefer small, explicit TypeScript modules and strict types.
- Keep PI-specific integration behind `src/pi-runner.ts`.
- Make only task-scoped changes; no speculative abstractions.
- Persist progress outside agent conversations.
- Validate outputs; never trust agent claims as verification evidence.
- Use independent tests and review before accepting work.
- Never bypass failing tests or blocking findings.

## Autonomous execution
- A rejected task may be repaired in a fresh session with its original acceptance criteria and findings.
- Retry only within configured budgets; preserve attempt history.
- The orchestrator may replace a too-large or budget-exhausted task with a reviewed plan revision, within the configured replan budget; it saves leftover edits as a patch before resetting its own run worktree.
- Stop for unresolved architectural, security, or product decisions.
- Never merge, deploy, or run destructive commands without authorization.
- Never leak secrets into prompts or logs.
