# messaging-gateway Specification

## Purpose
Conectar canais de mensageria externos (WhatsApp via Baileys, e futuros) a sessões e agentes Craft através de registry, pairing com confirmação explícita, binding store persistente, router com filtros de protocolo e fanout. Workers de canal rodam como subprocessos isolados; credenciais de pareamento ficam em store seguro, nunca em logs.
## Requirements
### Requirement: Gateway exposes external channel registry
The system SHALL expose a workspace-scoped messaging registry for external messaging chats or channels, including WhatsApp and future adapters, while distinguishing them from War Room channels and RPC namespaces.

#### Scenario: Workspace reads registry config
- **WHEN** a client requests messaging config for a workspace
- **THEN** the system returns enabled platforms, runtime status, and configured external messaging entries for that workspace

#### Scenario: Future adapter can be registered
- **WHEN** a new messaging adapter implements the platform adapter contract
- **THEN** the gateway can register it without changing session routing semantics or reusing War Room channel type names

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
The system SHALL persist each external-messaging-to-Craft-session binding in a workspace-owned binding store with domain-prefixed names for binding types and ids.

#### Scenario: Binding is created
- **WHEN** pairing, `/new`, or `/bind` creates an external messaging binding
- **THEN** the binding store records workspace id, session id, platform, external messaging channel or chat id, optional display name, enabled state, creation time, and normalized binding config

#### Scenario: Gateway restarts
- **WHEN** the gateway restarts for a workspace with an existing binding store
- **THEN** persisted external messaging bindings are loaded before routing inbound messages for that workspace

### Requirement: Router selects destination from protocol filters
The system SHALL route inbound messages to Craft sessions based on protocol-filtered external messaging identity, including sender, group or chat identity, and tag or prefix policy when the platform provides those signals.

#### Scenario: Filtered inbound message has binding
- **WHEN** an adapter emits an inbound message whose platform and external messaging channel id match an enabled binding
- **THEN** the router sends the message text and supported local attachments to the bound Craft session

#### Scenario: Filtered inbound message has no binding
- **WHEN** an adapter emits an inbound message with no enabled binding for its platform and external messaging channel id
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

### Requirement: Gateway owns internal message adapter registry
The system SHALL own discovery, registration, lifecycle dispatch, and runtime visibility for messaging channel adapters through an internal `MessageAdapterRegistry` in `messaging-gateway`.

#### Scenario: Workspace starts configured adapters
- **WHEN** messaging is enabled for a workspace with configured platforms
- **THEN** the registry constructs and initializes the matching adapters from gateway-owned factories
- **AND** each initialized adapter is registered with the workspace `MessagingGateway`

#### Scenario: Adapter lifecycle is dispatched centrally
- **WHEN** a platform is connected, disconnected, replaced, or forgotten
- **THEN** the registry performs adapter initialize, unregister, and destroy through one gateway-owned lifecycle path
- **AND** the caller does not import or instantiate channel packages directly

#### Scenario: Adapter capabilities remain discoverable
- **WHEN** a client or gateway component needs platform runtime or capabilities
- **THEN** the registry exposes the information per platform without requiring knowledge of adapter file paths or worker protocol details

### Requirement: Gateway stores channel adapters under internal adapter directories
The system SHALL keep messaging channel adapter implementations inside `packages/messaging-gateway/src/adapters/<channel>/`.

#### Scenario: WhatsApp adapter is folded into gateway
- **WHEN** the WhatsApp Baileys integration is present
- **THEN** its adapter, worker entrypoint, worker protocol, and protocol filters live under `packages/messaging-gateway/src/adapters/whatsapp/`
- **AND** `messaging-gateway` does not depend on a separate `@craft-agent/messaging-whatsapp-worker` package

#### Scenario: Channel needs subprocess isolation
- **WHEN** a channel adapter requires subprocess isolation for runtime stability or dependency constraints
- **THEN** the subprocess worker remains an internal adapter implementation detail under that channel directory
- **AND** the channel still registers through the gateway `MessageAdapterRegistry`

#### Scenario: Future channel is added
- **WHEN** Telegram, Slack, WhatsApp, or another channel adapter is added or changed
- **THEN** its channel-specific implementation lives under `src/adapters/<channel>/`
- **AND** shared routing continues through the gateway registry and router instead of a per-adapter workspace package boundary

### Requirement: Messaging IDs are domain-typed
The system SHALL type external messaging channel or chat identifiers separately from War Room channel ids and RPC namespaces.

#### Scenario: Gateway binding stores external channel id
- **WHEN** a binding stores the platform destination id
- **THEN** the field uses a messaging-specific id type or name such as `MessagingChannelId`, `MessagingChatId`, or a platform-specific equivalent

#### Scenario: WhatsApp worker sends command
- **WHEN** the WhatsApp worker protocol sends or receives a WhatsApp destination id
- **THEN** the field name and type identify it as a WhatsApp channel or chat id rather than a generic Craft channel id

### Requirement: Approval surface is not named channel
The system SHALL name the approval location as a surface or mode, not as a channel.

#### Scenario: Binding config selects approval location
- **WHEN** a binding config chooses whether approval happens in chat or in app
- **THEN** the field uses a name such as `approvalSurface` and does not overload channel vocabulary

