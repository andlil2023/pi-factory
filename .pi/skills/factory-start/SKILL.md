---
name: factory-start
description: Prepare an objective and request a PI Factory plan for operator review. Use when starting a planning workflow, not when executing a run.
---

# Factory start

Example invocation from this project: `/skill:factory-start help me plan my objective`.

1. Ask the operator for the target repository, intended configuration and objective. Help prepare an objective file with the desired outcome, acceptance criteria, threat model and non-goals. An initialized target's `.factory/objective.md` is a template, not the operator's actual requirements. Do not invent missing decisions. Confirm the file location and contents with the operator before planning; avoid secrets.
2. After the operator requests planning, use the installed `pi-factory` command from any working directory, substituting explicit paths and quoting them as needed:

   ```sh
   pi-factory plan --repo PATH --config CONFIG_FILE --objective OBJECTIVE_FILE --output PLAN_FILE
   ```

   Planning invokes the configured Pi planner and writes a new plan file; select an output path that does not already exist. Select the intended target and configuration explicitly (for an initialized target the configuration may be `PATH/.factory/config.json`); do not rely on the CLI's packaged configuration default.
3. Present the plan path and ask the operator to review its scope, decisions, tasks and verification. Stop for review. Planning is not approval to execute, amend, integrate or publish; never run an approval-gated command implicitly.
