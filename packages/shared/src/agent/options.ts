import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { join } from "path";
import { homedir } from "os";
import { getProxyEnvVars } from "../config/proxy-env.ts";
import { getExtendedPromptCache } from "../config/preference-storage.ts";

declare const CRAFT_AGENT_CLI_VERSION: string | undefined;

let customPathToClaudeCodeExecutable: string | null = null;

/**
 * Override the path to the Claude Code executable.
 *
 * Since SDK 0.2.113 this is the **native** `claude` binary shipped via the
 * platform-specific optional dependency (`@anthropic-ai/claude-agent-sdk-{platform}-{arch}`),
 * not a JS file. Override is only needed when the SDK can't auto-discover the
 * binary — typically packaged Electron builds where module resolution from
 * `sdk.mjs` doesn't find the per-platform package.
 */
export function setPathToClaudeCodeExecutable(path: string) {
    customPathToClaudeCodeExecutable = path;
}

/**
 * Read the currently-configured custom path (set via setPathToClaudeCodeExecutable).
 *
 * Returns `undefined` (not `null`) so callers can pass it directly into SDK option
 * fields typed `string | undefined`. The CLI/dev-runtime path that doesn't go
 * through the custom setter is captured at SDK options-build time in claude-agent.ts.
 */
export function getPathToClaudeCodeExecutable(): string | undefined {
    return customPathToClaudeCodeExecutable ?? undefined;
}

/**
 * Get default SDK options for spawning the Claude Code subprocess.
 *
 * @param envOverrides - Per-session environment variable overrides.
 *   These are spread AFTER process.env so they take precedence.
 *   Used to pass per-session config like ANTHROPIC_BASE_URL that would
 *   otherwise be clobbered by concurrent sessions mutating process.env.
 */
export function buildClaudeSubprocessEnv(
    envOverrides?: Record<string, string>,
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...getProxyEnvVars(),
        ...envOverrides,
        // Propagate debug mode from argv flag OR existing env var
        CRAFT_DEBUG: (process.argv.includes('--debug') || process.env.CRAFT_DEBUG === '1') ? '1' : '0',
    };

    // Bedrock must never be routed through the Claude SDK path.
    // Strip only Claude-specific Bedrock routing vars here; keep generic AWS_*
    // untouched so user shell/tooling behavior inside the subprocess remains intact.
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.AWS_BEARER_TOKEN_BEDROCK;
    delete env.ANTHROPIC_BEDROCK_BASE_URL;

    // Honor the extendedPromptCache preference via the native CLI's own env
    // switches (the interceptor that used to patch cache_control TTL doesn't
    // run under the native binary). Skip when the user already set either
    // switch in their shell.
    if (!env.ENABLE_PROMPT_CACHING_1H && !env.FORCE_PROMPT_CACHING_5M) {
        if (getExtendedPromptCache()) {
            env.ENABLE_PROMPT_CACHING_1H = '1';
        } else {
            env.FORCE_PROMPT_CACHING_5M = '1';
        }
    }

    return env;
}

/** Filename of the per-platform native Claude binary inside its npm package. */
function nativeBinaryName(): string {
    return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

export function getDefaultOptions(envOverrides?: Record<string, string>): Partial<Options> {
    const env = buildClaudeSubprocessEnv(envOverrides);
    const baseOptions: Partial<Options> = {
        env,
        settingSources: ['project', 'local'],
    };

    // If custom path is set (e.g., for Electron packaged build), point the SDK at it.
    // This is the native `claude` binary, not a JS file.
    if (customPathToClaudeCodeExecutable) {
        return {
            ...baseOptions,
            pathToClaudeCodeExecutable: customPathToClaudeCodeExecutable,
        };
    }

    // Standalone CLI distribution (`scripts/install.sh`) lays the per-version
    // SDK out at ~/.local/share/craft/versions/<version>/claude-agent-sdk/<binary>
    if (typeof CRAFT_AGENT_CLI_VERSION !== 'undefined' && CRAFT_AGENT_CLI_VERSION != null) {
        const baseDir = join(homedir(), '.local', 'share', 'craft', 'versions', CRAFT_AGENT_CLI_VERSION);
        return {
            ...baseOptions,
            pathToClaudeCodeExecutable: join(baseDir, 'claude-agent-sdk', nativeBinaryName()),
        };
    }

    // Default: let the SDK auto-discover the native binary via standard
    // node_modules resolution from `sdk.mjs`. The matching platform package
    // (e.g. `@anthropic-ai/claude-agent-sdk-darwin-arm64`) is installed via
    // optionalDependencies.
    return baseOptions;
}
