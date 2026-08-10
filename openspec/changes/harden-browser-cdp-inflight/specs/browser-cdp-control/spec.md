## ADDED Requirements

### Requirement: The idle debugger detach never runs while a CDP command is in flight
The system SHALL track the number of CDP commands currently awaiting a response and SHALL NOT
detach the debugger for inactivity while that count is greater than zero. When the idle deadline
expires with a command in flight, the system SHALL re-arm the idle countdown instead of detaching.
A command SHALL restart the idle countdown as soon as the debugger is attached for it, so it never
inherits the remainder of a previous command's window. Every command the system dispatches SHALL be
counted, including the emulation state reapplied while attaching. The idle detach itself SHALL be
preserved: the debugger MUST still detach after inactivity once no command is in flight, and the
in-flight gate SHALL be bounded — a command that receives no response within a fixed command
deadline SHALL be abandoned with an error so it cannot hold the gate open indefinitely. The system
SHALL NOT re-arm the idle countdown after the debugger has been detached, and an externally
triggered detach SHALL clear any armed countdown.

#### Scenario: Idle deadline with a command in flight does not detach
- **WHEN** the idle deadline expires while at least one CDP command is awaiting a response
- **THEN** the debugger is not detached
- **AND** the idle countdown is re-armed

#### Scenario: In-flight command is not rejected by an idle detach
- **WHEN** a CDP command is issued and the idle deadline would expire before it resolves
- **THEN** the command resolves with its result
- **AND** it does not fail with `target closed while handling command`

#### Scenario: Detach resumes once the last command settles
- **WHEN** the last in-flight command settles and the idle deadline then expires
- **THEN** the debugger is detached

#### Scenario: A failing command still releases the gate
- **WHEN** an in-flight CDP command rejects
- **THEN** the in-flight count returns to its pre-command value
- **AND** a later idle deadline detaches the debugger

#### Scenario: A command starts inside a full idle window
- **WHEN** a CDP command attaches the debugger
- **THEN** the idle countdown is restarted before the command is dispatched

#### Scenario: A command that never answers is abandoned
- **WHEN** a CDP command receives no response for longer than the command deadline
- **THEN** the call rejects reporting the timeout
- **AND** the in-flight count returns to its pre-command value
- **AND** a later idle deadline detaches the debugger

#### Scenario: The emulation reapplied on attach is inside the gate
- **WHEN** the debugger reattaches and reapplies the emulated color scheme
- **THEN** that command counts as in flight while it is awaiting its response

#### Scenario: An external detach leaves no armed countdown
- **WHEN** the debugger is detached by something other than this system, such as the user opening
  the pane's DevTools
- **THEN** any armed idle countdown is cleared

#### Scenario: An explicit detach is not followed by a re-armed countdown
- **WHEN** a command settles after `detach()` has already run
- **THEN** no new idle countdown is armed

### Requirement: A click that did not land is reported as a failure
The system SHALL NOT report success for a coordinate click whose delivery it could not establish.
When the CDP click fails with a detached-target error before the press was delivered, the system
SHALL re-attach and replay the click through CDP exactly once, and SHALL propagate the error if
that replay also fails. When a detached-target error occurs after the press was already delivered,
the system SHALL re-attach and resend only the release, because the delivered press cannot be
retracted and a second press would double-fire the target. When any other failure occurs after the
press has been delivered, the system SHALL propagate the error rather than emitting an additional
native down/up pair. The CDP replay SHALL carry the same button state and press-to-release gap as
the humanized path it stands in for. The native `sendInputEvent` fallback SHALL be attempted only
when no press was delivered, SHALL be preceded by a mouse move to the target point, and SHALL
propagate its own errors.

#### Scenario: Detached target is retried through CDP
- **WHEN** a CDP click fails with a detached-target error and the replay succeeds
- **THEN** the debugger is re-attached
- **AND** the click is replayed through CDP
- **AND** the call resolves

#### Scenario: The CDP replay is not distinguishable from the humanized path
- **WHEN** a click is replayed through CDP
- **THEN** the press carries the pressed button state and the release carries the released one
- **AND** the press and the release are separated by the same delay the humanized path uses

#### Scenario: A detached target after a delivered press replays only the release
- **WHEN** the CDP click fails with a detached-target error after the press was delivered
- **THEN** the debugger is re-attached
- **AND** exactly one press has reached the page in total
- **AND** the click is closed with a single release

#### Scenario: Failed replay surfaces as a failed click
- **WHEN** a CDP click fails with a detached-target error and the CDP replay also fails
- **THEN** the call rejects
- **AND** no native down/up pair is emitted

#### Scenario: Failure after a delivered press does not double-fire
- **WHEN** the CDP click fails after the press has already been delivered
- **THEN** the call rejects
- **AND** no native down/up pair is emitted

#### Scenario: Native fallback keeps its narrow slot
- **WHEN** the CDP click fails before any press was delivered and the failure is not a
  detached-target error
- **THEN** the click is replayed with `sendInputEvent`, preceded by a mouse move to the target point

#### Scenario: A failing native fallback is not silent
- **WHEN** the native fallback itself throws
- **THEN** the call rejects

### Requirement: A completed action is not failed by its trailing geometry read
The system SHALL treat the element geometry read that surrounds a fill, a select, or a file-input
assignment as best-effort bookkeeping rather than part of the action's result. Each of those
actions SHALL read the element geometry before acting and SHALL return that pre-action reading
when the post-action refresh fails. Neither read SHALL prevent the action itself from running, and
neither read failing SHALL fail the action: when the element has no box model at either end, the
action SHALL resolve with no geometry. Geometry that is a genuine precondition — the click point
resolved before a click — SHALL remain strict.

#### Scenario: A fill that navigates the page still succeeds
- **WHEN** a fill submits the form and the page navigates before the trailing geometry read
- **THEN** the fill resolves
- **AND** it returns the geometry captured before typing

#### Scenario: Select and file-input assignment behave the same way
- **WHEN** the trailing geometry read fails after a select or a file-input assignment
- **THEN** the action resolves with the pre-action geometry

#### Scenario: An element that can never be measured still completes its action
- **WHEN** both the pre-action and the post-action geometry reads fail
- **THEN** the action still runs
- **AND** the action resolves without geometry

#### Scenario: A click still fails when its target geometry cannot be resolved
- **WHEN** the geometry read that resolves the click point fails
- **THEN** the click rejects

### Requirement: Raw stale-node protocol errors are translated for the agent
The system SHALL translate CDP errors reporting that a node no longer exists into the same
actionable stale-ref message it produces when a ref is missing from the current snapshot,
instructing the caller to take a fresh snapshot. Errors that do not report a missing node SHALL be
propagated unchanged.

#### Scenario: Blink's raw missing-node error is translated
- **WHEN** a CDP command fails with `Node cannot be found in the current page.`
- **THEN** the caller receives the stale-ref message telling it to run `browser_snapshot` first

#### Scenario: The other missing-node wording is translated too
- **WHEN** a CDP command fails with `No node with given id found`
- **THEN** the caller receives the same stale-ref message

#### Scenario: Unrelated protocol errors are untouched
- **WHEN** a CDP command fails with an unrelated protocol error
- **THEN** that error is propagated unchanged
