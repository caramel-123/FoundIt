# Spec-Driven Workflow

The project specification is the source of truth. Always update the spec before
implementing any new feature or requirement. Never implement from chat alone.

## Rules

- When the user requests a feature or behavior change, FIRST update the relevant
  spec document(s) under `.kiro/specs/`, THEN implement the change to match the
  updated spec. Spec and code must not land in the reverse order.
- Keep the three spec documents consistent when a change touches them:
  - `requirements.md` — user stories and EARS-style acceptance criteria
  - `design.md` — architecture, components, data model, and design decisions
  - `tasks.md` — the implementation task list
- Do NOT implement feature changes that are not reflected in the spec. If an
  implementation request has no corresponding spec entry, update the spec first.
- If a requested change conflicts with the current spec, surface the conflict and
  update the spec to resolve it before writing code.
- If implementation has already drifted ahead of the spec, STOP feature work and
  catch the spec up before writing more application code.
- Pure bug fixes, refactors, and cosmetic tweaks that do not change specified
  behavior do not require a spec change, but any change to specified behavior
  does.

## Active specs

- `.kiro/specs/campus-lost-found/` — Campus Lost & Found (requirements, design,
  tasks).
