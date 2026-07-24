/**
 * Tool names registered by the vendored pi-better-subagents extension. They
 * must be added to the Pi SDK `tools` allowlist, otherwise the SDK filters out
 * every extension-provided tool (same contract as COMPUTER_USE_TOOL_NAMES).
 */
export const SUBAGENT_TOOL_NAMES = Object.freeze([
  'subagent_spawn',
  'subagent_list',
  'subagent_output',
  'subagent_result',
  'subagent_stop',
]);
