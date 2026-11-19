# PI Factory

PI Factory orchestrates planning, implementation, verification and independent review in isolated run worktrees, with explicit operator approval gates. The persisted state store is authoritative; lifecycle event logs are observational and do not stream individual Pi tokens or tool calls.

Start with the [Windows installed-tool quick-start](docs/operator-quick-start.md) for prerequisites, tag installation, configuration, planning, approval, execution, optional skills and upgrades. The CLI works without skills; Pi remains the factory's separate agent runtime.

## Read-only dashboard

The dashboard shows automatic plan revisions and highlights attempts that passed verification only on a rerun.

Start the installed dashboard separately from execution (Node 24.12.0 or newer is required):

```powershell
pi-factory dashboard --repo PATH_TO_TARGET_REPOSITORY --port 3000
```

The repository argument is required; the optional port defaults to 3000 and must be 1–65535. Open `http://127.0.0.1:3000/` (substitute the chosen port). The page refreshes persisted state every five seconds and offers a manual refresh. Running means the **last persisted state**, not proof that a process is still alive. Lifecycle events are observational snapshots and never change status. Missing, invalid, partial, or oversized state is shown as unavailable.

Runs show a descriptive label and intended work from the saved objective, and current task cards show saved task titles; full IDs remain visible. Missing descriptions fall back to IDs, including for superseded tasks. The dashboard projection newly exposes only bounded display metadata: a label (up to 100 characters), objective summary (2,000), and current task titles (200), with an ellipsis when truncated. It does not expose the raw plan or unrelated plan fields.

Task acceptance is not target integration: accepted tasks are labeled **Accepted on run branch**. A verified run shows **awaiting integration**, a locally published candidate shows **Integrated into target**, and an opened PR shows **awaiting merge**. Integration cards show persisted worktree/merge/setup/verification/review/publication phases, pending reviewers, and verification command counts. Task attempts and final verification also show command counts and whether the full or selected suite runs. Updates appear on the existing five-second refresh; a long-running command advances its counter when it exits (not on individual test cases). Raw commands and output remain excluded.

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
pi-factory status --repo PATH --run RUN_ID
pi-factory resume --repo PATH --run RUN_ID --config CONFIG_FILE --approve
```

If a task failed or was interrupted, inspect its worktree and findings first, resolve any decisions outside the factory, then explicitly authorize a fresh repair session:

```powershell
pi-factory resume --repo PATH --run RUN_ID --config CONFIG_FILE --retry-task T002 --approve
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
| `task_too_large` | The task does not fit one session; includes a proposed split | None while the automatic replan budget lasts; otherwise replan and amend, see below |

Guidance is stored in run state with the approval and sent to the implementer and reviewers of that task as an authoritative answer. **Do not put secrets in a guidance file.**

To split or revise a task without losing accepted work:

```powershell
# Read-only: the planner proposes a complete revised plan
pi-factory replan --repo PATH --run RUN_ID --config CONFIG_FILE --output revised-plan.json
# Optionally add --guidance FILE. Review revised-plan.json, then apply it and continue
pi-factory amend --repo PATH --run RUN_ID --plan revised-plan.json --approve
pi-factory resume --repo PATH --run RUN_ID --config CONFIG_FILE --approve
```

`amend` accepts a hand-edited plan too. Completed tasks must stay unchanged. A task with attempts is either kept unchanged or removed and replaced by tasks with new IDs; its attempt history moves to `supersededTasks` and the old plan to `planRevisions`. A manual `amend` never cleans the worktree: if the superseded task left edits, inspect and remove them yourself before `resume`.

### Automatic replanning

`run` and `resume` do the replan, amend and resume steps themselves for two causes, up to `execution.maxAutoReplans` times per run (default 2; `0` restores the manual flow above):

- the implementer reported `task_too_large`, or
- the task used its whole repair budget (`execution.maxAttempts`) and was still rejected.

The planner receives the structured failure record of the stopped task. Because no operator reads the revision before it runs, an independent plan review is mandatory here even when `planning.maxReviewRounds` is `0`, and the factory enforces deterministic limits on top of the `amend` rules: the objective is unchanged, only the stopped task is replaced, at least one task with a new ID is added, no other task is removed or changed except for its dependencies, and every acceptance criterion of the stopped task appears verbatim in a replacement task. A revision that breaks a limit is saved for inspection and not applied. Each automatic revision is recorded in `autoReplans` in run state, as a `PLAN_REVISED` event, and as `.factory/runs/RUN_ID/auto-replan/plan-N-TIMESTAMP.json` with its review report.

The factory stops for you, exactly as before, when the blocker is `decision_needed` or `environment_missing`, when a reviewer returned `blocked`, after an interruption or agent error, when the revised plan contains a blocking decision, when the plan reviewer does not approve the revision, when the revision breaks one of the limits above, or when the replan budget is spent. Integration and publication still need `--approve`.

**Worktree reset.** Replacement tasks must start from the last accepted checkpoint. The factory first saves the uncommitted edits of the superseded task, tracked and untracked, as a binary-safe patch `.factory/runs/RUN_ID/auto-replan/leftover-N-TASK-TIMESTAMP.patch`, then saves the amended run state with the patch path, and only then runs `git reset --hard` and `git clean -fd` in the run worktree. If the process dies between saving state and the reset, `resume` refuses the dirty worktree and asks you to inspect it; the patch already exists. This happens only in the factory-owned run worktree on its `factory/RUN_ID` branch at the recorded checkpoint, never in your repository checkout; ignored files such as installed dependencies are kept. Restore the edits with `git apply` if you need them. Set `execution.maxAutoReplans` to `0` if you do not want the factory to reset its worktree.

**Retry budget.** `execution.maxAttempts` counts attempts whose work was rejected by verification or review, or reported `failed`. Blocked reports, interruptions, and agent or infrastructure errors (recorded as outcome `error`) do not count. Separately, `execution.maxInfraRetries` defaults to 1 automatic retry per task for PI timeouts, nonzero exits, empty or invalid event output, and prompt-send failures. This separate budget is persisted and survives resume, including operator retries; existing runs without a pinned value use zero. Other errors and exhausted infrastructure retries stop the run and require an approved resume.

**Verification reruns.** A trusted verification command that fails is run again, up to `execution.verificationReruns` times (default 1, `0` disables, maximum 3). If the unchanged source then passes, the check is accepted and recorded with `flaky: true` and the failures of its first run; `status` reports tasks whose verification passed only on a rerun. A command that fails every run fails the attempt. This keeps load-related timeouts from spending the repair budget; it also means an intermittent real defect can pass, so treat recorded flaky checks as defects to fix.

**Repair feedback.** A repair session does not receive raw attempt history. The factory builds a structured record from persisted state (`src/attempt-feedback.ts`): the `open` items of the latest attempt (failed commands with extracted failing tests and a `logFile` holding the full output under `.factory/runs/RUN_ID/logs/`, blocking review findings, UI evidence issues), earlier blocking findings that `mustStayFixed`, a one-line history, and the paths already changed. Reviewers of a repair get the same record and are instructed to verify earlier findings and to raise new blocking findings only for regressions or evidenced defects against an acceptance criterion.

**Task size gate.** `plan`, `run`, `replan`, and `amend` reject a task with more than 5 acceptance criteria or a criterion longer than 300 characters. Plans of existing runs stay loadable.

**Specification and plan review.** `plan` and `replan` send each plan to an independent, read-only plan reviewer (`agents/plan-reviewer.md`, model `agents.planReviewer`, default `agents.reviewer`) before saving it. The reviewer checks the objective for gaps and the plan for traceability to the objective, criteria that the configured verification commands cannot check, task size, and dependency order. Blocking findings go back to a fresh planner session; `planning.maxReviewRounds` (default 2, `0` disables) bounds the number of reviews. Findings that survive the last review are added to the plan as blocking decisions, so `run` refuses the plan until you resolve them: edit the plan or the objective, then set the decision's `blocking` to `false` or remove it. The reports are saved beside the plan as `NAME.review.json`. Plan review does not replace your own review before `run --approve`.

**Objectives.** State a threat model and non-goals in the objective (see `examples/objective.md`). The planner must not assume an adversary that the objective does not name, and reviewers may block only on stated requirements or concrete defects.

## Worktree setup

A fresh run or integration worktree contains only tracked files: no `node_modules` or other ignored build inputs. Configure trusted `setup` commands to prepare it. They run once after each run worktree and each integration worktree is created, before any agent or verification:

```json
"setup": [
  { "executable": "cmd", "args": ["/c", "npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], "timeoutMs": 600000 }
]
```

On Linux and macOS use `"executable": "npm"` with the same arguments after `/c`. Commands run without a shell, so `npm` on Windows needs `cmd /c`. A failed setup stops `run` before any run state exists and blocks an integration attempt. Setup output must be Git-ignored; a setup that dirties tracked files is rejected by the existing clean-worktree checks. `setup` is part of the configuration fingerprint, so it cannot be added to an existing run. `resume` does not rerun setup.

## Implementer checks and factory verification

For initial and repair attempts, implementers should run focused tests and type checks relevant to their changes, including regression tests for repair findings. They do not run the configured full verification commands: the factory runs those itself, and the implementer prompt lists them together with the session time limit. A full command named in a task's `verification` steps is not a reason to run it in the agent session; planners are instructed to write focused steps, and the plan reviewer flags a task that lists a trusted full command. Only repository instructions or operator guidance that explicitly require a full run inside the agent session, or investigation of a specific failure, justify a broader check.

Implementers must honestly report commands run, results and failures, checks not run, and limitations when full checks are deferred or required checks cannot run. An agent's claim, or a future factory check, is not a passed verification and does not replace factory verification. The factory independently runs deterministic task verification (full by default or selected as described below), followed by full final verification, integration preparation checks, and publication verification at their respective gates.

Avoiding one duplicate full-suite run could save roughly seven minutes, based on recent runs as an illustrative baseline. Actual savings vary and are not guaranteed; model compliance with this guidance is not guaranteed either. No verification gate is waived by this guidance.

### Time limits

An agent session is terminated at its `timeoutMs`. After an implementer timeout the next session is told to finish the edits first and not to run a full suite. `timeoutMs` values are not part of the pinned configuration: you may raise an agent or verification time limit and `resume` the same run. Every other setting stays pinned. Runs started before this rule keep their original strict comparison.

### Reusing a full verification of identical content

Running every trusted command again on content that already passed them proves nothing new. With `execution.reuseVerification` (default `true`):

- **Final verification** reuses the last task's verification when that verification ran every trusted command (mode `full`), passed on its first run (not recorded as flaky), and its checkpoint is the head of the run. A checkpoint commits exactly the tree its verification ran on, in the same worktree.
- **Publication** reuses the preparation result when the candidate worktree is clean at the prepared commit and has the Git tree that preparation verified.
- **Integration preparation is never reused.** It is the only verification in a fresh checkout with freshly set-up dependencies; results from the run worktree depend on ignored files that a Git tree does not describe.

A reused result is recorded as `details.reused` with its source; it is never silent. Review is never reused or skipped. Set `execution.reuseVerification` to `false` to run every gate every time.

### Repairing a failed final verification

With task-level selection, a defect in a check that no task selected first shows up at final verification. Instead of blocking at once, the orchestrator adds a repair task, up to `execution.maxFinalRepairs` times per run (default 2, `0` blocks at once). The repair task receives the failed checks as structured feedback, is always verified with every trusted command, is reviewed like any other task, and has the normal repair budget. It is recorded in `finalRepairs`, in the plan (the previous plan moves to `planRevisions`), and as a `PLAN_REVISED` event. It is never replanned automatically. When the budget is spent, or the repair task itself blocks, the run stops for you as before. If every trusted command passes for the repair task and nothing was changed, the failure did not reproduce: the task is withdrawn (its history moves to `supersededTasks`, `finalRepairs[].withdrawn` is set) and final verification runs again.

## Opt-in task verification selection

By default, every task attempt runs the full configured `verification` array. To opt in, add `verificationSelection` to the operator-owned configuration used to start the run. [This example fragment](examples/verification-selection.example.json) shows the format; merge its top-level fields into a complete configuration, adapting the commands, paths and declarations to your repository. The example assumes hypothetical scripts and is not a safe configuration for this or any other repository without an independent audit.

Each rule maps a repository-relative file or directory path to **zero-based indexes** in the trusted `verification` array. Paths match themselves and descendants by whole path segment, not glob patterns. Rules must be nonempty and unique. Rules may be nested: the longest matching path decides, so a rule for one file overrides the rule for its directory; paths cannot be absolute, contain `.` or `..` segments, backslashes or glob characters. Command indexes must be valid and unique within a rule, and configured verification commands must not be duplicates. When several changed paths match, the factory runs the union of their mapped commands in configured order. Agents and task descriptions cannot supply or change these commands. Commands execute directly without a shell; use an appropriate executable for your platform.

**Operator responsibility:** list every repository-relative file or directory that can affect verification in `dependencyPaths` (for example test and build scripts, shared test helpers, package and lock files, tool configuration including legacy configurations, and verification entrypoint directories). Set `dependenciesComprehensive` to `true` only after confirming the list is complete. Also ensure each mapping includes *every* check affected by any change under that path, including cross-component effects. The factory cannot infer either property from arbitrary commands. A syntactically valid but incomplete declaration or unsafe mapping can skip needed task checks; keep full verification if unsure. Changes to commands or declarations change the execution fingerprint, so resume and integration require the original configuration.

Selection falls back to all configured commands if selection is absent, the comprehensive declaration is missing or false, a declared dependency changes (even if mapped), or any changed path is unmapped. It also falls back for empty, unavailable, inconsistent or otherwise unsuitable Git evidence, unsupported changes such as deletions, renames or submodule changes, and selection errors. Invalid configuration is normally rejected before execution. Git evidence covers committed, staged, unstaged and untracked changes against the accepted-task baseline; repairs recalculate against that same baseline, including retained earlier edits. Ignored files and external inputs are not a substitute for declared dependencies: selection cannot establish that commands or mappings are semantically complete.

A failed executed check fails the attempt; review and checkpoint gates still apply after successful verification. **Final verification, integration preparation, and publication verification always cover the full configured command list**, regardless of task selection; they run it unless an identical tree already passed it (see *Reusing a full verification of identical content*). In the target repository, inspect `.factory/runs/<run-id>.json` at `tasks.<task-id>.attempts[].verification`: its `details` records selection `mode`, `reasons`, Git `evidence` (paths, statuses and sources), selected `commands`, and individual `checks` with outcomes and bounded output. Evidence may contain sensitive output; protect the state file. The dashboard exposes pass/fail plus safe phase and command-count progress, and the event log is not the authoritative attempt record.

## Approval-gated integration

Integration has two separately approved stages, using the same configuration as the completed run:

```powershell
# Prepare a merge candidate; does NOT update the target branch
pi-factory integrate --repo PATH --run RUN_ID --config CONFIG_FILE --approve

# Inspect the candidate SHA, reports, and worktree, then explicitly publish it
# With a GitHub upstream this opens a PR; without any remote it updates the local target
pi-factory integrate --repo PATH --run RUN_ID --config CONFIG_FILE --publish --candidate EXACT_SHA --approve
```

Only completed runs with passing final verification are eligible. Preparation creates `factory-integration/<run-id>-<attempt>` in a separate sibling `.factory-integrations/` directory, merging the pinned run tip into the **current** recorded target tip. It runs trusted verification and fresh independent review against the cumulative target-to-candidate diff and all original acceptance criteria. Configured rendered UI evidence is collected when UI review is selected. Specialist requirements and findings survive new integration attempts. Each validated reviewer report is persisted before the next reviewer starts, so a later timeout/invalid response cannot erase earlier findings. Fresh reviewers receive prior findings as explicitly untrusted evidence to reassess against the current candidate. A complete exact-set unanimous result is still required for acceptance. The source run branch and target worktree are not changed by preparation.

During approved preparation, the factory may add an integration repair task for an eligible blocked candidate created by that invocation, then execute it and prepare a fresh candidate. Eligibility requires a completed, passing run, an intact merged candidate with unchanged source and target, remaining integration attempts and repair budget, and an actionable failed verification, changes-requested review, or failed UI evidence check; blocked reviews and merge conflicts are not eligible. Repairs use `execution.maxIntegrationRepairs` per run (default 2, range 0–5; 0 disables repairs). The preparation invocation's approval covers this repair and preparation loop, not publication: publishing still requires a separate approval of the exact candidate SHA. Incomplete or withdrawn repairs stop the loop. The target branch must still be at the commit the run started from: if it has advanced, the candidate contains changes the run worktree lacks, and the attempt is left for you. A check that changes the candidate worktree voids its rejection, so nothing is repaired. While a repair task is pending or running the run is not `completed`; if the command stops then, continue with `resume --approve` and afterwards prepare a candidate with `integrate --new-attempt --approve`.

A conflict, failed check, missing/blocked review, dirty candidate, or changed source/target prevents a ready result. Conflicting files, merge state, branch, and worktree are preserved for inspection; no abort/reset/force operation occurs. Inspect state with `factory status`. To prepare a fresh candidate after resolving the underlying issue through a separately authorized workflow, explicitly add `--new-attempt --approve`. Prior attempts and their findings remain stored. Integration creation has its own bounded attempt count, capped by the original `execution.maxAttempts`; it does not consume/reset task attempts. Only the latest ready candidate can be published.

Publication requires the exact reviewed SHA, unchanged source/target tips, unchanged execution configuration, an intact clean candidate, and the original target repository checked out on the recorded target branch with a clean working tree and no unfinished Git operations. An optional `--target NAME` must equal the run's recorded target; it cannot retarget a run. Trusted checks run again before publishing. Rendered-evidence integrity is rechecked when required. With no configured remote, publication fast-forwards the local target to the exact reviewed merge commit. With any remote configured, local publication is disabled: the target must track a same-named branch on GitHub, and publication pushes the reviewed candidate to a new remote branch and opens a PR using the authenticated GitHub CLI (`gh`). Fetch and push URLs must identify the same github.com repository, and its base must equal the reviewed target. Existing remote candidate branches are never overwritten; a create-only Git lease guards against races. GitHub credentials must be configured outside factory state. Git URL rewrite rules (`insteadOf` or `pushInsteadOf`) are rejected for publication to avoid redirecting the push; do not change Git configuration concurrently with factory operations. Reviews are not rerun when the exact reviewed candidate is unchanged.

An opened PR is recorded as `pr-opened`, not as a completed merge. **The factory does not merge PRs or enable GitHub auto-merge.** Branch protection and human review still apply. If the base or PR head advances after publication, the PR no longer necessarily represents the reviewed candidate; review it again before merging. Automatic merging requires a future server-side merge-queue gate verifying the reviewed tree. Push/PR creation failures after publication starts leave `pr-publishing` for manual reconciliation; inspect the remote branch and PRs before taking further action. A PR may already have been created even if post-creation checks fail, and the factory does not close it. No automatic retry, deletion, or rollback is performed.

After the PR is merged externally, reconcile its recorded GitHub status:

```powershell
pi-factory integrate --repo PATH --run RUN_ID --reconcile
```

Reconciliation reads GitHub; it does not merge the PR or perform GitHub writes. It requires neither `--approve` nor a configuration file, and cannot be combined with `--publish`, `--candidate`, `--new-attempt`, or `--guidance`. It uses the repository integration and run locks; add `--recover-lock` when appropriate.

For a completed run whose latest integration is `pr-opened`, the results are:

| GitHub result | Exit code | Factory state effect |
| --- | --- | --- |
| Merged and matches the reviewed candidate | 0 | Records `published` status and phase, the GitHub merge time as `publishedAt`, and the merge commit SHA. |
| Still open | 0 | Remains `pr-opened`; no state change. |
| Closed without merging | 1 | Rejected; no state change. |
| Merged but not the reviewed candidate | 1 | Rejected; no state change. The recorded URL, base, head and head SHA must match, and the merge time and merge SHA must be valid. |
| GitHub read fails or returns invalid data | 1 | Rejected; no state change. Raw GitHub output is not exposed. |

If the latest integration is already `published`, reconciliation exits 0 without a GitHub read or state change. Other ineligible runs exit 1 without changing state.

Preparation/publication use both the run lock and a repository-wide integration lock. These coordinate this factory locally; **do not concurrently check out branches or change refs/worktrees using other tools**. The factory checks before/after Git operations, but its PID locks do not lock out external Git clients. A crash after publication starts leaves `publishing` state and requires manual reconciliation; it will not blindly retry or roll back a possibly updated target. Failed pre-publication checks never intentionally update the target.

**Not implemented:** automatic conflict resolution, adoption of manually resolved/amended candidates, or automatic worktree cleanup. Conflicted candidates are preserved diagnostic workspaces in this version, not resumable implementation tasks. Publication refuses them; use a separately authorized resolution workflow and a fresh candidate (within budget), or perform manual integration outside the factory.

### Supplying integration review context

When inspection identifies missing decisions or evidence locations, provide an operator-authored file on preparation (or an explicitly approved fresh attempt):

```powershell
pi-factory integrate --repo PATH --run RUN_ID --config CONFIG_FILE --new-attempt --guidance FILE --approve
```

Omit `--new-attempt` for the first candidate. Guidance is limited to 20,000 characters, saved with the attempt before checks/review, and retained for later attempts. It cannot be added during `--publish`; changed context requires a fresh candidate and review within the original attempt budget. Do not include secrets. Use explicit absolute paths for relevant local artifacts: `.factory/` and other ignored files are not copied into integration worktrees. Paths are references, not snapshots; the factory does not copy, authenticate or refresh arbitrary external artifacts.

All integration reviewers receive the saved plan, task-scoped operator guidance, integration guidance and historical task verification records with task/attempt/checkpoint provenance. Current candidate checks remain separate. Operator decisions establish scope, but reported experiments are not promoted to factory-executed checks. Historical results do not establish current candidate correctness. Reviewers inspect evidence and record limitations; they need not personally rerun the factory's independent checks. Missing essential evidence, unresolved blocking findings and failed checks still block. No new execution or network tools are granted to reviewers. For repeatable mandatory checks, configure trusted verification commands before starting a run; this feature does not change a completed run's pinned configuration.

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
- **Uncertainty:** no changed files require all enabled reviewers. An unclassified path requires security review but not UI review: the UI reviewer is selected only by UI paths or UI task text. Ordinary `.md`, `.txt`, and `.rst` documentation needs code only unless paths or task text indicate specialist scope.
- Task descriptions, acceptance criteria, and verification text may **add** specialists, never waive path-based requirements. Routing is heuristic and intentionally conservative, not proof that a change has no security or UI impact.

Removing a specialist from `reviewers` disables that specialist for new work; routing only selects enabled specialists. Required IDs, changed paths, and routing reasons are persisted on the task and each reviewed attempt **before** reviewer invocation. Repairs and reloaded runs retain previous requirements and may add reviewers, but cannot drop them; disabling a previously required reviewer blocks acceptance. Report IDs must match the exact selected set.

All selected reviewers must approve; actionable blocking findings trigger bounded repair attempts, and blocked or invalid reports prevent acceptance. Review reports and feedback use the existing persisted attempt history.

Without a configured `uiEvidence` collector the UI reviewer works from source only and is told not to block for missing rendered evidence; it records what it could not verify as limitations. With a collector, failed interaction or accessibility checks send the task back for repair with the failed checks as feedback, within the normal repair budget. A collector that crashes, times out or writes invalid evidence is an environment problem and still stops the task for you.

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

See [dashboard browser evidence operation](docs/dashboard-browser-evidence.md) for this repository's scoped browser collector, [WPF UI evidence integration](examples/wpf-ui-evidence.md) for FlaUI guidance, and `contracts/ui-evidence.schema.json` for the collector contract.
