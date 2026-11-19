# WPF UI evidence integration

The factory is framework-independent. For a WPF repository, use a dedicated .NET test project with **FlaUI.Core + FlaUI.UIA3** (choose versions compatible with that project's .NET version) and your existing test framework. This document describes the integration contract; it is not an installed or executable FlaUI harness.

## Collector responsibilities

1. Build the current application source, not a cached or previously installed executable. Launch that exact build with isolated, non-production test data.
2. Attach UIA3 to the application's window. Prefer stable `AutomationProperties.AutomationId` selectors; avoid screen-coordinate clicks when possible.
3. Exercise the acceptance criteria, including keyboard navigation, focus, error/loading states, and relevant user flows. Use bounded readiness polling instead of fixed long sleeps.
4. Capture screenshots of relevant windows and a serialized UI Automation tree (control type, AutomationId, accessible name, enabled/focusable state). Avoid secrets, personal data, and unrelated desktop windows.
5. Aggregate actual assertions into interaction and accessibility checks. Failed assertions must not be represented as passed checks. Write the manifest only after artifacts have been saved.
6. Record an identifiable build ID, preferably a hash of the launched application assembly/build output. Associate it with the factory-provided source fingerprint. The factory cannot establish that you launched the right binary by reading a screenshot; the configured collector owns that responsibility.
7. Close only the app processes the test harness launched, even on failure. Do not kill unrelated processes or change machine-wide settings.

Use a dedicated, interactive, unlocked Windows desktop with consistent DPI, resolution, and theme. WPF UI automation is not a headless service workload. Do not run this against a real user's active desktop. Test accounts must be low-privilege and non-production. These controls are operational requirements, not a sandbox enforced by the factory.

## Configuration

Add the `uiEvidence` fragment shown in the README to your trusted factory configuration and keep the `ui` reviewer enabled. The command runs with the target worktree as its working directory, after normal verification and routing, before agent review. Arguments are literal strings, not shell scripts or interpolated task text. Use `dotnet test` only after your test harness implements the manifest contract.

Make sure build/test outputs such as `bin/` and `obj/` are Git-ignored. The collector must not change Git-visible source. Evidence is stored separately under the original repository's `.factory/runs/<run-id>/ui-evidence/`, never committed into the task worktree. This directory contains potentially sensitive screenshots; apply local access controls and a deliberate retention policy. The factory does not upload artifacts to a separate service, but artifacts read by a network-backed reviewer model are sent to that model provider.

## Environment variables supplied by the factory

| Variable | Meaning |
| --- | --- |
| `FACTORY_UI_EVIDENCE_DIRECTORY` | Fresh absolute output directory for this collection |
| `FACTORY_TASK_ID` | Assigned task ID, e.g. `T001` |
| `FACTORY_ATTEMPT` | Positive attempt number |
| `FACTORY_SOURCE_FINGERPRINT` | SHA-256 identity of HEAD and current Git-visible source, including untracked files |
| `FACTORY_UI_EVIDENCE_IMAGE_LINKS` | `1` when the host supports the optional `imageLinks` manifest property; otherwise omit that property |

Write `manifest.json` directly within the output directory. Artifact paths must be relative to that directory; absolute paths, traversal, and links to outside files are rejected. Screenshots must be PNG or JPEG. Artifacts must be nonempty regular files of at most 20 MiB each; the manifest is limited to 1 MB. Do not write credentials into checks, limitations, screenshots, trees, or logs.

The factory creates the capture directory; do not reuse artifacts from earlier attempts. `capturedAt` must be an ISO timestamp generated during this invocation, such as `DateTimeOffset.UtcNow.ToString("O")`. The operator-approved policy allows an inclusive 50 ms margin before the recorded collection start and after its end. This tradeoff can admit stale timestamps just outside the recorded interval; timestamps beyond either margin are rejected. In a Windows Node 24 investigation, some collector timestamps compared later than the parent’s recorded end despite being generated before process completion. Different process wall-clock readings or clock adjustments are hypotheses, not established causes; the measurements from one host and fixture do not establish a universal bound or prove that 50 ms is sufficient for every collector. See [the investigation](../docs/windows-ui-timing-investigation.md) for measurements and limitations. Copy the provided task ID, attempt, and source fingerprint exactly.

## Manifest shape

This is illustrative, not runnable evidence. Replace all example identities, timestamps, and statuses with values from the current test execution:

```json
{
  "version": 1,
  "taskId": "T001",
  "attempt": 1,
  "capturedAt": "2026-01-01T12:00:00.000Z",
  "sourceFingerprint": "0000000000000000000000000000000000000000000000000000000000000000",
  "application": { "framework": "wpf", "buildId": "SHA256_OF_LAUNCHED_APPLICATION_BUILD" },
  "checks": [
    { "kind": "interaction", "name": "Save settings with keyboard", "status": "passed" },
    { "kind": "accessibility", "name": "Settings controls have accessible names", "status": "passed" }
  ],
  "artifacts": [
    { "kind": "screenshot", "path": "settings-window.png" },
    { "kind": "accessibility-tree", "path": "settings-uia-tree.json" },
    { "kind": "log", "path": "interaction-results.txt" }
  ],
  "imageLinks": [
    { "checkName": "Save settings with keyboard", "screenshotPath": "settings-window.png", "caption": "Settings window after saving" }
  ],
  "limitations": ["Verified at 100% DPI only"]
}
```

Only emit optional `imageLinks` when `FACTORY_UI_EVIDENCE_IMAGE_LINKS` is exactly `1`; legacy hosts reject unknown properties. Capability negotiation does not authorize display. The links explicitly associate a unique check name with a screenshot artifact path and a plain-text caption; unrelated screenshots are not implicitly associated with any check. The trusted factory configuration may set `uiEvidence.syntheticDeveloperReviewAuthorized` to `true` only for a synthetic collector whose images are approved for developer-review display. It defaults to false; collector output cannot grant this authorization. The factory records the configured authorization at collection time. This setting does not itself expose images or change review gates.

At least one interaction check and one accessibility check must be present and all checks must pass. Both screenshot and accessibility-tree artifacts are mandatory. A log is optional. The factory validates file presence, confinement, image signatures, and hashes; it does not itself prove image authenticity, parse the UIA tree's semantics, or decide whether the test coverage is sufficient. The independent UI reviewer evaluates those against the task's acceptance criteria and must disclose limitations.

Collection failure, invalid/stale evidence, source mutation during collection, or later artifact tampering prevents acceptance. Evidence records, including failures, are persisted in each attempt's `uiEvidence` field. The source fingerprint covers Git-visible files, not ignored build outputs, dependencies outside the repository, or machine configuration. Git submodule directory entries are currently unsupported by evidence fingerprinting and fail closed.

## Suggested initial WPF pilot

Start with one settings dialog: open it, locate controls by AutomationId, change a value, navigate using Tab, activate Save using the keyboard, reopen and assert persistence. Capture the dialog and UIA tree, and assert accessible names for the edited controls. Then add failure-state and higher-DPI coverage. No production application should be launched as part of the factory's own tests; its collector tests use synthetic fixtures only.
