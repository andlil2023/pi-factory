---
name: factory-start
description: Prepare an objective and request a PI Factory plan for operator review. Use when starting a planning workflow, not when executing a run.
---

# Factory start

Example invocation from this project: `/skill:factory-start help me plan my objective`.

1. Ask the operator for the target repository and intended objective. Help prepare an objective file with the desired outcome, acceptance criteria, threat model and non-goals. Use `examples/objective.md` in the PI Factory repository as a reference, not as the operator's actual requirements. Do not invent missing decisions. Confirm the file location and contents with the operator before planning; avoid secrets.
2. From the PI Factory repository, after the operator requests planning, run the following with actual paths substituted and quoted as needed:

   ```sh
   npm run factory -- plan --repo PATH --objective OBJECTIVE_FILE --output PLAN_FILE --config CONFIG_FILE
   ```

   Planning invokes the configured Pi planner and writes a new plan file; select an output path that does not already exist. Specify the intended configuration explicitly (for an initialized target this may be `PATH/.factory/config.json`); otherwise the CLI defaults to the factory repository's `factory.config.json`.
3. Present the plan path and ask the operator to review its scope, decisions, tasks and verification. Stop for review. Planning is not approval to execute, amend, integrate or publish; never run an approval-gated command implicitly.
