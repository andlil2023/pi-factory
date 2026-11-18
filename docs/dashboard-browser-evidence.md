# Dashboard browser evidence operation

This repository's collector exercises the existing dashboard using the current worktree's assets and `tests/browser-evidence/fixture.json`, not real run data. It starts a loopback dashboard server and an installed Chromium-family browser with a disposable profile. It does not download a browser, use the normal browser profile, or disable sandboxing. Run only trusted collector commands in a trusted local environment.

## Prerequisites and configuration

Install dependencies with `npm ci` and use a Node version supporting `--experimental-strip-types` and the global WebSocket API. Install Chromium, Chrome or Edge with a working headless sandbox. The collector searches specific standard executable locations and a bounded set of Playwright cache directories, not the entire PATH. If discovery fails or picks the wrong browser, set `FACTORY_BROWSER_EXECUTABLE` to the full executable path in the environment that launches the factory or tests. For example, in PowerShell:

```powershell
$env:FACTORY_BROWSER_EXECUTABLE = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
```

The override must be accessible to the process, and the OS must permit the browser sandbox and creation/removal of a temporary profile. The dashboard and browser debugging endpoints use IPv4 loopback.

Add the following **fragment** to a complete, separate operator-owned configuration before starting a new run; retain its existing agents, verification, and enabled `reviewers.ui` settings. This is not a replacement for the complete configuration. Do not edit an existing run's pinned configuration: resume and integration require the original configuration. An operator can keep the separate file under ignored `.factory/` and select it with `--config`.

```json
{
  "uiEvidence": {
    "command": {
      "executable": "node",
      "args": ["--experimental-strip-types", "tests/browser-evidence/collect-dashboard.ts"],
      "timeoutMs": 180000
    }
  }
}
```

The factory runs this command without a shell in the target worktree when UI review is selected, after verification. It supplies `FACTORY_UI_EVIDENCE_DIRECTORY`, `FACTORY_TASK_ID`, `FACTORY_ATTEMPT`, and `FACTORY_SOURCE_FINGERPRINT`; the collector requires these binding values, so invoking the script alone is not a factory validation run. The 180-second external timeout leaves room for the collector's 120-second collection deadline and bounded cleanup. A collection is successful only after owned browser and server cleanup completes.

## Evidence and review

For task attempts, the factory creates a fresh directory under `<repository>/.factory/runs/<run-id>/ui-evidence/<task-id>-<attempt>-*`; for integration it uses `<repository>/.factory/runs/<run-id>/integration-evidence/<integration-attempt>/<task-id>-<attempt>-*`. The record and any issues are in `.factory/runs/<run-id>.json` under the corresponding task attempt's `uiEvidence` or integration attempt's `uiEvidence`. Each directory contains `manifest.json`, `dashboard-{1440,768,390}.png`, and `accessibility-{1440,768,390}.json`. The reviewer receives absolute artifact paths. These directories are outside the candidate worktree; do not hand-edit their contents.

Generation selects the synthetic run, checks persisted task, verification and phase details, keyboard selection, disclosure and refresh, and focus restoration across refresh. At each of 1440, 768 and 390 pixels it checks document-level horizontal overflow and named controls and captures a screenshot and browser accessibility tree. This is a small set of synthetic scenarios and selected keyboard interactions, not coverage of all application states, devices, assistive technology, accessibility requirements, or an accessibility certification.

Deterministic factory validation checks the manifest contract, task/attempt and source binding, capture time, passing interaction and accessibility checks, required artifacts, safe paths, image format and artifact hashes. It rechecks source freshness and artifact integrity around review and at applicable integration gates. This is not visual review: the independent UI reviewer must inspect the actual screenshots and trees, assess behavior and acceptance coverage, report limitations, and block for missing essential evidence or substantive defects. A passing collector or validator is not an approval or proof that the reviewer ran tests.

## Tests and failure diagnosis

From the repository root, with the browser prerequisites available:

```sh
node --experimental-strip-types --test tests/integration/browser-evidence-lifecycle.test.ts tests/integration/browser-evidence-smoke.test.ts
node --experimental-strip-types --test tests/integration/ui-evidence.test.ts tests/ui-evidence-orchestrator.test.ts tests/integration/ui-evidence-timing-regression.test.ts
npm run check
npm test
```

The lifecycle tests use controlled fakes for failure and cleanup paths; the smoke test launches a real browser through `collectUiEvidence`, validates freshness, and removes its temporary evidence directory. The evidence gate tests exercise rejection and orchestration. Full tests also include these tests and require the browser. Test success is not a substitute for reviewing the current attempt's evidence.

On failure, inspect the run status and the persisted `uiEvidence.issues` and review records. Collector command failures or timeouts intentionally produce a generic factory issue: stdout/stderr are not persisted, to avoid exposing sensitive data. Check the executable override, browser installation, headless sandbox and temporary-directory permissions, loopback access, and timeout first; use the focused tests to reproduce safely with synthetic data. A startup, protocol, interaction, overflow, or cleanup failure all fail collection. If termination is uncertain, inspect for surviving owned browser/server processes before retrying; do not assume cleanup succeeded. Validation issues such as stale source, failed checks, missing artifacts, or changed hashes require a fresh collection for the unchanged candidate, not editing the old manifest or bypassing gates. UI-review findings require independent investigation and the normal approved repair/review workflow. Protect any locally inspected logs or artifacts from accidental disclosure.
