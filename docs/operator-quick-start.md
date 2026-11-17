# Operator quick-start: plan first

This workflow prepares a plan for review; it does not approve implementation, integration or publication. Run the commands below from the PI Factory repository, replacing `PATH_TO_TARGET` with the target Git working-tree root and quoting paths as needed.

## Prerequisites and initialization

Install Node.js 22.6 or newer with `--experimental-strip-types` support, npm, Git and Pi. Configure Pi access and a supported provider/model before planning; do not put credentials in the objective or factory state. Install this repository's dependencies with `npm ci`. The target should be a Git repository; keep its `.factory/` directory ignored because it can contain sensitive state and evidence.

Initialize the target using one of the following:

```sh
./init-factory.sh PATH_TO_TARGET
```

```powershell
./init-factory.ps1 -Target PATH_TO_TARGET
```

Initialization writes `.factory/config.json` and `.factory/objective.md` in the target from examples, keeping existing files by default; it does not run the planner. Review and edit the configuration: replace model placeholders with available Pi model IDs, and adapt trusted setup and verification commands to the target and platform (the example setup uses Windows `cmd`). Do not use `--force` (PowerShell: `-Force`) unless you intend to overwrite the files.

## Prepare and plan

Edit `PATH_TO_TARGET/.factory/objective.md` to describe the desired outcome, acceptance criteria, threat model and non-goals. The [example objective](../examples/objective.md) is a template, not your requirements. Avoid secrets. Choose a plan output file that does not already exist.

```sh
npm run factory -- doctor --repo PATH_TO_TARGET --config PATH_TO_TARGET/.factory/config.json
npm run factory -- plan --repo PATH_TO_TARGET --objective PATH_TO_TARGET/.factory/objective.md --output PATH_TO_TARGET/.factory/plan.json --config PATH_TO_TARGET/.factory/config.json
```

Doctor is read-only: it reports blockers and warnings for prerequisites, configuration, repository readiness, locks and potentially interrupted runs; it does not recover them. A blocker gives it a nonzero exit status. Address findings before proceeding. It does not authenticate Pi or prove that a workflow will succeed. The plan command invokes the configured Pi planner and writes the plan file; review its scope, decisions, tasks and verification before deciding what to do next. Planning is not authorization to run it. Execution and later integration/publication require separate explicit approval through their respective gates.

Pass `--config` explicitly as above: without it the CLI uses `factory.config.json` in the PI Factory repository, **not** the initialized target's `.factory/config.json`.

## Discover and inspect runs

```sh
npm run factory -- run-list --repo PATH_TO_TARGET
npm run factory -- status --repo PATH_TO_TARGET --run RUN_ID
npm run factory -- doctor --repo PATH_TO_TARGET --config PATH_TO_TARGET/.factory/config.json
```

Use `run-list` to discover IDs and `status` to inspect a selected run. Status output and detailed state can contain sensitive information; share them carefully. These commands report persisted evidence, not live process monitoring: `running` does not prove a process is alive, inferred topics are not the objective, and unavailable evidence is not a clean bill of health. Events are observational; task acceptance on a run branch is not target integration. Inspect findings, worktrees and verification/review evidence before any separately approved action.

## Pi skills

From the PI Factory project directory, start Pi so it can discover the project-local skills. In the interactive session use:

```text
/skill:factory-start help me plan my objective
/skill:factory-status inspect my runs
```

The start skill helps prepare the objective and requests a plan, then stops for operator review. The status skill uses the read-only commands above and explains persisted evidence and safe next steps; it does not recover locks or approve execution. Review skill instructions before granting project trust.
