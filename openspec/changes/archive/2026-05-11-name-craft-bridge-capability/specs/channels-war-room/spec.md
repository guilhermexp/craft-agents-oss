## ADDED Requirements

### Requirement: Channels use Craft context only through Craft Bridge

The system SHALL keep channels generic and require any Craft product document context used in channel routing to come through the `craft-bridge` capability.

#### Scenario: Channel dispatch uses Craft context

- **WHEN** a channel message is dispatched with Craft product document context
- **THEN** the dispatch context identifies that context as supplied by `craft-bridge` rather than by generic channel state

#### Scenario: Channel has no Craft source

- **WHEN** a channel has no enabled Craft product source or Craft Bridge context
- **THEN** the channel routing behavior remains the generic War Room behavior based on participants, mentions, routing mode and session context
