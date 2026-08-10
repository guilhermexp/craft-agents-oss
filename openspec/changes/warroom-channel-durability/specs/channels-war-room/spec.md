## ADDED Requirements

### Requirement: Participant session bindings survive restart
The system SHALL persist the mapping between a War Room channel participant and its backing session in workspace storage and SHALL reuse a persisted session after an app restart when that session still exists.

#### Scenario: Binding is persisted on session creation
- **WHEN** the orchestrator creates a backing session for a channel participant
- **THEN** the channel→participant→session binding is written to workspace channel storage

#### Scenario: Restart reuses the persisted session
- **WHEN** the app restarts and a channel message targets a participant with a persisted binding to a still-existing session
- **THEN** the orchestrator reuses that session instead of creating a new one

#### Scenario: Stale binding is replaced
- **WHEN** a persisted binding references a session that no longer exists
- **THEN** the orchestrator creates a new backing session and rewrites the binding

### Requirement: Kanban watches survive restart
The system SHALL persist the set of watched Kanban task ids per channel and SHALL resume watching persisted pending tasks when the channel manager starts.

#### Scenario: Watch list is persisted
- **WHEN** Kanban tasks enter or leave a channel's watch set
- **THEN** the persisted watch list for that channel reflects the change

#### Scenario: Restart resumes watching
- **WHEN** the channel manager starts and a persisted watch list contains pending task ids
- **THEN** those tasks are watched again and terminal results still flow back into the channel

#### Scenario: Task completed while app was closed
- **WHEN** the channel manager starts and a persisted watched task is already in a terminal status
- **THEN** the terminal result flows into the channel through the task update flow

### Requirement: Boot reconciliation resolves orphaned dispatches
The system SHALL reconcile dispatch state on channel manager start so that no dispatch remains indefinitely in a non-terminal status without a live execution.

#### Scenario: Orphaned running dispatch is failed
- **WHEN** the channel manager starts and a dispatch is recorded as `queued` or `running` with no live execution
- **THEN** the dispatch is marked `failed` with an error indicating the app restarted

### Requirement: Kanban watch covers all delegation surfaces
The system SHALL watch Kanban tasks created during any channel-originated agent turn, not only turns started by a user channel message.

#### Scenario: Tasks created during channel_dispatch are watched
- **WHEN** a participant session invokes `channel_dispatch` and the receiving turn creates Kanban tasks assigned to channel assignees
- **THEN** those tasks are added to the channel's watch set

#### Scenario: Tasks created during re-delegation are watched
- **WHEN** the lead creates new Kanban tasks while handling a task update turn
- **THEN** those tasks are added to the channel's watch set

### Requirement: A Kanban task is claimed by exactly one channel
The system SHALL ensure a Kanban task id is watched by at most one channel, with the first claim winning, and SHALL persist claims alongside watch lists.

#### Scenario: Cross-channel collision resolves to first claim
- **WHEN** two channels with overlapping assignees would both match a newly created Kanban task
- **THEN** only the first channel to claim the task watches it and the other channel ignores it

### Requirement: Participant session delivery is serialized
The system SHALL serialize message delivery per backing session so that concurrent channel messages to the same participant are processed one at a time.

#### Scenario: Concurrent channel messages queue per session
- **WHEN** two channel messages target the same participant session concurrently
- **THEN** the second delivery starts only after the first completes and each reply is matched to its own delivery

### Requirement: Agent replies are appended incrementally
The system SHALL append each participant reply to the channel history and emit the messages-changed event as soon as that reply arrives, without waiting for other targeted participants.

#### Scenario: Fast participant reply is visible before slow one
- **WHEN** a channel message targets multiple participants and one reply arrives before the others
- **THEN** that reply is appended and broadcast immediately while remaining dispatches stay `running`

### Requirement: Dispatches time out
The system SHALL bound each dispatch with a timeout (default 12 minutes) so a stuck participant cannot block the channel indefinitely.

#### Scenario: Timed-out dispatch is failed without blocking the batch
- **WHEN** a participant does not complete within the dispatch timeout
- **THEN** its dispatch is marked `failed` with a timeout error and the send flow completes for the other participants

#### Scenario: Late reply is still recorded
- **WHEN** a reply arrives after its dispatch timed out
- **THEN** the reply is still appended to the channel history

### Requirement: Kanban watcher reads current channel configuration
The system SHALL resolve the channel configuration from storage on each watch cycle rather than using the configuration captured when the watch was armed.

#### Scenario: Edited channel is respected
- **WHEN** a channel's participants change while tasks are being watched
- **THEN** the next watch cycle uses the updated channel configuration

#### Scenario: Deleted channel stops its watch
- **WHEN** a watched channel no longer exists in storage
- **THEN** its watch entries are dropped

### Requirement: User text cannot forge packet frames
The system SHALL neutralize channel packet frame markers occurring in user-supplied text before embedding it in participant or orchestrator packets.

#### Scenario: Frame marker in user message is neutralized
- **WHEN** a user channel message contains a `<<craft-channel-` frame marker
- **THEN** the packet sent to the participant does not contain the marker as an active frame

### Requirement: Dispatches can be cancelled
The system SHALL allow cancelling a `queued` or `running` dispatch, marking it `cancelled` and aborting the backing run when the session runtime supports aborting.

#### Scenario: Cancel marks the dispatch
- **WHEN** a client cancels a running dispatch
- **THEN** the dispatch status becomes `cancelled`

#### Scenario: Cancelled participant reply is not appended as normal completion
- **WHEN** a dispatch is cancelled before its reply arrives
- **THEN** the dispatch does not transition to `completed`
