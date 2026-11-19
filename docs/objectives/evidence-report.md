# Objective: pre-merge evidence report

A developer reviewing a completed factory run should be able to answer “Did this implement my specification?” from the dashboard, without reading a diff or an agent transcript.

## Acceptance criteria

- After implementation and verification, the factory generates a persistent report tied to the run, the specification/plan revision and the implementation revision reviewed. It is available from the run dashboard before the developer decides whether to integrate. Viewing it does not approve anything.
- The first view gives the change in one sentence, the verification outcome and any gaps. For each acceptance criterion, show the expected behavior, a short observed result and its evidence. Keep supporting detail collapsed; do not paste command logs or generate a narrative of the implementation process.
- Distinguish demonstrated behavior, failed checks and behavior without direct evidence. An implementer claim or a passing suite without a criterion-specific check is not proof of that criterion. Missing evidence stays visible.
- Render structured text and inline, captioned PNG/JPEG screenshots. For a UI criterion, place the relevant image beside the result. Nonvisual criteria can use a named check and its observed outcome. If a picture is unavailable, say so rather than displaying a broken image.
- The report is observational only. Do not add or change approval state, gates, actions, or integration/publication behavior. If evidence describes a different revision, do not present it as current. For older runs without a report, keep the dashboard usable and indicate that no report is available.

## Criterion-to-check mapping

The reviewed plan is authoritative for the association of an acceptance criterion with a named check. Only a matching, factory-recorded passing observation for the reviewed revision demonstrates that criterion; show a matching failure as failed, and absent, ambiguous or stale evidence as not demonstrated. Never infer the association from implementer prose, task completion or an unrelated passing suite.

## Trust and privacy

Trust the local operator and factory configuration, not report text, artifact paths, or collected files. Screenshot display defaults off. Only display images from a trusted collector explicitly configured to use synthetic developer-review data; a digest does not establish that an image is safe to share.

Use factory-recorded verification outcomes and validated artifacts. Treat report text as untrusted text, not executable HTML. Only expose screenshots belonging to the selected run with validated type and matching digest; do not expose arbitrary files, raw agent outputs or collector logs. Screenshot collection must use data suitable for developer review.

## Proposed first-release boundary

Report generation and a read-only dashboard report viewer, using the existing approval and revision workflows. Queue scheduling, a dashboard specification editor, new merge controls and video playback are separate features.

## Demonstration

Require a rendered browser demonstration of the dashboard showing a captioned inline screenshot beside its criterion and a visible criterion with no supporting check. Source inspection alone is insufficient. Also demonstrate a non-UI run with named check evidence. Confirm that the unsupported criterion is not marked demonstrated and that a modified screenshot is not served.
