# PI Factory — Event Bus integration

Copy `src/orchestrator.ts`, `src/factory-cli.ts`, and `tests/orchestrator-events.test.ts` into your existing PI Factory repository. The previously installed `src/event-bus.ts` is required but unchanged.

Run:

```powershell
npm run check
npm test
```

The CLI now creates `.factory/runs/<run-id>.events.jsonl` in the target repository and prints events while executing. The orchestrator emits lifecycle events for task execution, agent calls, verification, review, repairs, checkpoints, and final verification. This patch does not stream individual PI tokens or tool calls.

The event log is observational, not a source of truth for task status. The existing state store remains authoritative.

## Persisted Git state and resume

Each new run records its worktree, run branch, target branch (the original repository's named branch at startup), base commit, and latest accepted checkpoint. It also pins the execution configuration fingerprint and retry budget. Tasks still execute sequentially in one worktree per run. **Completion does not merge the run branch into the target.**

Use the original configuration when resuming:

```powershell
npm run factory -- status --repo PATH --run RUN_ID
npm run factory -- resume --repo PATH --run RUN_ID --config CONFIG_FILE --approve
```

If a task failed or was interrupted, inspect its worktree and findings first, resolve any decisions outside the factory, then explicitly authorize a fresh repair session:

```powershell
npm run factory -- resume --repo PATH --run RUN_ID --config CONFIG_FILE --retry-task T002 --approve
```

Failed edits are preserved; no reset, checkout, automatic merge, or cleanup is performed. Completed tasks are not replayed. Attempt history, specialist requirements, and the original retry budget survive resume; exhausted budgets cannot be reset or increased. Verification and required review run again for repaired work. Failed final verification can be retried with a clean worktree after all tasks completed; code changes need separately authorized work rather than reopening completed tasks.

The command rejects wrong/missing/unregistered worktrees, unexpected branches or HEADs, inconsistent checkpoint history, unfinished Git operations, unresolved conflicts, changed execution configuration, and dirty work not associated with an explicitly approved task retry. A target branch may advance normally while the run remains isolated; integration verification is still required later. Rewritten/deleted target history requires operator inspection.

Run execution and resume use a local PID-based lock. A live owner is never displaced. After a crash, confirm the old factory **and any surviving child agents/test processes have stopped**, inspect the worktree, and add `--recover-lock` to explicitly reclaim a dead owner's lock. The lock is local-machine coordination, not distributed locking or process sandboxing. Malformed locks, uncertain process liveness, or orphaned recovery locks stop for manual inspection.

Keep `.factory/` ignored in the target repository; it stores state, locks, events, and potentially sensitive evidence. Resume appends to the existing event log and records approval in state. Old runs without Git/execution metadata cannot be resumed automatically. A crash between creating a Git checkpoint and saving state intentionally causes a HEAD mismatch: preserve the work and reconcile manually; the factory never assumes an unrecorded commit was accepted. Existing runs must not be concurrently manipulated outside the factory.

## Blocked tasks: answer, split, or fix

An implementer may stop a task only with a typed blocker. Free-text blockers and "work remains" are rejected by `contracts/implementation.schema.json`. `status` prints the next step for each blocked task.

| Blocker | Meaning | Operator action |
| --- | --- | --- |
| `decision_needed` | A specific question the plan does not answer | Answer it in a file, then `resume --retry-task T002 --guidance FILE --approve` |
| `environment_missing` | A tool, platform, or credential is unavailable | Provide it, then `resume --retry-task T002 --approve` |
| `task_too_large` | The task does not fit one session; includes a proposed split | Replan and amend, see below |

Guidance is stored in run state with the approval and sent to the implementer and reviewers of that task as an authoritative answer. **Do not put secrets in a guidance file.**

To split or revise a task without losing accepted work:

```powershell
# Read-only: the planner proposes a complete revised plan
npm run factory -- replan --repo PATH --run RUN_ID --config CONFIG_FILE --output revised-plan.json [--guidance FILE]
# Review revised-plan.json, then apply it and continue
npm run factory -- amend --repo PATH --run RUN_ID --plan revised-plan.json --approve
npm run factory -- resume --repo PATH --run RUN_ID --config CONFIG_FILE --approve
```

`amend` accepts a hand-edited plan too. Completed tasks must stay unchanged. A task with attempts is either kept unchanged or removed and replaced by tasks with new IDs; its attempt history moves to `supersededTasks` and the old plan to `planRevisions`. The factory never cleans the worktree: if the superseded task left edits, inspect and remove them yourself before `resume`.

**Retry budget.** `execution.maxAttempts` counts attempts whose work was rejected by verification or review, or reported `failed`. Blocked reports, interruptions, and agent or infrastructure errors (recorded as outcome `error`) do not count: each of them already stops the run and needs an approved resume.

**Task size gate.** `plan`, `run`, `replan`, and `amend` reject a task with more than 5 acceptance criteria or a criterion longer than 300 characters. Plans of existing runs stay loadable.

**Objectives.** State a threat model and non-goals in the objective (see `examples/objective.md`). The planner must not assume an adversary that the objective does not name, and reviewers may block only on stated requirements or concrete defects.

## Approval-gated integration

Integration has two separately approved stages, using the same configuration as the completed run:

```powershell
# Prepare a merge candidate; does NOT update the target branch
npm run factory -- integrate --repo PATH --run RUN_ID --config CONFIG_FILE --approve

# Inspect the candidate SHA, reports, and worktree, then explicitly publish it
npm run factory -- integrate --repo PATH --run RUN_ID --config CONFIG_FILE --publish --candidate EXACT_SHA --approve
```

Only completed runs with passing final verification are eligible. Preparation creates `factory-integration/<run-id>-<attempt>` in a separate sibling `.factory-integrations/` directory, merging the pinned run tip into the **current** recorded target tip. It runs trusted verification and fresh independent review against the cumulative target-to-candidate diff and all original acceptance criteria. Configured rendered UI evidence is collected when UI review is selected. Specialist requirements and findings survive new integration attempts. Each validated reviewer report is persisted before the next reviewer starts, so a later timeout/invalid response cannot erase earlier findings. Fresh reviewers receive prior findings as explicitly untrusted evidence to reassess against the current candidate. A complete exact-set unanimous result is still required for acceptance. The source run branch and target worktree are not changed by preparation.

A conflict, failed check, missing/blocked review, dirty candidate, or changed source/target prevents a ready result. Conflicting files, merge state, branch, and worktree are preserved for inspection; no abort/reset/force operation occurs. Inspect state with `factory status`. To prepare a fresh candidate after resolving the underlying issue through a separately authorized workflow, explicitly add `--new-attempt --approve`. Prior attempts and their findings remain stored. Integration creation has its own bounded attempt count, capped by the original `execution.maxAttempts`; it does not consume/reset task attempts. Only the latest ready candidate can be published.

Publication requires the exact reviewed SHA, unchanged source/target tips, unchanged execution configuration, an intact clean candidate, and the original target repository checked out on the recorded target branch with a clean working tree and no unfinished Git operations. An optional `--target NAME` must equal the run's recorded target; it cannot retarget a run. Trusted checks run again before publishing. Rendered-evidence integrity is rechecked when required. Publication fast-forwards the target to the exact reviewed merge commit—never rebasing or force-updating history. Reviews are not rerun when the exact reviewed candidate is unchanged. There is no remote push or deployment.

Preparation/publication use both the run lock and a repository-wide integration lock. These coordinate this factory locally; **do not concurrently check out branches or change refs/worktrees using other tools**. The factory checks before/after Git operations, but its PID locks do not lock out external Git clients. A crash after publication starts leaves `publishing` state and requires manual reconciliation; it will not blindly retry or roll back a possibly updated target. Failed pre-publication checks never intentionally update the target.

**Not implemented:** automatic conflict resolution, adoption of manually resolved/amended candidates, remote push, automatic worktree cleanup, or adding tasks to a completed run. Conflicted candidates are preserved diagnostic workspaces in this version, not resumable implementation tasks. Publication refuses them; use a separately authorized resolution workflow and a fresh candidate (within budget), or perform manual integration outside the factory.

## Specialist reviewers

`factory.config.json` now enables Security and UI/accessibility review alongside the mandatory code review. Each reviewer runs in a fresh PI process with its own instructions, model, read-only tool selection, and validated report. These tool selections are not an OS security sandbox.

Configure specialist models independently using the optional top-level `reviewers` object:

```json
{
  "reviewRouting": "task-specific",
  "reviewers": {
    "security": { "provider": "openai", "model": "YOUR_PI_MODEL_ID", "timeoutMs": 300000 },
    "ui": { "provider": "openai", "model": "YOUR_PI_MODEL_ID", "timeoutMs": 300000 }
  }
}
```

`agents.reviewer` remains the code review model. Omit a specialist entry to disable it; omit `reviewers` for the previous code-only behavior. Unknown specialist IDs and invalid specialist model settings are rejected before execution. See `factory.config.example.json` for a full configuration.

`reviewRouting` supports `"all"` (the default for existing configurations) or `"task-specific"` (enabled in the supplied configurations). In all mode, every enabled reviewer is required for every task. In task-specific mode, trusted deterministic rules select reviewers after verification using Git-observed changes against the task baseline, including untracked files, deletions, and both sides of renames:

- **Code:** always required.
- **Security:** auth, permissions, secrets, API, backend, data, and schema paths; also executable source, configuration, and unknown artifacts, including frontend source.
- **UI/accessibility:** frontend/component/view paths, frontend extensions, WPF `.xaml`, and styles.
- **Uncertainty:** ambiguous paths or no changed files require all enabled reviewers. Ordinary `.md`, `.txt`, and `.rst` documentation needs code only unless paths or task text indicate specialist scope.
- Task descriptions, acceptance criteria, and verification text may **add** specialists, never waive path-based requirements. Routing is heuristic and intentionally conservative, not proof that a change has no security or UI impact.

Removing a specialist from `reviewers` disables that specialist for new work; routing only selects enabled specialists. Required IDs, changed paths, and routing reasons are persisted on the task and each reviewed attempt **before** reviewer invocation. Repairs and reloaded runs retain previous requirements and may add reviewers, but cannot drop them; disabling a previously required reviewer blocks acceptance. Report IDs must match the exact selected set.

All selected reviewers must approve; actionable blocking findings trigger bounded repair attempts, and blocked or invalid reports prevent acceptance. Review reports and feedback use the existing persisted attempt history.

UI review supports desktop and web applications; browser evidence is not required for WPF. Specialists add model calls and latency; review currently runs sequentially.

## Rendered UI evidence (including WPF)

The optional `uiEvidence.command` runs a trusted, repository-specific collector when UI review is selected. Configure a test harness that builds the actual application, runs interactions/accessibility checks, and writes `manifest.json` plus artifacts to `FACTORY_UI_EVIDENCE_DIRECTORY`. Plain `dotnet test` does **not** produce this manifest unless your test harness implements the contract.

```json
{
  "uiEvidence": {
    "command": {
      "executable": "dotnet",
      "args": ["test", "tests/MyApp.UiTests/MyApp.UiTests.csproj", "--configuration", "Release"],
      "timeoutMs": 300000
    }
  }
}
```

The factory creates a fresh artifact directory outside the target worktree, validates the manifest, checks source freshness and artifact hashes, persists the record, and passes absolute artifact paths to the UI reviewer. Failed collection, failed checks, missing evidence, or stale source blocks acceptance; these failures currently stop for inspection rather than triggering automatic repair. Interaction and accessibility checks plus a screenshot and accessibility tree are required whenever this collector is enabled and UI review is selected. The reviewer must actually inspect rendered evidence and assess acceptance-criteria coverage; collection success alone is not approval.

Without `uiEvidence`, existing source-only review behavior is unchanged: the reviewer must disclose missing evidence and block when acceptance criteria require rendered/interactive verification. A vision-capable UI model is needed for screenshot inspection. No collector is enabled by default because the factory has no target WPF app or GUI test harness.

See [WPF UI evidence integration](examples/wpf-ui-evidence.md) and `contracts/ui-evidence.schema.json` for the collector contract and FlaUI guidance.
