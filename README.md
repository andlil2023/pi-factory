# PI Factory — Event Bus integration

Copy `src/orchestrator.ts`, `src/factory-cli.ts`, and `tests/orchestrator-events.test.ts` into your existing PI Factory repository. The previously installed `src/event-bus.ts` is required but unchanged.

Run:

```powershell
npm run check
npm test
```

The CLI now creates `.factory/runs/<run-id>.events.jsonl` in the target repository and prints events while executing. The orchestrator emits lifecycle events for task execution, agent calls, verification, review, repairs, checkpoints, and final verification. This patch does not stream individual PI tokens or tool calls.

The event log is observational, not a source of truth for task status. The existing state store remains authoritative.

## Read-only dashboard

Start the dashboard separately from the factory (Node with `--experimental-strip-types` support is required):

```sh
node --experimental-strip-types src/dashboard-server.ts PATH_TO_TARGET_REPOSITORY [PORT]
```

The repository argument is required; the optional port defaults to 3000 and must be 1–65535. Open `http://127.0.0.1:3000/` (substitute the chosen port). The page refreshes persisted state every five seconds and offers a manual refresh. Running means the **last persisted state**, not proof that a process is still alive. Lifecycle events are observational snapshots and never change status. Missing, invalid, partial, or oversized state is shown as unavailable.

Runs show a descriptive label and intended work from the saved objective, and current task cards show saved task titles; full IDs remain visible. Missing descriptions fall back to IDs, including for superseded tasks. The dashboard projection newly exposes only bounded display metadata: a label (up to 100 characters), objective summary (2,000), and current task titles (200), with an ellipsis when truncated. It does not expose the raw plan or unrelated plan fields.

To view fixture runs without starting agents, create a temporary target directory with `.factory/runs/demo.json` containing the following minimal state, then start the dashboard pointing at that directory:

```json
{"version":1,"runId":"demo","repository":"fixture","createdAt":"2025-01-01T00:00:00Z","updatedAt":"2025-01-01T00:00:00Z","status":"running","plan":{},"tasks":{}}
```

Optionally add `.factory/runs/demo.events.jsonl`, one JSON object per line, for example `{"runId":"demo","timestamp":"2025-01-01T00:00:00Z","type":"RUN_STARTED"}`. No configuration, agent, or factory execution is needed.

**Threat model:** this is a read-only local viewer for a trusted operator on the same machine, not an authentication boundary or multi-user service. It binds only to IPv4 loopback, rejects unexpected Host and cross-origin Origin headers, uses a restrictive CSP, and does not expose control endpoints or CORS access. Projected run data can still contain sensitive text; any local user or process able to connect can read it. Do not expose the port through a proxy or use it to protect data from hostile local processes. Run-file text is untrusted and displayed as text; raw prompts, command output, configuration and UI evidence are excluded by the projection.

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

**Retry budget.** `execution.maxAttempts` counts attempts whose work was rejected by verification or review, or reported `failed`. Blocked reports, interruptions, and agent or infrastructure errors (recorded as outcome `error`) do not count. Separately, `execution.maxInfraRetries` defaults to 1 automatic retry per task for PI timeouts, nonzero exits, empty or invalid event output, and prompt-send failures. This separate budget is persisted and survives resume, including operator retries; existing runs without a pinned value use zero. Other errors and exhausted infrastructure retries stop the run and require an approved resume.

**Task size gate.** `plan`, `run`, `replan`, and `amend` reject a task with more than 5 acceptance criteria or a criterion longer than 300 characters. Plans of existing runs stay loadable.

**Objectives.** State a threat model and non-goals in the objective (see `examples/objective.md`). The planner must not assume an adversary that the objective does not name, and reviewers may block only on stated requirements or concrete defects.

## Worktree setup

A fresh run or integration worktree contains only tracked files: no `node_modules` or other ignored build inputs. Configure trusted `setup` commands to prepare it. They run once after each run worktree and each integration worktree is created, before any agent or verification:

```json
"setup": [
  { "executable": "cmd", "args": ["/c", "npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], "timeoutMs": 600000 }
]
```

On Linux and macOS use `"executable": "npm"` with the same arguments after `/c`. Commands run without a shell, so `npm` on Windows needs `cmd /c`. A failed setup stops `run` before any run state exists and blocks an integration attempt. Setup output must be Git-ignored; a setup that dirties tracked files is rejected by the existing clean-worktree checks. `setup` is part of the configuration fingerprint, so it cannot be added to an existing run. `resume` does not rerun setup.

## Opt-in task verification selection

By default, every task attempt runs the full configured `verification` array. To opt in, add `verificationSelection` to the operator-owned configuration used to start the run. [This example fragment](examples/verification-selection.example.json) shows the format; merge its top-level fields into a complete configuration, adapting the commands, paths and declarations to your repository. The example assumes hypothetical scripts and is not a safe configuration for this or any other repository without an independent audit.

Each rule maps a repository-relative file or directory path to **zero-based indexes** in the trusted `verification` array. Paths match themselves and descendants by whole path segment, not glob patterns. Rules must be nonempty and non-overlapping; paths cannot be absolute, contain `.` or `..` segments, backslashes or glob characters. Command indexes must be valid and unique within a rule, and configured verification commands must not be duplicates. When several changed paths match, the factory runs the union of their mapped commands in configured order. Agents and task descriptions cannot supply or change these commands. Commands execute directly without a shell; use an appropriate executable for your platform.

**Operator responsibility:** list every repository-relative file or directory that can affect verification in `dependencyPaths` (for example test and build scripts, shared test helpers, package and lock files, tool configuration including legacy configurations, and verification entrypoint directories). Set `dependenciesComprehensive` to `true` only after confirming the list is complete. Also ensure each mapping includes *every* check affected by any change under that path, including cross-component effects. The factory cannot infer either property from arbitrary commands. A syntactically valid but incomplete declaration or unsafe mapping can skip needed task checks; keep full verification if unsure. Changes to commands or declarations change the execution fingerprint, so resume and integration require the original configuration.

Selection falls back to all configured commands if selection is absent, the comprehensive declaration is missing or false, a declared dependency changes (even if mapped), or any changed path is unmapped. It also falls back for empty, unavailable, inconsistent or otherwise unsuitable Git evidence, unsupported changes such as deletions, renames or submodule changes, and selection errors. Invalid configuration is normally rejected before execution. Git evidence covers committed, staged, unstaged and untracked changes against the accepted-task baseline; repairs recalculate against that same baseline, including retained earlier edits. Ignored files and external inputs are not a substitute for declared dependencies: selection cannot establish that commands or mappings are semantically complete.

A failed executed check fails the attempt; review and checkpoint gates still apply after successful verification. **Final verification, integration preparation, and publication verification always run the full configured command list**, regardless of task selection. In the target repository, inspect `.factory/runs/<run-id>.json` at `tasks.<task-id>.attempts[].verification`: its `details` records selection `mode`, `reasons`, Git `evidence` (paths, statuses and sources), selected `commands`, and individual `checks` with outcomes and bounded output. Evidence may contain sensitive output; protect the state file. The dashboard exposes only the pass/fail projection, and the event log is not the authoritative attempt record.

## Approval-gated integration

Integration has two separately approved stages, using the same configuration as the completed run:

```powershell
# Prepare a merge candidate; does NOT update the target branch
npm run factory -- integrate --repo PATH --run RUN_ID --config CONFIG_FILE --approve

# Inspect the candidate SHA, reports, and worktree, then explicitly publish it
# With a GitHub upstream this opens a PR; without any remote it updates the local target
npm run factory -- integrate --repo PATH --run RUN_ID --config CONFIG_FILE --publish --candidate EXACT_SHA --approve
```

Only completed runs with passing final verification are eligible. Preparation creates `factory-integration/<run-id>-<attempt>` in a separate sibling `.factory-integrations/` directory, merging the pinned run tip into the **current** recorded target tip. It runs trusted verification and fresh independent review against the cumulative target-to-candidate diff and all original acceptance criteria. Configured rendered UI evidence is collected when UI review is selected. Specialist requirements and findings survive new integration attempts. Each validated reviewer report is persisted before the next reviewer starts, so a later timeout/invalid response cannot erase earlier findings. Fresh reviewers receive prior findings as explicitly untrusted evidence to reassess against the current candidate. A complete exact-set unanimous result is still required for acceptance. The source run branch and target worktree are not changed by preparation.

A conflict, failed check, missing/blocked review, dirty candidate, or changed source/target prevents a ready result. Conflicting files, merge state, branch, and worktree are preserved for inspection; no abort/reset/force operation occurs. Inspect state with `factory status`. To prepare a fresh candidate after resolving the underlying issue through a separately authorized workflow, explicitly add `--new-attempt --approve`. Prior attempts and their findings remain stored. Integration creation has its own bounded attempt count, capped by the original `execution.maxAttempts`; it does not consume/reset task attempts. Only the latest ready candidate can be published.

Publication requires the exact reviewed SHA, unchanged source/target tips, unchanged execution configuration, an intact clean candidate, and the original target repository checked out on the recorded target branch with a clean working tree and no unfinished Git operations. An optional `--target NAME` must equal the run's recorded target; it cannot retarget a run. Trusted checks run again before publishing. Rendered-evidence integrity is rechecked when required. With no configured remote, publication fast-forwards the local target to the exact reviewed merge commit. With any remote configured, local publication is disabled: the target must track a same-named branch on GitHub, and publication pushes the reviewed candidate to a new remote branch and opens a PR using the authenticated GitHub CLI (`gh`). Fetch and push URLs must identify the same github.com repository, and its base must equal the reviewed target. Existing remote candidate branches are never overwritten; a create-only Git lease guards against races. GitHub credentials must be configured outside factory state. Git URL rewrite rules (`insteadOf` or `pushInsteadOf`) are rejected for publication to avoid redirecting the push; do not change Git configuration concurrently with factory operations. Reviews are not rerun when the exact reviewed candidate is unchanged.

An opened PR is recorded as `pr-opened`, not as a completed merge. **The factory does not merge PRs or enable GitHub auto-merge.** Branch protection and human review still apply. If the base or PR head advances after publication, the PR no longer necessarily represents the reviewed candidate; review it again before merging. Automatic merging requires a future server-side merge-queue gate verifying the reviewed tree. Push/PR creation failures after publication starts leave `pr-publishing` for manual reconciliation; inspect the remote branch and PRs before taking further action. A PR may already have been created even if post-creation checks fail, and the factory does not close it. No automatic retry, deletion, or rollback is performed.

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
