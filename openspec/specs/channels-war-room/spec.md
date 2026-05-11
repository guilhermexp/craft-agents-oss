# channels-war-room Specification

## Purpose
Definir canais como salas compartilhadas multi-sessão (não meras labels) com membros, mensagens, mentions e quatro modos de roteamento (manual-tags, lead, all, orchestrator). O orquestrador despacha cada mensagem para a(s) sessão(ões) alvo conforme o modo, com inferência automática de lead Hermes quando ausente e leitura do Kanban Hermes para o modo orchestrator.
## Requirements
### Requirement: Channels are shared rooms
The system SHALL model War Room channels as shared rooms with members and messages, not merely as labels, RPC namespaces, source scopes, or external messaging chats.

#### Scenario: War Room channel stores members and messages
- **WHEN** a workspace has a War Room channel with configured participants and messages
- **THEN** the War Room channel exposes those participants and messages as the shared room state

#### Scenario: Agent sessions remain implementation details
- **WHEN** a War Room channel message is dispatched to an agent participant
- **THEN** the visible War Room channel history remains the shared surface and the backing agent session remains an implementation detail

### Requirement: Channel CRUD is available through RPC
The system SHALL expose basic War Room channel create, list, update, and delete operations through RPC namespaces dedicated to the War Room channel capability.

#### Scenario: Create and list War Room channel
- **WHEN** a client creates a War Room channel through the War Room RPC namespace and then lists War Room channels for the workspace
- **THEN** the created War Room channel appears in the returned War Room channel list

#### Scenario: Update War Room channel
- **WHEN** a client updates a War Room channel through the War Room RPC namespace
- **THEN** subsequent War Room channel reads return the updated War Room channel configuration

#### Scenario: Delete War Room channel
- **WHEN** a client deletes a War Room channel through the War Room RPC namespace
- **THEN** the War Room channel is removed from the workspace War Room channel list

### Requirement: Channel routing modes are defined
The system SHALL support exactly four routing modes for channel messages: `manual-tags`, `lead`, `all`, and `orchestrator`.

#### Scenario: manual-tags routes only mentioned participants
- **WHEN** a message is sent in `manual-tags` mode with participant mentions
- **THEN** only the mentioned participants are targeted

#### Scenario: manual-tags keeps unmentioned message in channel
- **WHEN** a message is sent in `manual-tags` mode without participant mentions
- **THEN** the message is stored in the channel and no agent participant is targeted

#### Scenario: lead routes untagged message to lead
- **WHEN** a message is sent in `lead` mode without participant mentions
- **THEN** the message is targeted to the resolved lead participant

#### Scenario: lead honors explicit mentions
- **WHEN** a message is sent in `lead` mode with participant mentions
- **THEN** the mentioned participants are targeted instead of the default lead target

#### Scenario: all routes untagged message to every participant
- **WHEN** a message is sent in `all` mode without participant mentions
- **THEN** every participant in the channel is targeted

#### Scenario: all supports all mention
- **WHEN** a message is sent in `all` mode with `@all`
- **THEN** all channel participants are targeted

#### Scenario: orchestrator routes through lead
- **WHEN** a message is sent in `orchestrator` mode
- **THEN** the message is targeted to the resolved lead or orchestrator participant

### Requirement: Lead routing infers Hermes lead
The system SHALL allow `lead` and `orchestrator` channels to work without `leadParticipantId` by inferring a lead participant.

#### Scenario: Explicit lead is used first
- **WHEN** `leadParticipantId` matches a channel participant
- **THEN** that participant is the resolved lead

#### Scenario: Hermes participant is inferred
- **WHEN** `leadParticipantId` is empty and the channel has a Hermes participant
- **THEN** the first Hermes participant is the resolved lead

#### Scenario: First participant is fallback lead
- **WHEN** `leadParticipantId` is empty and the channel has no Hermes participant
- **THEN** the first channel participant is the resolved lead

#### Scenario: No participants means no lead target
- **WHEN** `leadParticipantId` is empty and the channel has no participants
- **THEN** no lead target is selected

### Requirement: Channel mentions resolve participants
The system SHALL resolve mentions inside channel messages against participant names or handles before dispatch.

#### Scenario: Known participant mention resolves
- **WHEN** a channel message includes a mention matching a participant handle
- **THEN** the resolved mention includes that participant id

#### Scenario: Unknown mention is reported
- **WHEN** a channel message includes a mention that does not match a participant handle
- **THEN** the unresolved mention is returned as an unknown mention

#### Scenario: Explicit UI mentions override text parsing
- **WHEN** the client sends explicit mentioned participant ids with a message
- **THEN** those ids are used for mention resolution instead of reparsing the text

### Requirement: Orchestrator dispatches channel messages
The system SHALL dispatch channel messages to target sessions according to the channel routing mode and append agent replies back to the channel history.

#### Scenario: Dispatch creates or reuses target session
- **WHEN** a channel message targets a participant
- **THEN** the orchestrator creates or reuses one backing session for that channel participant

#### Scenario: Target receives channel context
- **WHEN** a channel message is dispatched to a participant session
- **THEN** the message packet includes channel identity, participant identity, the current user message, and recent channel context

#### Scenario: Agent reply is appended to channel
- **WHEN** a targeted participant session returns an assistant response
- **THEN** the response is appended as an agent-authored channel message with the participant id and source session id

### Requirement: Hermes Kanban reader exposes orchestrator state
The system SHALL expose Hermes Kanban task state to channels operating in `orchestrator` mode.

#### Scenario: Reader finds Kanban database
- **WHEN** the Hermes Kanban reader is invoked
- **THEN** it resolves the database from explicit Kanban env vars, app-scoped Hermes home, current board marker, or the default app-scoped board path

#### Scenario: Created tasks are filtered to channel assignees
- **WHEN** Kanban tasks are created during channel dispatch
- **THEN** only tasks assigned to expected Hermes channel assignees are watched for that channel

#### Scenario: Terminal task update returns to channel
- **WHEN** a watched Kanban task reaches `done`, `blocked`, or `archived`
- **THEN** a system update is appended to the channel and the orchestrator may summarize the result back into the channel

### Requirement: ChannelConversationPanel renders and sends channel messages
The system SHALL provide a channel conversation UI that renders channel history, shows members, and allows the user to send messages with mentions.

#### Scenario: Panel renders channel history
- **WHEN** a user opens a channel in `ChannelConversationPanel`
- **THEN** the panel loads and renders the channel message history

#### Scenario: Panel shows members
- **WHEN** a channel has configured participants
- **THEN** the panel shows participant handles for the channel

#### Scenario: Panel sends message with mentions
- **WHEN** a user sends a message containing participant mentions
- **THEN** the panel calls channels RPC to send the message and refreshes the channel history

#### Scenario: Panel surfaces dispatch feedback
- **WHEN** sending a channel message returns targeted participants, unknown mentions, or failures
- **THEN** the panel displays that dispatch feedback to the user

### Requirement: Channels RPC protocol is the source of truth
The system SHALL treat the shared RPC contracts as RPC namespaces and SHALL NOT call them channels in protocol-level names. War Room channel types SHALL use the `WarRoom` domain prefix to distinguish them from RPC namespaces, source channel scopes, and external messaging channels.

#### Scenario: Client and server use shared RPC namespace names
- **WHEN** the renderer or transport invokes a War Room channel operation
- **THEN** it uses the corresponding shared `RPC_NAMESPACES` value or equivalent namespace-named contract

#### Scenario: Server broadcasts War Room channel changes
- **WHEN** War Room channel configuration or messages change
- **THEN** the server broadcasts the corresponding shared RPC namespace event without exposing protocol namespaces as product channels

#### Scenario: War Room config type is imported
- **WHEN** code imports the shared type for a War Room channel
- **THEN** the imported type is named `WarRoomChannel` or a more specific `WarRoom*` type

#### Scenario: War Room ID crosses a module boundary
- **WHEN** a War Room channel id is passed across module, RPC, or persistence boundaries
- **THEN** the type identifies it as a War Room channel id rather than a generic string channel id

### Requirement: Channels use Craft context only through Craft Bridge

The system SHALL keep channels generic and require any Craft product document context used in channel routing to come through the `craft-bridge` capability.

#### Scenario: Channel dispatch uses Craft context

- **WHEN** a channel message is dispatched with Craft product document context
- **THEN** the dispatch context identifies that context as supplied by `craft-bridge` rather than by generic channel state

#### Scenario: Channel has no Craft source

- **WHEN** a channel has no enabled Craft product source or Craft Bridge context
- **THEN** the channel routing behavior remains the generic War Room behavior based on participants, mentions, routing mode and session context

