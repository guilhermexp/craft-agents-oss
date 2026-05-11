## ADDED Requirements

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
