---
name: factory-spec
description: Interview an operator to write and publish an approved specification, without starting a run.
---

# Factory specification interview

Help the operator specify the outcome, not its implementation. Before asking any questions, identify the target repository from the request or available context, read its applicable repository instruction files, and read `<target>/.factory/specification-template.md` if present; otherwise read the packaged `templates/specification.md` from the PI Factory installation. Inspect relevant repository evidence before asking about it. If the target or template cannot be identified, ask for the missing location using the question format below rather than guessing; read both before beginning the substantive interview. Use the template's required headings even if its guidance is customized.

## Interview

- Ask exactly one question per turn, with 2–4 concrete options, one recommended option and a one-line reason for that recommendation. Always allow a free-text answer. Use the same format for clarifications and review findings.
- Do not ask questions the repository already answers. Do not invent product, security, or architecture decisions. If the operator defers a decision, record it under Open questions rather than deciding it for them.
- Cover these subjects in order: What, Why, Acceptance criteria, Out of scope, Threat model. For the threat model identify an attacker and what they control, or record "None" when appropriate. Favor observable Given/When/Then acceptance criteria.
- Use plain English, no flattery, and identify the weakest point of each answer before accepting it. Do not solicit or include secrets. The specification describes what and why, not design, file lists, or implementation steps.
- Confirm a draft path with the operator before writing; suggest `<target>/.factory/specs/drafts/<slug>.md` as the default. Write the draft using the template, including Open questions. Do not silently resolve deferred decisions or replace them with `None`.

## Check, review, and publish

Use the installed `pi-factory` CLI with explicit target, configuration, and draft paths, quoting paths as needed. Select the intended target configuration explicitly rather than relying on a packaged default.

1. Run `pi-factory spec check --spec FILE`. Address validation issues with the operator using the interview format, update the draft, and check again. In particular, unresolved Open questions fail this check: ask the operator to resolve them, or stop and report the draft and outstanding questions if they defer. Do not pretend a failed check passed.
2. Once the check passes, run `pi-factory spec review --repo PATH --config FILE --spec FILE`. Work through each finding as an interview question, one per turn; incorporate answers in the draft and record deferred decisions under Open questions. Run the review at most once more after addressing the first pass. Report any remaining findings to the operator rather than looping. Review findings are advisory, not a validation or publication gate; do not claim they block publishing. Recheck the updated draft and report any validation issues, including deferred questions, without misrepresenting the CLI's gates.
3. Run `pi-factory spec impact --repo PATH --config FILE --spec FILE` on the updated draft. Impact analysis is an initial, nonbinding estimate, not requirements, a file allowlist, or implementation instructions. Report command failures instead of inventing an impact analysis.
4. Show the operator the draft path and the whole updated specification, including any open questions, remaining review findings and impact estimate. Ask for explicit confirmation of the entire specification for publication, using the interview question format. Never treat earlier answers or a review as publication approval.
5. Only after explicit confirmation, run `pi-factory spec publish --repo PATH --config FILE --spec FILE --approve` and report the resulting reference or any failure. Publishing validates the draft but permits Open questions with a warning; such a specification cannot be started until resolved. A missing impact analysis also produces a warning. Do not present advisory review findings as a CLI gate.

Never run `pi-factory start`; publishing is not authorization to execute a run.
