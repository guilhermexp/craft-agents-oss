import {
  runPreToolUseChecks,
  type PreToolUseInput,
  type PreToolUseCheckResult,
  type PermissionManagerLike,
  type PrerequisiteManagerLike,
} from './pre-tool-use.ts';
import { getPermissionModeDiagnostics } from '../mode-manager.ts';
import type { PermissionMode } from '../mode-types.ts';
import type { RtkContext } from './rtk-rewrite.ts';

export interface PermissionRequestPayload {
  requestId: string;
  toolName: string;
  command?: string;
  description: string;
  type: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval';
  appName?: string;
  reason?: string;
  impact?: string;
  requiresSystemPrompt?: boolean;
  rememberForMinutes?: number;
  commandHash?: string;
  approvalTtlSeconds?: number;
}

export type PermissionRequestCallback = (payload: PermissionRequestPayload) => void;
export type SourceActivationCallback = (sourceSlug: string) => Promise<boolean>;

/**
 * Everything the dispatcher reads from its host agent. Values that change over
 * an agent's lifetime (session id, folder paths, source slugs, permission mode,
 * wired callbacks) are getters so a single dispatcher instance stays live across
 * turns without a mutation ceremony. Stable collaborators (managers) are direct
 * references.
 */
export interface ToolPermissionContext {
  getSessionId: () => string;
  getWorkspaceRootPath: () => string;
  getWorkspaceId: () => string;
  getPlansFolderPath: () => string | undefined;
  getDataFolderPath: () => string | undefined;
  getWorkingDirectory: () => string | undefined;
  permissionManager: PermissionManagerLike;
  prerequisiteManager?: PrerequisiteManagerLike;
  getActiveSourceSlugs: () => string[];
  getAllSourceSlugs: () => string[];
  getPermissionMode: () => PermissionMode;
  /** The UI permission-prompt callback, or null when none is wired. */
  getPermissionRequest: () => PermissionRequestCallback | null;
  /** The source-activation callback, or null when the backend can't activate. */
  getSourceActivationRequest: () => SourceActivationCallback | null;
  /** RTK Bash-rewrite context, recomputed per dispatch (undefined when off). */
  getRtkContext?: () => RtkContext | undefined;
  onDebug?: (message: string) => void;
}

/**
 * Backend-agnostic outcome of one PreToolUse dispatch. Each backend encodes it
 * into its SDK's response shape.
 *
 * `isError` on a block distinguishes a real failure from a control-flow block:
 * when true (permission-mode denial, config/prerequisite block) the backend
 * marks the tool result as an error — Claude adds the `[ERROR]` marker so the
 * model reads it as a failure. When omitted/false the reason is a control-flow
 * message the model must relay verbatim — e.g. the successful mid-turn source
 * activation that asks the user to resend; prefixing that with `[ERROR]` would
 * tell the model the activation FAILED. See isToolResultError in tool-matching.ts.
 *
 * `endTurn` on a block is the ONLY way a denied tool ends the agent turn. The
 * default is to deny the tool and keep the turn alive, so the model reads the
 * reason and corrects course. Only an explicit user denial at a permission
 * prompt sets it: a turn ends when a human ended it, never because a guard
 * fired.
 */
export type ToolPermissionResult =
  | { type: 'allow' }
  | { type: 'modify'; input: Record<string, unknown> }
  | { type: 'block'; reason: string; isError?: boolean; endTurn?: boolean }
  | { type: 'passthrough' };

export interface PendingPermission {
  resolve: (allowed: boolean) => void;
  toolName: string;
  command?: string;
  baseCommand?: string;
}

export interface ToolPermissionDispatcherOptions {
  /**
   * Divergence 1 (post-activation). When true (Pi), a successful mid-turn source
   * activation re-runs the pipeline for the same tool so the call proceeds this
   * turn. When false (Claude), the tool is blocked with a STOP message asking the
   * user to resend — the Claude SDK fixes its tool registry at query start, so
   * newly-activated source tools aren't callable until the next query.
   */
  rerunAfterActivation?: boolean;
  /**
   * Divergence 2 (emission). Called after a successful source activation, before
   * the rerun/STOP decision. Pi wires this to enqueue a `source_activated` event
   * that restarts the turn with the new tools live; Claude leaves it unset
   * because its STOP strategy relies on the user resending instead.
   */
  onSourceActivated?: (sourceSlug: string) => void;
}

/**
 * Single owner of the PreToolUse orchestration shared by the Claude and Pi
 * backends: the pending-permission map, the source-activation flow, and the
 * translation of every `runPreToolUseChecks` arm into a backend-agnostic
 * {@link ToolPermissionResult}. Each backend supplies only a context + options
 * and encodes the result into its SDK's response shape.
 *
 * The five historical Claude/Pi divergences are now deliberate, not accidental:
 *  1. post-activation behaviour → {@link ToolPermissionDispatcherOptions.rerunAfterActivation}
 *  2. `source_activated` emission → {@link ToolPermissionDispatcherOptions.onSourceActivated}
 *  3. source-not-active handling → unified: activation is attempted whenever a
 *     handler exists and the handler reports feasibility (a non-existent source
 *     simply fails activation and yields the "not available yet" message), so
 *     there is no separate `sourceExists` pre-guard.
 *  4. no permission handler → BLOCK. A prompt means the user must approve; with
 *     no handler we cannot obtain approval, so allowing would silently bypass
 *     ask-mode gating. Auto-allowing here was a Pi-only security hole.
 *  5. `alwaysAllow` whitelisting → unified in `BaseAgent.respondToPermission`.
 *     The old Pi ignored the flag by construction (its pending entry carried no
 *     command/baseCommand), so "always allow" silently did nothing on Pi. The
 *     shared pending map now carries command/baseCommand, so an "always allow"
 *     on either backend whitelists the destination domain (curl/wget) or the
 *     base command through one path. Deliberate move in the PERMISSIVE direction
 *     for Pi, matching Claude.
 */
export class ToolPermissionDispatcher {
  private pendingPermissions = new Map<string, PendingPermission>();
  private ctx: ToolPermissionContext;
  private rerunAfterActivation: boolean;
  private onSourceActivated: ((sourceSlug: string) => void) | null;

  constructor(ctx: ToolPermissionContext, options?: ToolPermissionDispatcherOptions) {
    this.ctx = ctx;
    this.rerunAfterActivation = options?.rerunAfterActivation ?? false;
    this.onSourceActivated = options?.onSourceActivated ?? null;
  }

  async dispatch(
    toolName: string,
    input: Record<string, unknown>,
    requestId: string,
  ): Promise<ToolPermissionResult> {
    const ctx = this.ctx;
    ctx.onDebug?.(`dispatch ${toolName} (permissionMode=${ctx.getPermissionMode()})`);

    const checkResult = runPreToolUseChecks(this.buildCheckInput(toolName, input));
    return this.handleResult(checkResult, toolName, input, requestId);
  }

  private buildCheckInput(toolName: string, input: Record<string, unknown>): PreToolUseInput {
    const ctx = this.ctx;
    return {
      toolName,
      input,
      sessionId: ctx.getSessionId(),
      permissionMode: ctx.getPermissionMode(),
      workspaceRootPath: ctx.getWorkspaceRootPath(),
      workspaceId: ctx.getWorkspaceId(),
      plansFolderPath: ctx.getPlansFolderPath(),
      dataFolderPath: ctx.getDataFolderPath(),
      workingDirectory: ctx.getWorkingDirectory(),
      activeSourceSlugs: ctx.getActiveSourceSlugs(),
      allSourceSlugs: ctx.getAllSourceSlugs(),
      hasSourceActivation: !!ctx.getSourceActivationRequest(),
      permissionManager: ctx.permissionManager,
      prerequisiteManager: ctx.prerequisiteManager,
      rtkContext: ctx.getRtkContext?.(),
      onDebug: ctx.onDebug,
    };
  }

  private async handleResult(
    checkResult: PreToolUseCheckResult,
    toolName: string,
    input: Record<string, unknown>,
    requestId: string,
  ): Promise<ToolPermissionResult> {
    switch (checkResult.type) {
      case 'allow':
        return { type: 'allow' };

      case 'modify':
        return { type: 'modify', input: checkResult.input };

      case 'block': {
        const sessionId = this.ctx.getSessionId();
        const diagnostics = getPermissionModeDiagnostics(sessionId);
        // Raw (unprefixed) marker — consumed by log tooling, keep it verbatim.
        this.ctx.onDebug?.(`__PERMISSION_BLOCK__${JSON.stringify({
          sessionId,
          toolName,
          effectiveMode: diagnostics.permissionMode,
          modeVersion: diagnostics.modeVersion,
          changedBy: diagnostics.lastChangedBy,
          changedAt: diagnostics.lastChangedAt,
          reason: checkResult.reason,
        })}`);
        return { type: 'block', reason: checkResult.reason, isError: true };
      }

      case 'source_activation_needed':
        return this.handleSourceActivation(checkResult, toolName, input);

      case 'call_llm_intercept':
      case 'spawn_session_intercept':
        return { type: 'passthrough' };

      case 'prompt':
        return this.handlePermissionPrompt(checkResult, toolName, requestId);
    }
  }

  private async handleSourceActivation(
    checkResult: Extract<PreToolUseCheckResult, { type: 'source_activation_needed' }>,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ToolPermissionResult> {
    const { sourceSlug, sourceExists } = checkResult;
    const onSourceActivationRequest = this.ctx.getSourceActivationRequest();

    this.ctx.onDebug?.(`Source "${sourceSlug}" not active, attempting activation...`);

    // Divergence 3: no activation handler → block. We never pre-guard on
    // sourceExists; when a handler is present the handler is the authority on
    // feasibility.
    if (!onSourceActivationRequest) {
      const reason = sourceExists
        ? `Source "${sourceSlug}" is available but not enabled for this session. Please enable it in the sources panel.`
        : `Source "${sourceSlug}" could not be connected. It may need re-authentication, or the server may be unreachable.`;
      return { type: 'block', reason };
    }

    try {
      const activated = await onSourceActivationRequest(sourceSlug);
      if (!activated) {
        const reason = sourceExists
          ? `Source "${sourceSlug}" is not active. Activate it by @mentioning it in your message or via the source icon at the bottom of the input field.`
          : `Source "${sourceSlug}" is not available yet. It needs to be created and configured first.`;
        return { type: 'block', reason };
      }

      this.ctx.onDebug?.(`Source "${sourceSlug}" activated successfully`);

      // Divergence 2: emit before deciding how to continue.
      this.onSourceActivated?.(sourceSlug);

      // Divergence 1: rerun the pipeline (Pi) or stop and ask the user to
      // resend (Claude).
      if (this.rerunAfterActivation) {
        const postResult = runPreToolUseChecks(this.buildCheckInput(toolName, input));
        switch (postResult.type) {
          case 'allow': return { type: 'allow' };
          case 'modify': return { type: 'modify', input: postResult.input };
          case 'block': return { type: 'block', reason: postResult.reason };
          default: return { type: 'allow' };
        }
      }

      // Control-flow block, NOT an error: the activation SUCCEEDED. `isError:false`
      // keeps the encoder from adding the `[ERROR]` marker, so the model relays a
      // success message instead of reporting a failure.
      return {
        type: 'block',
        isError: false,
        reason: `STOP. Source "${sourceSlug}" has been activated successfully. The tools will be available on the next turn. Do NOT try other tool names or approaches. Respond to the user now: tell them the source is now active and ask them to send their request again.`,
      };
    } catch (error) {
      return {
        type: 'block',
        reason: `Failed to activate source "${sourceSlug}": ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  private async handlePermissionPrompt(
    checkResult: Extract<PreToolUseCheckResult, { type: 'prompt' }>,
    toolName: string,
    requestId: string,
  ): Promise<ToolPermissionResult> {
    const onPermissionRequest = this.ctx.getPermissionRequest();

    // Divergence 4 (security path): a prompt requires user approval. With no
    // handler we cannot obtain it, so we block instead of auto-allowing.
    if (!onPermissionRequest) {
      return { type: 'block', reason: 'No permission handler available to approve this tool.' };
    }

    const command = checkResult.command || '';
    const baseCommand = this.ctx.permissionManager.getBaseCommand(command);

    // Restored diagnostics (lost when the inline Claude/Pi handlers were unified
    // into the dispatcher): both backends logged a line before parking the prompt.
    this.ctx.onDebug?.(`[PreToolUse] Requesting permission for ${toolName}`);
    this.ctx.onDebug?.(`Prompting user for ${toolName} - ${checkResult.description}`);

    const permissionPromise = new Promise<boolean>((resolve) => {
      this.pendingPermissions.set(requestId, {
        resolve,
        toolName,
        command,
        baseCommand,
      });
    });

    onPermissionRequest({
      requestId,
      toolName,
      command,
      description: checkResult.description,
      type: checkResult.promptType,
      appName: checkResult.appName,
      reason: checkResult.reason,
      impact: checkResult.impact,
      requiresSystemPrompt: checkResult.requiresSystemPrompt,
      rememberForMinutes: checkResult.rememberForMinutes,
      commandHash: checkResult.commandHash,
      approvalTtlSeconds: checkResult.approvalTtlSeconds,
    });

    const allowed = await permissionPromise;
    this.pendingPermissions.delete(requestId);

    if (!allowed) {
      // The one block that ends the turn: the human said no. Every other block
      // denies the tool and leaves the model running to recover.
      return { type: 'block', reason: 'Permission denied by user.', endTurn: true };
    }

    if (checkResult.modifiedInput) {
      return { type: 'modify', input: checkResult.modifiedInput };
    }
    return { type: 'allow' };
  }

  respondToPermission(requestId: string, allowed: boolean): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    // Delete before resolving so a second response in the same tick cannot find
    // the entry and double-resolve the promise.
    this.pendingPermissions.delete(requestId);
    pending.resolve(allowed);
    return true;
  }

  getPendingPermission(requestId: string): PendingPermission | undefined {
    return this.pendingPermissions.get(requestId);
  }

  clearPendingPermissions(): void {
    for (const [, pending] of this.pendingPermissions) {
      pending.resolve(false);
    }
    this.pendingPermissions.clear();
  }
}
