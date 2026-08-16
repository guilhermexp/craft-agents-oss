# Craft Agent Workspace

Craft coordinates agent sessions, workspace-local data, browser profiles and external sources while keeping runtime-specific behavior isolated behind explicit seams.

## Language

**Source readiness**:
The verified state that a configured source exposes every expected tool at the exact compatible version to the active agent session. Readiness evidence is allowlisted and durable; any unconfirmed transition is unhealthy.
_Avoid_: Source test, connection test

**Workspace object**:
A structured workspace-local object whose canonical state is committed before any repairable file projection or event delivery.
_Avoid_: Database view, sidebar item

**Content tab**:
A deterministic right-sidebar target for a workspace file, workspace object view, or live browser instance. Its identity and persistence scope are part of the tab, while live browser handles are never persisted.
_Avoid_: Preview panel, content pane

**User-only browser profile**:
A browser profile whose cookie jar and authenticated state are available only to direct user interactions and never to agent-controlled browser instances.
_Avoid_: Private profile, secure profile

**Cookie import**:
A point-in-time user action that copies eligible Chrome cookies into a user-only browser profile without exposing cookie values or host details in results.
_Avoid_: Cookie sync, agent cookie import
