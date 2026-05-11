import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { join } from "path";
import { homedir } from "os";
import { getProxyEnvVars } from "../config/proxy-env.ts";

declare const CRAFT_AGENT_CLI_VERSION: string | undefined;

let customPathToClaudeCodeExecutable: string | null = null;
let customInterceptorPath: string | null = null;
let customExecutable: string | null = null;

/**
 * Override the path to the Claude Code executable (cli.js from the SDK).
 * This is needed when the SDK is bundled (e.g., in Electron) and can't auto-detect the path.
 */
export function setPathToClaudeCodeExecutable(path: string) {
    customPathToClaudeCodeExecutable = path;
}

/**
 * Set the path to the network interceptor for the SDK subprocess.
 * This interceptor captures API errors and adds metadata to MCP tool schemas.
 */
export function setInterceptorPath(path: string) {
    customInterceptorPath = path;
}

/**
 * Set the path to the JavaScript runtime executable (e.g., bun or node).
 * This is needed when bundling a runtime with the app (e.g., in Electron).
 */
export function setExecutable(path: string) {
    customExecutable = path;
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

    return env;
}

export function getDefaultOptions(envOverrides?: Record<string, string>): Partial<Options> {
    // SECURITY: Disable Bun's automatic .env file loading in the SDK subprocess.
    // Without this, Bun loads .env from the subprocess cwd (user's working directory),
    // which can inject ANTHROPIC_API_KEY and override our OAuth auth — silently charging
    // the user's API key instead of their Max subscription.
    // See: https://github.com/lukilabs/craft-agents-oss/issues/39
    // Use platform-appropriate null device (NUL on Windows, /dev/null on Unix)
    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const envFileFlag = `--env-file=${nullDevice}`;

    // If custom path is set (e.g., for Electron), use it with minimal options
    if (customPathToClaudeCodeExecutable) {
        const executableArgs = [envFileFlag];
        // Add interceptor preload if path is set (needed for cache TTL patching)
        if (customInterceptorPath) {
            executableArgs.push('--preload', customInterceptorPath);
        }
        return {
            pathToClaudeCodeExecutable: customPathToClaudeCodeExecutable,
            // Use custom executable if set, otherwise default to 'bun'
            executable: (customExecutable || 'bun') as 'bun',
            executableArgs,
            env: buildClaudeSubprocessEnv(envOverrides)
        };
    }

    if (typeof CRAFT_AGENT_CLI_VERSION !== 'undefined' && CRAFT_AGENT_CLI_VERSION != null) {
        const baseDir = join(homedir(), '.local', 'share', 'craft', 'versions', CRAFT_AGENT_CLI_VERSION);
        return {
            pathToClaudeCodeExecutable: join(baseDir, 'claude-agent-sdk', 'cli.js'),
            // Use the compiled binary itself as the runtime via BUN_BE_BUN=1
            // This makes the compiled Bun executable act as the full Bun CLI,
            // eliminating the need for external Node or Bun installation
            executable: process.execPath as 'bun',
            // Inject network interceptor into SDK subprocess for API error capture and MCP schema injection
            executableArgs: [envFileFlag, '--preload', join(baseDir, 'unified-network-interceptor.ts')],
            env: {
                ...buildClaudeSubprocessEnv(envOverrides),
                BUN_BE_BUN: '1',
            }
        }
    }
    return {
        executableArgs: [envFileFlag],
        env: buildClaudeSubprocessEnv(envOverrides)
    };
}
