# craft-bridge Specification

## Purpose
TBD - created by archiving change name-craft-bridge-capability. Update Purpose after archive.
## Requirements
### Requirement: Craft Bridge owns Craft product integration

The system SHALL expose a named `craft-bridge` capability as the owner for product-Craft integration through Craft MCP endpoints, including Craft-specific endpoint classification, auth adaptation, document context discovery, and session routing contracts.

#### Scenario: Craft MCP endpoint is classified

- **WHEN** a source endpoint uses the `https://mcp.craft.do/links/.../mcp` shape
- **THEN** the system classifies it as a Craft product bridge endpoint instead of treating the Craft-specific behavior as anonymous generic source logic

#### Scenario: Non-Craft MCP remains generic

- **WHEN** a source endpoint belongs to another MCP provider
- **THEN** the system keeps it in the generic source/MCP flow and MUST NOT route it through Craft Bridge behavior

### Requirement: Craft Bridge owns Craft MCP authentication adaptation

The system SHALL route Craft MCP authentication concerns through `craft-bridge` while preserving the generic MCP OAuth implementation for non-Craft providers.

#### Scenario: Craft MCP requires OAuth

- **WHEN** a Craft MCP source requires OAuth metadata discovery and token exchange
- **THEN** the system uses the generic OAuth primitives through a Craft Bridge adapter that records the source as Craft-owned

#### Scenario: Generic MCP OAuth still works

- **WHEN** a non-Craft MCP source requires OAuth
- **THEN** the system uses the existing generic MCP OAuth flow without depending on Craft Bridge state

### Requirement: Craft Agents documentation is separate from Craft user documents

The system MUST distinguish the public `craft-agents-docs` documentation MCP from user-owned documents exposed by Craft product MCP endpoints.

#### Scenario: Public docs MCP is registered

- **WHEN** the app registers `craft-agents-docs` as an always-available MCP server
- **THEN** the system treats it as Craft Agents product documentation and MUST NOT present it as a synced user document source

#### Scenario: User Craft document source is connected

- **WHEN** a user connects an authenticated Craft product MCP source
- **THEN** the system treats documents, blocks, collections, search and tasks exposed by that source as user-authorized Craft context

### Requirement: Craft document context is explicit

The system SHALL expose Craft document context to sessions only through explicit Craft Bridge contracts.

#### Scenario: Session requests Craft context

- **WHEN** a session enables a Craft product source
- **THEN** the system can provide authorized Craft document context through Craft Bridge without mixing it with unrelated Google Drive, filesystem, Slack, GitHub or meeting context

#### Scenario: Craft context is unavailable

- **WHEN** no authenticated Craft product source is available
- **THEN** the system MUST report that Craft document context is unavailable instead of falling back to branding, app docs, or unrelated workspace files

