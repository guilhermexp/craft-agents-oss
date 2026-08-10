#!/usr/bin/env bun
/**
 * browser-tool (secondary helper)
 *
 * Thin, deterministic CLI for browser automation discovery outside agent turns:
 * - `--help` prints the canonical `browser_tool` grammar (single source, from
 *   the runtime's `getBrowserToolHelp()` — no duplicated per-command templates).
 * - `parse-url <url>` prints structured URL fields for safe debugging in Explore
 *   mode without running a generic interpreter snippet.
 *
 * Execution still happens through the native `browser_tool` tool in sessions.
 */

import { getBrowserToolHelp } from '../packages/shared/src/agent/browser-tool-runtime.ts';

type CommandSpec = {
  name: string;
  args?: string;
  description: string;
  example: string;
};

type Io = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

const COMMANDS: CommandSpec[] = [
  { name: 'help', description: 'Show the canonical browser_tool grammar', example: 'browser-tool --help' },
  { name: 'parse-url', args: '<url>', description: 'Parse a URL and print structured fields for debugging', example: 'browser-tool parse-url file:///tmp/report.html' },
];

function printHelp(io: Io): void {
  io.log('browser-tool - Browser automation helper for Craft Agents');
  io.log('');
  io.log('Usage:');
  io.log('  bun run browser-tool <command> [args]');
  io.log('  bun run browser-tool --help');
  io.log('');
  io.log('Commands:');
  for (const cmd of COMMANDS) {
    const sig = cmd.args ? `${cmd.name} ${cmd.args}` : cmd.name;
    io.log(`  ${sig.padEnd(28)} ${cmd.description}`);
  }
  io.log('');
  io.log('The only in-session tool is `browser_tool`; its command grammar:');
  io.log('');
  io.log(getBrowserToolHelp());
}

function printJson(io: Io, value: unknown): void {
  io.log(JSON.stringify(value, null, 2));
}

function getFileBasename(pathname: string): string | null {
  const decodedPath = decodeURIComponent(pathname || '');
  const normalizedPath = decodedPath.replace(/\/+$/, '');
  if (!normalizedPath) return null;
  return normalizedPath.split('/').filter(Boolean).at(-1) || null;
}

export function parseUrlDetails(rawUrl: string): Record<string, unknown> {
  const parsed = new URL(rawUrl);
  const isFile = parsed.protocol === 'file:';

  return {
    href: parsed.href,
    protocol: parsed.protocol,
    host: parsed.host,
    hostname: parsed.hostname,
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
    origin: parsed.origin,
    ...(isFile
      ? {
          decodedPath: decodeURIComponent(parsed.pathname || ''),
          basename: getFileBasename(parsed.pathname),
        }
      : {}),
  };
}

export function runBrowserToolCli(argv: string[], io: Io = console): number {
  const args = argv.slice(2);
  const [command = 'help', op] = args;

  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp(io);
    return 0;
  }

  if (command === 'parse-url') {
    if (!op) {
      io.error('Error: parse-url requires <url>');
      return 1;
    }

    try {
      printJson(io, { parsed: parseUrlDetails(op) });
      return 0;
    } catch (error) {
      io.error(`Error: invalid URL "${op}"`);
      io.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  io.error(`Error: unknown command "${command}"\n`);
  printHelp(io);
  return 1;
}

if (import.meta.main) {
  process.exit(runBrowserToolCli(process.argv));
}
