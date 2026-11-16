# Command-line calculator

Build a command-line calculator that supports addition and subtraction. Use the existing language and tooling in the target repository if available. Include tests and helpful errors for invalid input.

## Threat model

State who the attacker is and what they control, or state that there is none. The planner must not assume an adversary that this section does not name.

- Example: a local single-user tool. Input comes from the invoking user and is trusted. No network exposure.

## Non-goals

List what the plan must not add, so that planners and reviewers do not escalate scope.

- Example: no configuration files, no plugins, no hardening against a hostile local filesystem.

## Acceptance

- Example: `calc 2 + 3` prints `5`; invalid input exits nonzero with a message.
