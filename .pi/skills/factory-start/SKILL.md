---
name: factory-start
description: Start a run from an approved specification on explicit request, or prepare a manual plan for review.
---

# Factory start

Example invocation from this project: `/skill:factory-start help me plan my objective`.

## Specification-approved start

Use `/skill:factory-spec` to interview the operator and write and publish a specification. Once the operator has reviewed the whole specification and explicitly requests execution, start is the one-step path from that specification to planning and execution:

```sh
pi-factory start --repo PATH --config CONFIG_FILE --spec REF --approve
```

Select the intended repository, configuration and published specification reference explicitly, quoting paths as needed. `--approve` records approval of the specification, not blanket approval of a plan. Never start merely because a specification was published or planning was requested. Stop for blocking decisions or an unapproved plan rather than proceeding implicitly. For a GitHub specification, the first command displays the fetched specification's identity and hash and a follow-up command; verify these with the operator before running the follow-up with `--sha256 HASH`. Use `--new-run` only when the operator explicitly wants to supersede existing non-completed runs for that specification.

## Manual plan path

1. Ask the operator for the target repository, intended configuration and objective. Help prepare an objective file with the desired outcome, acceptance criteria, threat model and non-goals. An initialized target's `.factory/objective.md` is a template, not the operator's actual requirements. Do not invent missing decisions. Confirm the file location and contents with the operator before planning; avoid secrets.
2. After the operator requests planning, use the installed `pi-factory` command from any working directory, substituting explicit paths and quoting them as needed:

   ```sh
   pi-factory plan --repo PATH --config CONFIG_FILE --objective OBJECTIVE_FILE --output PLAN_FILE
   ```

   Planning invokes the configured Pi planner and writes a new plan file; select an output path that does not already exist. Select the intended target and configuration explicitly (for an initialized target the configuration may be `PATH/.factory/config.json`); do not rely on the CLI's packaged configuration default.
3. Present the plan path and ask the operator to review its scope, decisions, tasks and verification. Stop for review. Planning is not approval to execute, amend, integrate or publish; never run an approval-gated command implicitly.
