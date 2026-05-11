# messaging-gateway Specification

## Purpose
Conectar canais de mensageria externos (WhatsApp via Baileys, e futuros) a sessões e agentes Craft através de registry, pairing com confirmação explícita, binding store persistente, router com filtros de protocolo e fanout. Workers de canal rodam como subprocessos isolados; credenciais de pareamento ficam em store seguro, nunca em logs.
## Requirements
### Requirement: Gateway exposes external channel registry
The system SHALL expose a workspace-scoped messaging registry for external channels, including WhatsApp and future channel adapters.

#### Scenario: Workspace reads registry config
- **WHEN** a client requests messaging config for a workspace
- **THEN** the system returns enabled platforms, runtime status, and configured channel entries for that workspace

#### Scenario: Future channel can be registered
- **WHEN** a new channel adapter implements the platform adapter contract
- **THEN** the gateway can register it without changing session routing semantics

### Requirement: Pairing requires explicit user confirmation
The system SHALL require an explicit user-confirmed pairing step before binding an external channel to a Craft session or agent.

#### Scenario: User generates pairing code from session
- **WHEN** the user requests pairing for a connected platform and session
- **THEN** the system generates a time-limited one-time code scoped to the workspace, platform, and session

#### Scenario: External channel redeems pairing code
- **WHEN** the external channel sends a valid `/pair <code>` command
- **THEN** the system binds that channel to the target session and consumes the code exactly once

#### Scenario: Invalid pairing code is rejected
- **WHEN** the external channel sends an expired, invalid, reused, or cross-workspace pairing code
- **THEN** the system does not create a binding

### Requirement: Binding store persists channel-session links
The system SHALL persist each external-channel-to-Craft-session binding in a workspace-owned binding store.

#### Scenario: Binding is created
- **WHEN** pairing, `/new`, or `/bind` creates a channel binding
- **THEN** the binding store records workspace id, session id, platform, channel id, optional channel name, enabled state, creation time, and normalized binding config

#### Scenario: Gateway restarts
- **WHEN** the gateway restarts for a workspace with an existing binding store
- **THEN** persisted bindings are loaded before routing inbound messages for that workspace

### Requirement: Router selects destination from protocol filters
The system SHALL route inbound messages to Craft sessions based on protocol-filtered channel identity, including sender, group or chat identity, and tag or prefix policy when the platform provides those signals.

#### Scenario: Filtered inbound message has binding
- **WHEN** an adapter emits an inbound message whose platform and channel id match an enabled binding
- **THEN** the router sends the message text and supported local attachments to the bound Craft session

#### Scenario: Filtered inbound message has no binding
- **WHEN** an adapter emits an inbound message with no enabled binding for its platform and channel id
- **THEN** the router delegates the message to the command handler instead of sending it to a session

### Requirement: Fanout delivers inbound session events to applicable bindings
The system SHALL fan out session events and rendered agent output to every applicable external channel binding.

#### Scenario: Session emits response event
- **WHEN** a Craft session emits an event for a session with one or more enabled messaging bindings
- **THEN** the gateway renders and delivers the appropriate message update to each applicable external channel

#### Scenario: One sink fails during fanout
- **WHEN** one event sink throws while handling a session event
- **THEN** other sinks still receive the event

### Requirement: WhatsApp worker runs as isolated subprocess
The system SHALL run the WhatsApp Baileys integration in an isolated subprocess owned by the WhatsApp adapter.

#### Scenario: WhatsApp connect starts
- **WHEN** a workspace starts the WhatsApp connect flow
- **THEN** the adapter spawns the configured worker entry as a child process and communicates with it through the worker protocol

#### Scenario: WhatsApp worker exits
- **WHEN** the WhatsApp worker exits or is destroyed
- **THEN** the adapter marks WhatsApp disconnected and resolves pending sends with failure instead of leaving callers waiting indefinitely

### Requirement: Protocol filter drops out-of-scope messages before router
The system SHALL discard out-of-scope platform messages in the channel-specific worker or adapter before they reach the router.

#### Scenario: WhatsApp self-chat mode filters non-self messages
- **WHEN** WhatsApp self-chat mode is enabled and an inbound message is not in the account self-chat
- **THEN** the worker skips the message and does not emit it to the router

#### Scenario: WhatsApp worker filters echoes
- **WHEN** WhatsApp receives an echo of a message sent by the worker or a message with the configured response prefix
- **THEN** the worker skips the message and does not emit it to the router

#### Scenario: WhatsApp worker filters history and empty messages
- **WHEN** WhatsApp receives old history-sync messages or messages with no supported visible text
- **THEN** the worker skips them before gateway routing

### Requirement: Pairing credentials stay out of logs
The system SHALL keep pairing credentials and channel secrets in secure or app-owned stores and MUST NOT write QR payloads, pairing tokens, bearer tokens, or auth secrets to normal logs.

#### Scenario: Telegram token is saved
- **WHEN** a Telegram token is saved for a workspace
- **THEN** the token is stored through the credential manager and not persisted in messaging config or binding files

#### Scenario: WhatsApp pairing credential is emitted
- **WHEN** the WhatsApp worker emits QR or pairing-code data
- **THEN** the gateway forwards it to the UI as a structured event while logs record only non-secret operational metadata

#### Scenario: WhatsApp auth state is persisted
- **WHEN** WhatsApp completes authentication
- **THEN** Baileys auth state is persisted under the workspace messaging auth directory and not copied into logs

### Requirement: Disconnect command removes binding cleanly
The system SHALL support a disconnect command that removes bindings cleanly without corrupting platform runtime state.

#### Scenario: Bound chat sends disconnect command
- **WHEN** a bound external chat sends `/unbind`
- **THEN** the system removes that chat binding and confirms the disconnect to the channel

#### Scenario: UI disconnects a platform
- **WHEN** the UI or RPC requests platform disconnect for a workspace
- **THEN** the gateway unregisters the adapter, updates platform config and runtime status, clears pending pairing codes, and preserves or forgets auth state according to the requested operation

### Requirement: Gateway supports chat commands
The system SHALL support chat commands for creating, binding, pairing, disconnecting, status, stopping, and help.

#### Scenario: Supported command is received
- **WHEN** an external channel sends `/new`, `/bind`, `/pair`, `/unbind`, `/status`, `/stop`, or `/help`
- **THEN** the gateway handles the command without forwarding the command text as a normal session message

#### Scenario: Unknown unbound message is received
- **WHEN** an unbound external channel sends a non-command message
- **THEN** the gateway responds with guidance for creating, binding, pairing, or requesting help

