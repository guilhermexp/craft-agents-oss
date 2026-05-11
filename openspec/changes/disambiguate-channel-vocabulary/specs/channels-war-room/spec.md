## MODIFIED Requirements

### Requirement: War Room channels are shared rooms
The system SHALL model War Room channels as shared rooms with members and messages, not merely as labels, RPC namespaces, source scopes, or external messaging chats.

#### Scenario: War Room channel stores members and messages
- **WHEN** a workspace has a War Room channel with configured participants and messages
- **THEN** the War Room channel exposes those participants and messages as the shared room state

#### Scenario: Agent sessions remain implementation details
- **WHEN** a War Room channel message is dispatched to an agent participant
- **THEN** the visible War Room channel history remains the shared surface and the backing agent session remains an implementation detail

### Requirement: War Room channel CRUD is available through RPC
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

### Requirement: War Room type names are domain-prefixed
The system SHALL name War Room channel types with the `WarRoom` domain prefix and SHALL NOT expose generic `ChannelConfig`, `ChannelParticipant`, or `ChannelRoutingConfig` names for this capability.

#### Scenario: War Room config type is imported
- **WHEN** code imports the shared type for a War Room channel
- **THEN** the imported type is named `WarRoomChannel` or a more specific `WarRoom*` type

#### Scenario: War Room ID crosses a module boundary
- **WHEN** a War Room channel id is passed across module, RPC, or persistence boundaries
- **THEN** the type identifies it as a War Room channel id rather than a generic string channel id

### Requirement: War Room RPC protocol uses namespace vocabulary
The system SHALL treat the shared RPC constants as RPC namespaces and SHALL NOT call them channels in protocol-level names.

#### Scenario: Client and server use shared RPC namespace names
- **WHEN** the renderer or transport invokes a War Room channel operation
- **THEN** it uses the corresponding shared `RPC_NAMESPACES` value or equivalent namespace-named contract

#### Scenario: Server broadcasts War Room channel changes
- **WHEN** War Room channel configuration or messages change
- **THEN** the server broadcasts the corresponding shared RPC namespace event without exposing protocol namespaces as product channels
