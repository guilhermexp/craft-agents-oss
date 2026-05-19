# OpenSpec Instructions

Use OpenSpec for substantial feature work, behavioral changes, architecture
changes, or other work that needs a tracked proposal before implementation.

## Workflow

1. Inspect active work with `openspec list`.
2. Read project context in `openspec/project.md`.
3. For a new change, create a proposal under `openspec/changes/<change-id>/`.
4. Validate changes with `openspec validate <change-id> --strict --no-interactive`.
5. Implement tasks in order and mark each checkbox complete as work lands.

## Claude Code Commands

The project includes OpenSpec slash commands in `.claude/commands/opsx/`:

- `/opsx:propose`
- `/opsx:explore`
- `/opsx:apply`
- `/opsx:archive`

Keep `openspec/specs/**` as the long-lived source of truth and
`openspec/changes/**` as the proposal/task history for active work.
