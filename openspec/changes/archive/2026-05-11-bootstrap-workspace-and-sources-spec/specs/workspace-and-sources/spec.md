## ADDED Requirements

### Requirement: Workspace abstraction
The system SHALL treat a workspace as the primary work area abstraction, backed by either a local user filesystem folder or a remote Craft server workspace, and each workspace MUST have its own configuration.

#### Scenario: Local workspace is loaded
- **WHEN** a local workspace is selected
- **THEN** the system loads sessions, sources, skills, defaults and workspace settings from that workspace configuration and root path

#### Scenario: Remote workspace is loaded
- **WHEN** a remote workspace is selected
- **THEN** the system uses the remote server connection associated with that workspace while preserving workspace-scoped configuration semantics

### Requirement: Remote workspace connection
The system SHALL require `CRAFT_SERVER_URL` and `CRAFT_SERVER_TOKEN` equivalents to connect to a remote workspace, and the remote workspace mapping MUST include the remote workspace identifier.

#### Scenario: Remote connection is tested
- **WHEN** the user enters a remote server URL and token
- **THEN** the system tests the server connection before allowing the user to select or create a remote workspace

#### Scenario: Remote workspace mapping is saved
- **WHEN** a remote workspace connection succeeds
- **THEN** the system stores the server URL, token and remote workspace identifier in the local workspace remote connection metadata

### Requirement: Source type discrimination
The system SHALL require every source to declare exactly one discriminated type: `mcp`, `api` or `filesystem`.

#### Scenario: MCP source config is provided
- **WHEN** a source declares type `mcp`
- **THEN** the source MUST include MCP transport configuration for HTTP/SSE or stdio

#### Scenario: API source config is provided
- **WHEN** a source declares type `api`
- **THEN** the source MUST include API configuration such as base URL, auth type and optional test endpoint

#### Scenario: Filesystem source config is provided
- **WHEN** a source declares type `filesystem`
- **THEN** the source MUST include a filesystem path scoped by the workspace boundary

### Requirement: Source connection test before persistence
The system SHALL run the source `test` operation before persisting a newly created source as available.

#### Scenario: Source test succeeds
- **WHEN** a new source passes its connection test
- **THEN** the system persists the source and records it as connected with a last-tested timestamp

#### Scenario: Source test fails
- **WHEN** a new source fails its connection test
- **THEN** the system MUST NOT persist it as an available source and MUST return the validation error to the caller

### Requirement: OAuth credential storage
The system SHALL store OAuth tokens and equivalent source credentials in a secure credential store, not in workspace or source config files.

#### Scenario: OAuth completes
- **WHEN** OAuth authentication completes for a source provider
- **THEN** the system stores the resulting tokens in the secure credential store keyed by workspace and source

#### Scenario: Workspace config is inspected
- **WHEN** a workspace or source config file is read from disk
- **THEN** OAuth access tokens, refresh tokens and API secrets MUST NOT be present in that config file

### Requirement: Workspace picker UI
The system SHALL provide a workspace picker UI that lists local and remote workspaces and allows users to create new local or remote workspaces.

#### Scenario: Existing workspaces are shown
- **WHEN** the workspace picker opens
- **THEN** the user can select an existing local or remote workspace

#### Scenario: New workspace is created
- **WHEN** the user chooses to create a workspace
- **THEN** the UI allows creating a local workspace or connecting to a remote server and creating/selecting a remote workspace

### Requirement: MCP source process lifecycle
The system SHALL spawn MCP sources configured with stdio transport as subprocesses managed by the active session lifecycle.

#### Scenario: Stdio MCP source is enabled
- **WHEN** a session enables a stdio MCP source
- **THEN** the system spawns the configured command as a managed subprocess for that session

#### Scenario: Session no longer uses the MCP source
- **WHEN** the session disables or disconnects the stdio MCP source
- **THEN** the system closes the corresponding MCP client and terminates the managed subprocess

### Requirement: Filesystem source boundary
The system SHALL enforce the workspace boundary for filesystem sources and MUST reject path traversal or escaped paths such as `..`.

#### Scenario: Filesystem path stays inside workspace
- **WHEN** a filesystem source accesses a path that resolves inside the workspace boundary
- **THEN** the system allows the access subject to permissions

#### Scenario: Filesystem path escapes workspace
- **WHEN** a filesystem source path resolves outside the workspace boundary or contains traversal
- **THEN** the system rejects the access before reading or writing data
