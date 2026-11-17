---
name: factory-status
description: Inspect persisted PI Factory run evidence and suggest safe next steps. Use when an operator asks about run status or blockers.
---

# Factory status

Example invocation from this project: `/skill:factory-status inspect my runs`.

Ask for the target repository and, if needed, its configuration and run ID. From the PI Factory repository, substitute actual paths and IDs, quoting paths as needed:

```sh
npm run factory -- run-list --repo PATH
npm run factory -- status --repo PATH --run RUN_ID
npm run factory -- doctor --repo PATH --config CONFIG_FILE
```

Use `run-list` to discover IDs, then `status` for the selected run; `doctor` checks prerequisites, repository readiness, locks and potentially interrupted runs without recovery. The configuration defaults to the factory repository's `factory.config.json` if omitted; explicitly select the intended one, such as `PATH/.factory/config.json` for an initialized target.

Explain that these commands report persisted evidence: a recorded running status is not proof of process liveness, inferred topics are not the objective itself, and unavailable evidence is not a clean bill of health. Status may include task attempts, errors, checkpoints and integration state; detailed state and observational event logs can contain sensitive information. Events are not authoritative task status. Distinguish task acceptance on a run branch from integration or publication, and do not declare acceptance yourself.

Suggest inspection of relevant findings, worktree and verification/review evidence; ask the operator to resolve decisions and independently confirm stopped processes before considering lock recovery. Do not edit state, locks, run history or worktrees, and do not recover, resume, amend, integrate or publish. Any such action requires a separate explicit operator decision and the applicable approval gates. Stop after reporting evidence and safe next actions.
