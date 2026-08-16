# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is a technical individual operating several AI agents, sessions, files, services, and automations from one desktop workspace. Technical teams are also supported through shared rooms, sessions, sources, and remote execution, but individual operator efficiency takes precedence when product decisions conflict.

## Product Purpose

Craft Agents is a desktop workspace for directing capable AI agents through conversational, document-centric workflows instead of relying on a terminal or code editor. It brings agent sessions, tools, connected services, files, meetings, channels, structured workspace objects, and long-running work into one operational surface.

Success means the operator can move between concurrent agent tasks, inspect and control what agents are doing, connect the context they need, and keep work running locally or remotely without assembling separate tools or configuration flows.

## Positioning

This fork is a personal, integrated agent workspace rather than a product organized around one commercial category. Its differentiator is the combination of Claude, Pi/Codex, and Hermes runtimes with shared desktop workflows while preserving the boundaries, state, and tool contracts of each backend.

## Operating Context

- Desktop work across many concurrent agent sessions and workspaces.
- Keyboard-oriented session navigation, status workflows, permissions, review, and interruption.
- Local files, repositories, documents, structured workspace objects, and external sources exposed through MCP or API integrations.
- Long-running work through automations, background tasks, meetings, and War Room channels.
- Optional thin-client operation against a remote Craft server while retaining the Electron app as the user interface.
- App-scoped local runtimes and state for embedded services such as Hermes.

## Capabilities and Constraints

- Supports Claude and Pi as native agent runtimes and Hermes as an isolated Python/ACP backend.
- Provides multi-session inbox and archive workflows, status and flagging, streaming agent output, tool visualization, diffs, permissions, skills, sources, attachments, automations, meetings, channels, browser panes, and structured workspace objects.
- Connects to MCP servers, REST APIs, local filesystems, Craft documents, and remote Craft servers.
- Supports English, German, Spanish, Hungarian, Japanese, Polish, Brazilian Portuguese, and Simplified Chinese UI resources.
- Must keep credentials, user data, agent state, and embedded runtime state local or app-scoped whenever possible; public envelopes, manifests, health data, and logs must not leak secrets.
- Must preserve backend isolation rather than sharing fallback logic, credentials, state, or tool shortcuts across Claude, Pi/Codex, and Hermes.
- Must remain a dense, fluid desktop application optimized for frequent operation rather than becoming a generic web dashboard.
- Must remain extensible through skills, sources, MCP servers, APIs, automations, and source modification.

## Brand Commitments

- Product name: Craft Agents.
- Open source under Apache-2.0.
- Agent-native, highly customizable, direct, and low-friction.
- Desktop interactions should remain compact, responsive, and keyboard-friendly.
- Preserve the existing Craft identity and product terminology unless a separate redesign or rebrand is explicitly approved.

## Evidence on Hand

- `README.md` documents the product purpose, installation, workflows, feature set, screenshots, demo video, and remote-server model.
- `apps/electron/src/renderer/` contains the incumbent application shell, chat, meetings, browser, workspace objects, settings, sources, automations, and responsive/mobile menu implementations.
- `packages/shared/src/i18n/locales/` contains the eight supported locale resources.
- `apps/electron/docs/hermes-embed.md` and `apps/electron/docs/channels-war-room.md` document the embedded Hermes and War Room contracts.
- `AGENTS.md` records load-bearing product and runtime invariants for Hermes, meetings, browser panes, cookie import, structured workspace objects, and local-only security boundaries.
- No independent customer claims, testimonials, benchmark results, pricing claims, or formal accessibility certification are established; future design work must not fabricate them.

## Product Principles

1. Optimize first for one technical operator coordinating substantial parallel work.
2. Make powerful agent behavior visible, controllable, and interruptible from one desktop workspace.
3. Keep local data and credentials scoped to the user, workspace, session, and runtime that owns them.
4. Add integrations through shared, explicit contracts instead of backend-specific shortcuts.
5. Prefer direct, compact workflows over setup ceremonies, duplicated surfaces, or generic dashboard patterns.
