export const COMPUTER_USE_TOOL_NAMES = Object.freeze([
  'screenshot',
  'click',
  'double_click',
  'move_mouse',
  'drag',
  'scroll',
  'keypress',
  'type_text',
  'set_text',
  'wait',
  'computer_actions',
]);

export function buildPiToolAllowlist(baseToolNames: string[], includeComputerUse: boolean): string[] {
  if (!includeComputerUse) {
    return baseToolNames;
  }

  return [...new Set([...baseToolNames, ...COMPUTER_USE_TOOL_NAMES])];
}
