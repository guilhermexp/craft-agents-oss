import {
  runPreToolUseChecks,
  type PreToolUseInput,
  type PreToolUseCheckResult,
  type PermissionManagerLike,
  type PrerequisiteManagerLike,
} from './pre-tool-use.ts';
import { getPermissionModeDiagnostics } from '../mode-manager.ts';

export interface PermissionRequestPayload {
  requestId: string;
  toolName: string;
  command?: string;
  description: string;
  type: string;
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

export interface ToolPermissionContext {
  sessionId: string;
  workspaceRootPath: string;
  workspaceId: string;
  plansFolderPath?: string;
  dataFolderPath?: string;
  workingDirectory?: string;
  permissionManager: PermissionManagerLike;
  prerequisiteManager?: PrerequisiteManagerLike;
  getActiveSourceSlugs: () => string[];
  getAllSourceSlugs: () => string[];
  getPermissionMode: () => string;
  onDebug?: (message: string) => void;
}

export type ToolPermissionResult =
  | { type: 'allow' }
  | { type: 'modify'; input: Record<string, unknown> }
  | { type: 'block'; reason: string }
  | { type: 'passthrough' };

export interface PendingPermission {
  resolve: (allowed: boolean) => void;
  toolName: string;
  command?: string;
  baseCommand?: string;
}

export class ToolPermissionDispatcher {
  private pendingPermissions = new Map<string, PendingPermission>();
  private onPermissionRequest: PermissionRequestCallback | null;
  private onSourceActivationRequest: SourceActivationCallback | null;
  private ctx: ToolPermissionContext;
  private rerunAfterActivation: boolean;

  constructor(
    ctx: ToolPermissionContext,
    onPermissionRequest: PermissionRequestCallback | null,
    onSourceActivationRequest: SourceActivationCallback | null,
    options?: { rerunAfterActivation?: boolean },
  ) {
    this.ctx = ctx;
    this.onPermissionRequest = onPermissionRequest;
    this.onSourceActivationRequest = onSourceActivationRequest;
    this.rerunAfterActivation = options?.rerunAfterActivation ?? false;
  }

  updateContext(partial: Partial<ToolPermissionContext>): void {
    Object.assign(this.ctx, partial);
  }

  async dispatch(
    toolName: string,
    input: Record<string, unknown>,
    requestId: string,
  ): Promise<ToolPermissionResult> {
    const ctx = this.ctx;
    const sessionId = ctx.sessionId;

    ctx.onDebug?.(`PreToolUse: ${toolName} (sessionId=${sessionId}, permissionMode=${ctx.getPermissionMode()})`);

    const checkInput: PreToolUseInput = {
      toolName,
      input,
      sessionId,
      permissionMode: ctx.getPermissionMode() as any,
      workspaceRootPath: ctx.workspaceRootPath,
      workspaceId: ctx.workspaceId,
      plansFolderPath: ctx.plansFolderPath,
      dataFolderPath: ctx.dataFolderPath,
      workingDirectory: ctx.workingDirectory,
      activeSourceSlugs: ctx.getActiveSourceSlugs(),
      allSourceSlugs: ctx.getAllSourceSlugs(),
      hasSourceActivation: !!this.onSourceActivationRequest,
      permissionManager: ctx.permissionManager,
      prerequisiteManager: ctx.prerequisiteManager,
      onDebug: ctx.onDebug,
    };

    const checkResult = runPreToolUseChecks(checkInput);

    return this.handleResult(checkResult, toolName, input, requestId, checkInput);
  }

  private async handleResult(
    checkResult: PreToolUseCheckResult,
    toolName: string,
    input: Record<string, unknown>,
    requestId: string,
    checkInput: PreToolUseInput,
  ): Promise<ToolPermissionResult> {
    const sessionId = this.ctx.sessionId;

    switch (checkResult.type) {
      case 'allow':
        return { type: 'allow' };

      case 'modify':
        return { type: 'modify', input: checkResult.input };

      case 'block': {
        const diagnostics = getPermissionModeDiagnostics(sessionId);
        this.ctx.onDebug?.(`__PERMISSION_BLOCK__${JSON.stringify({
          sessionId,
          toolName,
          effectiveMode: diagnostics.permissionMode,
          modeVersion: diagnostics.modeVersion,
          changedBy: diagnostics.lastChangedBy,
          changedAt: diagnostics.lastChangedAt,
          reason: checkResult.reason,
        })}`);
        return { type: 'block', reason: checkResult.reason };
      }

      case 'source_activation_needed':
        return this.handleSourceActivation(checkResult, toolName, input, checkInput);

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
    checkInput: PreToolUseInput,
  ): Promise<ToolPermissionResult> {
    const { sourceSlug, sourceExists } = checkResult;
    const sessionId = this.ctx.sessionId;

    this.ctx.onDebug?.(`PreToolUse(sessionId=${sessionId}): Source "${sourceSlug}" not active, attempting activation...`);

    if (!this.onSourceActivationRequest) {
      const reason = sourceExists
        ? `Source "${sourceSlug}" is available but not enabled for this session. Please enable it in the sources panel.`
        : `Source "${sourceSlug}" could not be connected. It may need re-authentication, or the server may be unreachable.`;
      return { type: 'block', reason };
    }

    try {
      const activated = await this.onSourceActivationRequest(sourceSlug);
      if (!activated) {
        const reason = sourceExists
          ? `Source "${sourceSlug}" could not be activated. It may require authentication.`
          : `Source "${sourceSlug}" is not available yet. It needs to be created and configured first.`;
        return { type: 'block', reason };
      }

      this.ctx.onDebug?.(`PreToolUse(sessionId=${sessionId}): Source "${sourceSlug}" activated successfully`);

      if (this.rerunAfterActivation) {
        const postResult = runPreToolUseChecks({
          ...checkInput,
          activeSourceSlugs: this.ctx.getActiveSourceSlugs(),
          allSourceSlugs: this.ctx.getAllSourceSlugs(),
        });

        switch (postResult.type) {
          case 'allow': return { type: 'allow' };
          case 'modify': return { type: 'modify', input: postResult.input };
          case 'block': return { type: 'block', reason: postResult.reason };
          default: return { type: 'allow' };
        }
      }

      return {
        type: 'block',
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
    if (!this.onPermissionRequest) {
      if (checkResult.modifiedInput) {
        return { type: 'modify', input: checkResult.modifiedInput };
      }
      return { type: 'allow' };
    }

    const command = checkResult.command || '';
    const baseCommand = this.ctx.permissionManager.getBaseCommand(command);

    const permissionPromise = new Promise<boolean>((resolve) => {
      this.pendingPermissions.set(requestId, {
        resolve,
        toolName,
        command,
        baseCommand,
      });
    });

    this.onPermissionRequest({
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
      return { type: 'block', reason: 'Permission denied by user.' };
    }

    if (checkResult.modifiedInput) {
      return { type: 'modify', input: checkResult.modifiedInput };
    }
    return { type: 'allow' };
  }

  respondToPermission(requestId: string, allowed: boolean): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    pending.resolve(allowed);
    return true;
  }

  getPendingPermission(requestId: string): PendingPermission | undefined {
    return this.pendingPermissions.get(requestId);
  }

  getPendingPermissionIds(): string[] {
    return Array.from(this.pendingPermissions.keys());
  }

  clearPendingPermissions(): void {
    for (const [, pending] of this.pendingPermissions) {
      pending.resolve(false);
    }
    this.pendingPermissions.clear();
  }
}
