# Operator quick-start: Windows installed CLI

This walkthrough uses PowerShell and an installed CLI from any working directory. Substitute your own absolute paths, repository URL and released tag. Planning is not approval to execute, integrate or publish.

## Prerequisites and installation

- Install Node.js **24.12.0 or newer** (including npm), Git for Windows, and the Pi coding agent. Put Node, npm and Git on `PATH`. The target must be a Git working tree on a named branch; keep `.factory/` ignored because it can hold sensitive state and evidence.
- Install Pi separately with `npm install --global @earendil-works/pi-coding-agent`, then configure its provider authentication and available model IDs. On Windows the factory's default Pi launch expects that global installation under `%APPDATA%\npm`; if installed elsewhere, configure `pi.executable` and `pi.executableArgs`. Credentials belong in Pi's provider configuration, not the objective, config, guidance or factory state. GitHub CLI (`gh`) and GitHub authentication are additionally needed for publication to a GitHub remote.
- Install a **specific existing GitHub tag**, not a moving branch. For example, once `v0.1.0` has been published in this repository (replace it with the desired actual release tag):

```powershell
npm install --global "git+https://github.com/andlil2023/pi-factory.git#v0.1.0"
pi-factory --help
```

If PowerShell cannot find `pi-factory`, add npm's global executable directory (normally `$env:APPDATA\npm`) to `PATH` and open a new shell. Git and network access to GitHub and npm dependencies are needed for tag installation.

The npm package distributes TypeScript source and required runtime assets, not precompiled JavaScript. Its executable registers the packaged `tsx` loader, including for source under `node_modules`; no factory checkout or TypeScript build is needed on the operator's machine. The package declares Node >=24.12.0. Pi is a separate runtime: the factory launches fresh Pi processes for its planner, implementer and reviewers. A human or another assistant can invoke `pi-factory`; that calling assistant does not replace Pi or its configured models and credentials.

## Initialize and configure a target

```powershell
$target = 'C:\work\my-project'  # existing Git working-tree root
$config = Join-Path $target '.factory\config.json'
$objective = Join-Path $target '.factory\objective.md'
$plan = Join-Path $target '.factory\plan.json'
pi-factory init --repo $target
```

Initialization copies packaged templates to `.factory/config.json` and `.factory/objective.md`; existing files are kept. Use `--force` only when intentionally overwriting them. It does not run the planner. Review and edit `$config`: replace model placeholders with actual Pi provider/model IDs, choose appropriate reviewers, and adapt trusted setup and verification commands to your target and Windows environment. The template's commands and verification selection are examples for this repository, not necessarily safe or meaningful for your target. Setup prepares each fresh worktree; on Windows commands such as npm may need `cmd /c`. Read the [worktree setup and verification guidance](../README.md#worktree-setup). Configure at least one trusted verification command and audit any verification selection mappings or remove them to use full verification.

Pass `--repo` and `--config` explicitly to configuration-consuming commands: the default configuration is resolved in the factory package, not the initialized target, and is not a substitute for your target configuration.

## Prepare and start a specification

A specification describes the desired outcome, not an implementation plan. Start with the packaged `templates/specification.md` (under `Join-Path (npm root -g) 'pi-factory\templates\specification.md'`) and save a draft outside the package, for example `$spec = Join-Path $target 'spec-draft.md'`. Give it a title and sections for **What**, **Why**, **Acceptance criteria** (prefer Given/When/Then), **Out of scope**, **Threat model**, **Open questions**, and **Impact analysis**. Write plain English, avoid secrets, and resolve decisions with the operator rather than inventing answers. Template ideas are credited to the [Elephant-Goldfish Model](https://github.com/google/elephant-goldfish-model), licensed under Apache-2.0.

The optional top-level `specifications` block selects a store. For example, merge this into `$config` for GitHub; Project owner and number are required:

```json
"specifications": {
  "store": "github",
  "local": { "directory": ".factory/specs" },
  "github": {
    "repository": "OWNER/REPO",
    "label": "factory-spec",
    "project": { "owner": "OWNER", "number": 1, "iterationField": "Iteration" }
  }
}
```

Without this block, the store defaults to `local`, with repository-relative directory `.factory/specs`. The directory cannot contain `..` segments or be absolute. Local publication creates a title-derived Markdown file without overwriting an existing one. For GitHub, the repository defaults to the GitHub `origin` remote, the label to `factory-spec`, and the iteration field to `Iteration`. Optional `agents.impactAnalyst` defaults to `agents.planner`; `agents.specReviewer` defaults to `agents.planReviewer`, then `agents.reviewer`.

For GitHub storage, install and authenticate `gh`, create the configured repository label, and configure the Project auto-add workflow to add issues filtered by that label. Grant Project read access with `gh auth refresh -s read:project`. Publication creates a labeled issue; ensure it is added to the configured Project and assigned to a current iteration. Start requires an open issue with the configured label, in that Project, with the configured iteration field set to a current iteration (UTC dates).

```powershell
pi-factory doctor --repo $target --config $config
pi-factory spec check --spec $spec
pi-factory spec review --repo $target --config $config --spec $spec
pi-factory spec impact --repo $target --config $config --spec $spec
# Inspect the entire specification and explicitly approve publication
pi-factory spec publish --repo $target --config $config --spec $spec --approve
# Set $specId to the ID printed by publish
pi-factory start --repo $target --config $config --spec $specId --approve
```

`check` validates the draft, including open questions. `review` offers advisory findings and questions, not approval; address them with the operator and check again as needed. `impact` writes an initial estimate of affected areas and consequences: it is **nonbinding**, neither a requirement nor an implementation limit. `publish` validates and saves with explicit approval, warning rather than rejecting unresolved questions or missing impact analysis alone. Resolve open questions before `start`, which validates again.

For GitHub, start is two-step: the first `start --approve` fetches the issue and prints its title, URL, update time, SHA-256 and next command without starting a run. Inspect it, then explicitly run the printed command with `--sha256 HASH --approve`; it refetches and refuses a hash mismatch. `--new-run` explicitly permits a fresh run when non-completed runs already exist for the same specification; inspect those runs before superseding them.

`start --approve` approves the **specification** and execution, not a manually approved plan. It generates and independently reviews a plan and saves the plan and review report, stopping rather than executing for blocking decisions or a final review that is not approved and clean. It requires trusted verification and enabled plan review. Integration and code publication still require separate approvals.

## Manual path: prepare, plan and approve execution

Edit `$objective` to describe the desired outcome, acceptance criteria, threat model and non-goals; the template is not your requirements. Avoid secrets. Choose a plan output file that does not already exist.

```powershell
pi-factory doctor --repo $target --config $config
pi-factory plan --repo $target --config $config --objective $objective --output $plan
```

Doctor is read-only: it reports prerequisites, configuration, repository readiness, locks and potentially interrupted runs, without recovery. A blocker gives a nonzero exit status; resolve findings first. It does not authenticate Pi or prove a workflow will succeed. Planning invokes Pi and an independent plan reviewer and writes the plan and a review report beside it. Inspect both: review scope, tasks, verification and decisions, and resolve blocking decisions before running. Planning alone authorizes no implementation.

Only after an operator has reviewed the plan and explicitly approved execution:

```powershell
pi-factory run --repo $target --config $config --plan $plan --approve
```

Record the run ID printed by the command. Execution takes place on an isolated run branch; successful task acceptance does not integrate it into the target. Integration preparation and publication are **separate approvals**, not implied by `run --approve`; see [approval-gated integration](../README.md#approval-gated-integration) for candidate inspection, exact-SHA publication, PR and reconciliation requirements.

## Discover and inspect runs

```powershell
pi-factory run-list --repo $target
pi-factory status --repo $target --run RUN_ID
pi-factory doctor --repo $target --config $config
pi-factory dashboard --repo $target --port 3000
```

Use `run-list` to discover IDs and `status` to inspect a run. The dashboard is a read-only loopback viewer at `http://127.0.0.1:3000/`. Status and detailed state can contain sensitive information; share carefully. These commands report persisted evidence, not live process monitoring: `running` does not prove a process is alive, inferred topics are not the objective, and unavailable evidence is not a clean bill of health. Events are observational. Inspect findings, worktrees and verification/review evidence before any separately approved recovery or resume; see [resume guidance](../README.md#persisted-git-state-and-resume).

## Optional Pi skills

The CLI works without skills. The package includes `.pi/skills/factory-spec/SKILL.md`, `.pi/skills/factory-start/SKILL.md` and `.pi/skills/factory-status/SKILL.md`. To use them in Pi, inspect them first, then copy the directories from the installed package to a Pi-discovered project skills directory, for example:

```powershell
$packageSkills = Join-Path (npm root -g) 'pi-factory\.pi\skills'
Get-Content (Join-Path $packageSkills 'factory-spec\SKILL.md')
Get-Content (Join-Path $packageSkills 'factory-start\SKILL.md')
Get-Content (Join-Path $packageSkills 'factory-status\SKILL.md')
New-Item -ItemType Directory -Force -Path (Join-Path $target '.pi\skills') | Out-Null
Copy-Item (Join-Path $packageSkills 'factory-spec') (Join-Path $target '.pi\skills') -Recurse
Copy-Item (Join-Path $packageSkills 'factory-start') (Join-Path $target '.pi\skills') -Recurse
Copy-Item (Join-Path $packageSkills 'factory-status') (Join-Path $target '.pi\skills') -Recurse
```

Do not overwrite existing skills without reviewing them. Start Pi in the target and use `/skill:factory-spec help me write a specification`, `/skill:factory-start help me plan my objective` or `/skill:factory-status inspect my runs`; `/reload` picks up newly added skills in an active session. The spec skill helps prepare a specification; the manual planning path still stops for plan review. Status is read-only and does not approve execution or lock recovery. Review skill instructions before granting project trust.

## Creating a tagged release

A repository maintainer should first review the release commit and ensure `package.json` and the lockfile contain the intended version. From that commit, create and push a matching `v`-prefixed version tag (substitute the actual version):

```powershell
git tag v0.1.0
git push origin v0.1.0
```

A push of a `v`-prefixed tag runs the Windows checks workflow. Only after the Windows type check, fast tests and integration tests pass does its release job download the same npm tarball tested by the integration test and create a GitHub Release for that tag. The release attaches the `pi-factory-<version>.tgz` package; GitHub also provides its generated source archives. Inspect the Actions run and release assets after the push. A failed check or release job needs investigation before retrying; pushing a tag does not publish anything to the npm registry.

The maintainer needs permission to push the tag; GitHub Actions must be enabled and the repository or organization must allow the workflow's `GITHUB_TOKEN` to have `contents: write` for release creation. The Windows job uses only `contents: read`; the release job alone requests `contents: write`. The token is supplied by Actions, not stored in the repository, and no npm registry credential is needed. This tagged-release process is separate from the factory's approval-gated integration and publication steps.

## Upgrade

After reviewing the release and choosing another existing tag, repeat the global install with that exact tag, for example `npm install --global "git+https://github.com/andlil2023/pi-factory.git#v0.1.1"` when available. Alternatively, download the release's tested `.tgz` asset and run `npm install --global PATH_TO_DOWNLOADED_TGZ`. Check `pi-factory --help` afterwards. Upgrading the package does not overwrite the target's initialized files; review configuration compatibility and preserve the original configuration when resuming an existing run. Do not upgrade during an active run. No npm registry publication is required for tag installation.
