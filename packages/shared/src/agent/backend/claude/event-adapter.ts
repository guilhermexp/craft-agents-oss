/**
 * Claude Event Adapter
 *
 * Maps Claude SDK messages (SDKMessage) to Craft Agent's AgentEvent format.
 * Extracted from ClaudeAgent.convertSDKMessage() for testability and to share
 * lifecycle scaffolding with PiEventAdapter via BaseEventAdapter.
 *
 * Key Claude-specific behavior:
 * - Uses extractToolStarts/extractToolResults from tool-matching.ts (stateless, ID-based)
 * - Handles stream_event for real-time text deltas and tool start detection
 * - Manages pendingText for deferred text_complete (waits for stop_reason from message_delta)
 * - Tracks usage per-message (not cumulative) for accurate context window display
 */

import type { SDKMessage, SDKAssistantMessage, SDKAssistantMessageError } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@craft-agent/core/types';
import type { AgentError } from '../../errors.ts';
import { BaseEventAdapter } from '../base-event-adapter.ts';
import { ToolIndex, extractToolStarts, extractToolResults, isParentTaskTool, type ContentBlock } from '../../tool-matching.ts';

/**
 * Callbacks injected by ClaudeAgent for operations that depend on agent state.
 */
export interface ClaudeAdapterCallbacks {
  /** Debug logger — wired to ClaudeAgent.onDebug */
  onDebug?: (msg: string) => void;
  /** Maps SDK error codes to typed AgentErrors (depends on debug log parsing) */
  mapSDKError: (errorCode: SDKAssistantMessageError) => Promise<{ type: 'typed_error'; error: AgentError }>;
  /** Session directory for tool metadata (prevents cross-session race condition) */
  sessionDir?: string;
  /**
   * Reads the live context window from the SDK (`Query.getContextUsage().maxTokens`).
   * Resolves null when no query is live or the control request fails.
   */
  readContextWindow?: () => Promise<number | null>;
}

/**
 * Pure function: build a typed_error event for Windows SDK setup issues.
 * Returns null if the error doesn't match the pattern.
 */
export function buildWindowsSkillsDirError(errorText: string): { type: 'typed_error'; error: AgentError } | null {
  if (!errorText.includes('ENOENT') || !errorText.includes('skills')) {
    return null;
  }

  const pathMatch = errorText.match(/scandir\s+'([^']+)'/);
  const missingPath = pathMatch?.[1] || 'C:\\ProgramData\\ClaudeCode\\.claude\\skills';

  return {
    type: 'typed_error',
    error: {
      code: 'unknown_error',
      title: 'Windows Setup Required',
      message: `The SDK requires a directory that doesn't exist: ${missingPath} — Create this folder in File Explorer, then restart the app.`,
      details: [
        `PowerShell (run as Administrator):`,
        `New-Item -ItemType Directory -Force -Path "${missingPath}"`,
      ],
      actions: [],
      canRetry: true,
      originalError: errorText,
    },
  };
}

/** `claude-opus-5[1m]` and `claude-opus-5` are the same model to the usage map. */
const LONG_CONTEXT_SUFFIX = /\[1m\]$/;

/**
 * Pick the main loop model's context window out of `result.modelUsage`.
 *
 * The map is keyed by model and accumulates the CLI's *own* helper calls, not just
 * the session's model: a `claude-haiku-*` entry (200k) is routinely inserted before
 * the main model's, so reading the map positionally reported a 200k window for a 1M
 * Opus session and pinned the context badge at its clamp. Keys keep the `[1m]`
 * suffix that assistant messages drop, so the match is suffix-insensitive.
 */
function selectModelContextWindow(
  modelUsage: Record<string, { contextWindow?: number } | undefined> | undefined,
  mainModel: string | null,
): number | undefined {
  const entries = Object.entries(modelUsage ?? {});
  if (mainModel) {
    const target = mainModel.trim().toLowerCase().replace(LONG_CONTEXT_SUFFIX, '');
    for (const [model, usage] of entries) {
      if (usage?.contextWindow && model.trim().toLowerCase().replace(LONG_CONTEXT_SUFFIX, '') === target) {
        return usage.contextWindow;
      }
    }
  }
  // No model match (aliases, provider-prefixed ids). The main loop model always has
  // the widest window of the models in play, because helper calls run on Haiku.
  let widest: number | undefined;
  for (const [, usage] of entries) {
    if (usage?.contextWindow && (widest === undefined || usage.contextWindow > widest)) {
      widest = usage.contextWindow;
    }
  }
  return widest;
}

/**
 * Per-message usage snapshot for accurate context window display.
 * result.modelUsage is cumulative; we need per-message granularity.
 */
interface AssistantUsage {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/**
 * Shape of the SDK's `task_notification` system message.
 * The SDK doesn't export a type for this, so we define it locally
 * and validate fields before use to catch silent breakage.
 */
interface TaskNotificationMessage {
  type: 'system';
  subtype: 'task_notification';
  task_id: string;
  status?: string;
  output_file?: string;
  summary?: string;
  session_id?: string;
}

/** Valid terminal statuses for background tasks */
const VALID_TASK_STATUSES = ['completed', 'failed', 'stopped'] as const;
type TaskStatus = typeof VALID_TASK_STATUSES[number];

export class ClaudeEventAdapter extends BaseEventAdapter {
  // Per-turn state (reset on each startTurn)
  private toolIndex = new ToolIndex();
  private emittedToolStarts = new Set<string>();
  private activeParentTools = new Set<string>();
  private pendingText: string | null = null;

  // Session-persistent state (survives across turns)
  private lastAssistantUsage: AssistantUsage | null = null;
  /** Model of the last non-sidechain assistant message — keys the modelUsage lookup. */
  private lastAssistantModel: string | null = null;
  /** Last known context window from either SDK source; kept across turns so the UI never blanks. */
  private cachedContextWindow?: number;
  /**
   * Window this turn's `getContextUsage()` reported, if it answered.
   *
   * Authoritative over `result.modelUsage`: the two mean different things once a
   * compaction budget is configured. `getContextUsage()` reports the window the CLI
   * actually budgets against (733k with `autoCompactWindow` set), while `modelUsage`
   * keeps reporting the model's raw capacity (1M). The budget is what the user gets
   * compacted against, so it wins; `modelUsage` only fills in when the read failed.
   */
  private sdkContextWindow?: number;
  /** In-flight `getContextUsage()` read for the current turn, or null when none was started. */
  private contextWindowRead: Promise<void> | null = null;
  private _sdkTools: string[] = [];

  private callbacks: ClaudeAdapterCallbacks;

  constructor(callbacks: ClaudeAdapterCallbacks) {
    super('claude-adapter');
    this.callbacks = callbacks;
  }

  // ============================================================
  // Turn Lifecycle
  // ============================================================

  protected onTurnStart(): void {
    this.toolIndex = new ToolIndex();
    this.emittedToolStarts = new Set();
    this.activeParentTools = new Set();
    this.pendingText = null;
    this.lastAssistantUsage = null;
    // Re-read the window once per turn: the model (and with it the window) can
    // change between turns via /model or a connection switch.
    this.contextWindowRead = null;
    this.sdkContextWindow = undefined;
  }

  // ============================================================
  // Public API
  // ============================================================

  /**
   * Convert an SDK message to AgentEvents.
   * Main entry point called from ClaudeAgent's for-await loop.
   */
  async adapt(message: SDKMessage): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];

    // Debug: log non-streaming SDK message types (stream_event is too frequent)
    if (this.callbacks.onDebug && message.type !== 'stream_event') {
      const msgInfo = message.type === 'user' && 'tool_use_result' in message
        ? `user (tool_result for ${(message as any).parent_tool_use_id})`
        : message.type;
      this.callbacks.onDebug(`SDK message: ${msgInfo}`);
    }

    // rate_limit_event is an informational SDK message (carries rate-limit
    // headers). We don't surface it as an AgentEvent, but handle it explicitly so
    // it doesn't fall through to the "Unhandled SDK message type" debug log.
    if ((message as { type?: string }).type === 'rate_limit_event') {
      return events;
    }

    switch (message.type) {
      case 'assistant':
        await this.adaptAssistant(message, events);
        break;

      case 'stream_event':
        this.adaptStreamEvent(message, events);
        break;

      case 'user':
        this.adaptUser(message, events);
        break;

      case 'tool_progress':
        this.adaptToolProgress(message, events);
        break;

      case 'result':
        await this.adaptResult(message, events);
        break;

      case 'system':
        this.adaptSystem(message, events);
        break;

      case 'auth_status':
        this.adaptAuthStatus(message, events);
        break;

      default:
        if (this.callbacks.onDebug) {
          this.callbacks.onDebug(`Unhandled SDK message type: ${(message as any).type}`);
        }
        break;
    }

    return events;
  }

  /**
   * Flush any pending text that hasn't been emitted.
   * Called after the for-await loop exits to handle edge cases
   * (e.g., SDK sends assistant message with text but skips message_delta).
   */
  flushPending(): AgentEvent | null {
    if (this.pendingText) {
      const event: AgentEvent = {
        type: 'text_complete',
        text: this.pendingText,
        isIntermediate: false,
        turnId: this.currentTurnId || undefined,
      };
      this.pendingText = null;
      return event;
    }
    return null;
  }

  /**
   * Get SDK tools captured from init message.
   */
  get sdkTools(): string[] {
    return this._sdkTools;
  }

  /**
   * Get the tool index (for agent-level operations like inactive source detection).
   */
  getToolIndex(): ToolIndex {
    return this.toolIndex;
  }

  /**
   * Get the set of active parent tools (exposed for source activation detection).
   */
  getActiveParentTools(): Set<string> {
    return this.activeParentTools;
  }

  /**
   * Update the session directory for tool metadata lookups.
   */
  updateSessionDir(sessionDir: string): void {
    this.callbacks.sessionDir = sessionDir;
  }

  /**
   * Start this turn's authoritative context-window read, at most once per turn.
   *
   * `result.modelUsage` only lands at turn end, and a local model registry cannot
   * know about 1M-credit downgrades or an `autoCompactWindow` override, so the SDK
   * control request is the only source that is correct while the turn is running.
   * Deliberately not awaited by the caller: a control response can queue behind an
   * in-flight API call, and stalling the message loop would stall text deltas.
   */
  private ensureContextWindowRead(): void {
    const read = this.callbacks.readContextWindow;
    if (this.contextWindowRead || !read) return;
    this.contextWindowRead = read()
      .then((contextWindow) => {
        if (contextWindow && contextWindow > 0) {
          this.sdkContextWindow = contextWindow;
          this.cachedContextWindow = contextWindow;
        }
      })
      .catch((error: unknown) => {
        this.callbacks.onDebug?.(
          `getContextUsage failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  // ============================================================
  // Per-message-type Handlers
  // ============================================================

  private async adaptAssistant(message: SDKMessage, events: AgentEvent[]): Promise<void> {
    // Check for SDK-level errors FIRST (auth, network, rate limits, etc.)
    if ('error' in message && message.error) {
      const errorEvent = await this.callbacks.mapSDKError(
        message.error as SDKAssistantMessageError,
      );
      events.push(errorEvent);
      return;
    }

    // Skip replayed messages when resuming a session
    if ('isReplay' in message && message.isReplay) {
      return;
    }

    // Track usage from non-sidechain assistant messages
    const assistant = message as SDKAssistantMessage;
    const isSidechain = assistant.parent_tool_use_id !== null;
    if (!isSidechain && assistant.message?.usage) {
      const usage = assistant.message.usage;
      this.lastAssistantModel = assistant.message.model || this.lastAssistantModel;
      this.lastAssistantUsage = {
        input_tokens: usage.input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      };
      this.ensureContextWindowRead();

      const currentInputTokens =
        this.lastAssistantUsage.input_tokens +
        this.lastAssistantUsage.cache_read_input_tokens +
        this.lastAssistantUsage.cache_creation_input_tokens;

      events.push({
        type: 'usage_update',
        usage: {
          inputTokens: currentInputTokens,
          contextWindow: this.cachedContextWindow,
        },
      });
    }

    // Full assistant message with content blocks
    const content = (message as any).message?.content ?? [];

    // Extract text from content blocks
    let textContent = '';
    for (const block of content) {
      if (block.type === 'text') {
        textContent += block.text;
      }
    }

    // Stateless tool start extraction
    const sdkParentId = (message as any).parent_tool_use_id;
    const toolStartEvents = extractToolStarts(
      content as ContentBlock[],
      sdkParentId,
      this.toolIndex,
      this.emittedToolStarts,
      this.currentTurnId || undefined,
      this.activeParentTools,
      this.callbacks.sessionDir,
    );

    // Track active Task tools for fallback parent assignment
    for (const event of toolStartEvents) {
      if (event.type === 'tool_start' && isParentTaskTool(event.toolName)) {
        this.activeParentTools.add(event.toolUseId);
      }
    }

    events.push(...toolStartEvents);

    if (textContent) {
      // Don't emit text_complete yet — wait for message_delta to get stop_reason
      this.pendingText = textContent;
    }
  }

  private adaptStreamEvent(message: SDKMessage, events: AgentEvent[]): void {
    const event = (message as any).event;

    // Debug: log key stream events only (skip per-chunk deltas and frequent pings)
    if (this.callbacks.onDebug && (event.type === 'message_start' || event.type === 'message_stop')) {
      this.callbacks.onDebug(
        `stream_event: ${event.type}`,
      );
    }

    // Capture turn ID from message_start
    if (event.type === 'message_start') {
      const messageId = event.message?.id;
      if (messageId) {
        this.currentTurnId = messageId;
      }
    }

    // message_delta contains the actual stop_reason — emit pending text now
    if (event.type === 'message_delta') {
      const stopReason = event.delta?.stop_reason;
      if (this.pendingText) {
        const isIntermediate = stopReason === 'tool_use';
        events.push({
          type: 'text_complete',
          text: this.pendingText,
          isIntermediate,
          turnId: this.currentTurnId || undefined,
          parentToolUseId: (message as any).parent_tool_use_id || undefined,
        });
        this.pendingText = null;
      }
    }

    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      events.push({
        type: 'text_delta',
        text: event.delta.text,
        turnId: this.currentTurnId || undefined,
        parentToolUseId: (message as any).parent_tool_use_id || undefined,
      });
    } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
      // Stream events arrive with empty input — the full input comes later
      const toolBlock = event.content_block;
      const sdkParentId = (message as any).parent_tool_use_id;
      const streamBlocks: ContentBlock[] = [{
        type: 'tool_use' as const,
        id: toolBlock.id,
        name: toolBlock.name,
        input: (toolBlock.input ?? {}) as Record<string, unknown>,
      }];
      const streamEvents = extractToolStarts(
        streamBlocks,
        sdkParentId,
        this.toolIndex,
        this.emittedToolStarts,
        this.currentTurnId || undefined,
        this.activeParentTools,
        this.callbacks.sessionDir,
      );

      // Track active Task/Agent tools for fallback parent assignment
      for (const evt of streamEvents) {
        if (evt.type === 'tool_start' && isParentTaskTool(evt.toolName)) {
          this.activeParentTools.add(evt.toolUseId);
        }
      }

      events.push(...streamEvents);
    }
  }

  private adaptUser(message: SDKMessage, events: AgentEvent[]): void {
    // Skip replayed messages when resuming
    if ('isReplay' in message && message.isReplay) {
      return;
    }

    // Tool result matching
    if ((message as any).tool_use_result !== undefined || ('message' in message && (message as any).message)) {
      const msgContent = ('message' in message && (message as any).message)
        ? (((message as any).message as { content?: unknown[] }).content ?? [])
        : [];
      const contentBlocks = (Array.isArray(msgContent) ? msgContent : []) as ContentBlock[];

      const sdkParentId = (message as any).parent_tool_use_id;
      const toolUseResultValue = (message as any).tool_use_result;

      const resultEvents = extractToolResults(
        contentBlocks,
        sdkParentId,
        toolUseResultValue,
        this.toolIndex,
        this.currentTurnId || undefined,
      );

      // Remove completed Task/Agent tools from activeParentTools
      for (const event of resultEvents) {
        if (event.type === 'tool_result' && isParentTaskTool(event.toolName ?? '')) {
          this.activeParentTools.delete(event.toolUseId);
        }
      }

      events.push(...resultEvents);
    }
  }

  private adaptToolProgress(message: SDKMessage, events: AgentEvent[]): void {
    const progress = message as unknown as {
      tool_use_id: string;
      tool_name: string;
      parent_tool_use_id: string | null;
      elapsed_time_seconds?: number;
    };

    // Forward elapsed time for live progress updates
    if (progress.elapsed_time_seconds !== undefined) {
      events.push({
        type: 'task_progress',
        toolUseId: progress.parent_tool_use_id || progress.tool_use_id,
        elapsedSeconds: progress.elapsed_time_seconds,
        turnId: this.currentTurnId || undefined,
      });
    }

    // Emit tool_start for tools discovered through progress events
    if (!this.emittedToolStarts.has(progress.tool_use_id)) {
      const progressBlocks: ContentBlock[] = [{
        type: 'tool_use' as const,
        id: progress.tool_use_id,
        name: progress.tool_name,
        input: {},
      }];
      const progressEvents = extractToolStarts(
        progressBlocks,
        progress.parent_tool_use_id,
        this.toolIndex,
        this.emittedToolStarts,
        this.currentTurnId || undefined,
        this.activeParentTools,
        this.callbacks.sessionDir,
      );

      // Track active Task/Agent tools discovered via progress events
      for (const evt of progressEvents) {
        if (evt.type === 'tool_start' && isParentTaskTool(evt.toolName)) {
          this.activeParentTools.add(evt.toolUseId);
        }
      }

      events.push(...progressEvents);
    }
  }

  private async adaptResult(message: SDKMessage, events: AgentEvent[]): Promise<void> {
    const msg = message as any;

    // Debug logging
    console.error(
      `[ClaudeAdapter] result message: subtype=${msg.subtype}, errors=${'errors' in msg ? JSON.stringify(msg.errors) : 'none'}`,
    );

    // The turn's `getContextUsage()` read was started on the first assistant message,
    // so this only orders the write ahead of the `complete` event that gets persisted.
    if (this.contextWindowRead) {
      await this.contextWindowRead;
    }

    // Fallback only. `modelUsage` reports the model's raw capacity, which is not the
    // budget once `autoCompactWindow` is configured (1M model → 733k budget), so it
    // must not overwrite a window the control request already gave us this turn.
    if (this.sdkContextWindow === undefined) {
      const reportedWindow = selectModelContextWindow(msg.modelUsage, this.lastAssistantModel);
      if (reportedWindow) {
        this.cachedContextWindow = reportedWindow;
      }
    }

    // Use lastAssistantUsage for per-message context display (not cumulative)
    let inputTokens: number;
    let cacheRead: number;
    let cacheCreation: number;

    if (this.lastAssistantUsage) {
      inputTokens = this.lastAssistantUsage.input_tokens +
                    this.lastAssistantUsage.cache_read_input_tokens +
                    this.lastAssistantUsage.cache_creation_input_tokens;
      cacheRead = this.lastAssistantUsage.cache_read_input_tokens;
      cacheCreation = this.lastAssistantUsage.cache_creation_input_tokens;
    } else {
      cacheRead = msg.usage.cache_read_input_tokens ?? 0;
      cacheCreation = msg.usage.cache_creation_input_tokens ?? 0;
      inputTokens = msg.usage.input_tokens + cacheRead + cacheCreation;
    }

    const usage = {
      inputTokens,
      outputTokens: msg.usage.output_tokens,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      costUsd: msg.total_cost_usd,
      contextWindow: this.cachedContextWindow,
    };

    if (msg.subtype === 'success') {
      events.push({ type: 'complete', usage });
    } else {
      const errorMsg = 'errors' in msg ? msg.errors.join(', ') : 'Query failed';

      const windowsError = buildWindowsSkillsDirError(errorMsg);
      if (windowsError) {
        events.push(windowsError);
      } else {
        events.push({ type: 'error', message: errorMsg });
      }
      events.push({ type: 'complete', usage });
    }
  }

  private adaptSystem(message: SDKMessage, events: AgentEvent[]): void {
    const msg = message as any;

    if (msg.subtype === 'init') {
      // Capture tools list from SDK init message
      if ('tools' in msg && Array.isArray(msg.tools)) {
        this._sdkTools = msg.tools;
        this.callbacks.onDebug?.(`SDK init: captured ${this._sdkTools.length} tools`);
      }
      // Earliest point at which the query is provably live — start the window read
      // here so the very first `usage_update` of a turn already carries it.
      this.ensureContextWindowRead();
    } else if (msg.subtype === 'compact_boundary') {
      events.push({
        type: 'info',
        message: 'Compacted Conversation',
      });
    } else if (msg.subtype === 'status' && msg.status === 'compacting') {
      events.push({ type: 'status', message: 'Compacting conversation...' });
    } else if (msg.subtype === 'task_notification') {
      const notification = msg as TaskNotificationMessage;
      if (!notification.task_id) {
        this.callbacks.onDebug?.('[EventAdapter] task_notification missing task_id, skipping');
        return;
      }
      const status: TaskStatus = VALID_TASK_STATUSES.includes(notification.status as TaskStatus)
        ? (notification.status as TaskStatus)
        : 'completed';
      events.push({
        type: 'task_completed',
        taskId: notification.task_id,
        status,
        outputFile: notification.output_file,
        summary: notification.summary,
        turnId: this.currentTurnId || undefined,
      });
    }
  }

  private adaptAuthStatus(message: SDKMessage, events: AgentEvent[]): void {
    const msg = message as any;
    if (msg.error) {
      events.push({
        type: 'error',
        message: `Auth error: ${msg.error}. Try running /auth to re-authenticate.`,
      });
    }
  }
}
