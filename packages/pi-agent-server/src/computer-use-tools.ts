export const COMPUTER_USE_TOOL_NAMES = Object.freeze([
  'find_roots',
  'observe_ui',
  'search_ui',
  'expand_ui',
  'inspect_ui',
  'act_ui',
  'read_text',
  'wait_for',
  'launch_browser',
  'navigate_browser',
  'evaluate_browser',
]);

export function buildPiToolAllowlist(baseToolNames: string[], includeComputerUse: boolean): string[] {
  if (!includeComputerUse) {
    return baseToolNames;
  }

  return [...new Set([...baseToolNames, ...COMPUTER_USE_TOOL_NAMES])];
}
