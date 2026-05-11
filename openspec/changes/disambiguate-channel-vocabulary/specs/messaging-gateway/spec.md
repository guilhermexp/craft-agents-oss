## MODIFIED Requirements

### Requirement: Gateway exposes external messaging registry
The system SHALL expose a workspace-scoped messaging registry for external messaging chats or channels, including WhatsApp and future adapters, while distinguishing them from War Room channels and RPC namespaces.

#### Scenario: Workspace reads registry config
- **WHEN** a client requests messaging config for a workspace
- **THEN** the system returns enabled platforms, runtime status, and configured external messaging entries for that workspace

#### Scenario: Future adapter can be registered
- **WHEN** a new messaging adapter implements the platform adapter contract
- **THEN** the gateway can register it without changing session routing semantics or reusing War Room channel type names

### Requirement: Binding store persists external-message bindings
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
