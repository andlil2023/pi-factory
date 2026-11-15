# Safe resume — V1

Resume is intentionally conservative: only **between-task** recovery is automated. It will not discard uncommitted files or re-run an interrupted attempt. This is not yet crash-safe continuation inside an agent invocation.

```powershell
npm run factory -- resume --repo "C:\Users\ander\source\repos\calculator" --run "run-..." --approve
```

The command checks the saved run, Git worktree registration, branch, clean working tree, and task checkpoint ancestry before starting new agents. Completed tasks are not rerun. A run that is already completed or blocked is rejected.

An interrupted task (`running`, `needs_review`, `repair_pending`) is rejected for manual inspection, even if its worktree appears clean. No automatic reset, clean, checkout, or merge is performed. If a `.lock` file remains after a crash, verify no factory process is active before removing it manually.

The source repository's `main` may move after the run starts; if no task has yet been checkpointed, V1 conservatively requires its HEAD to match the worktree HEAD.

**Limitations:** Single-host advisory lock only; no automatic repair of interrupted tasks, no support for customized worktree directory, and no recovery from partial checkpoint/state writes. Do not use unattended on important repositories yet.
