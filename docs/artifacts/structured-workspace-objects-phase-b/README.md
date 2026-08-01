# Phase B real Electron smoke

Date: 2026-08-01

Build: `fd2ac1a5`
Profile: isolated under `/tmp/craft-phase-b-smoke.yoifn5`; no user workspace was
modified.

The packaged Electron build opened `Phase B Demo` from the isolated workspace
at revision 9. The table editor changed `Alpha` to `Alpha Edited` and the UI
revalidated at revision 10. A real DevTools mouse sequence then dragged that
entry from `Todo` to `Doing`; the committed revision became 11 and the board
showed `Todo 0`, `Doing 2`, `Done 1`, and one ungrouped entry.

The same object payload rendered table, Kanban, calendar, timeline, gallery,
and list adapters. A saved Kanban view with missing settings first rendered the
explicit configuration state. Choosing `Status` and saving persisted
`groupFieldId: field_status` at revision 12.

After closing the window and restarting the Electron process with the same
isolated profile, the sidebar restored `Phase B Demo` at revision 12, selected
`view_needs_config`, rendered Kanban, and retained `Alpha Edited` in `Doing`.
Read-only SQLite inspection confirmed revision 12, projection status `ready`,
the edited values, and the saved view config. The final window close emitted
both `Window closed` and `Client disconnected`; the Electron processes exited
and CDP port 9332 was no longer listening.

## Captures

- `01-workspace-restored.png`: initial isolated-profile onboarding surface.
- `02-main-window.png` through `05-table-view.png`: workspace/session/object
  navigation and the initial table.
- `06-table-edit-committed.png`: committed table edit at revision 10.
- `07-kanban-view.png`: initial Kanban projection.
- `08-kanban-drag-committed.png`: real mouse drag committed at revision 11.
- `09-calendar-view.png` through `12-list-view.png`: alternate adapters over
  the same payload.
- `13-needs-config.png`: explicit empty-configuration guidance.
- `14-configured-kanban-unsaved.png`: locally configured Kanban before save.
- `15-saved-view-committed.png`: saved view committed at revision 12.
- `16-restart-restored.png`: state restored after full Electron restart.

Machine-readable assertions are in `smoke-evidence.json`; lifecycle excerpts
are in `electron-teardown.log`.
