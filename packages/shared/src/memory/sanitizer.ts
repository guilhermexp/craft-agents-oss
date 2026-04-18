const THREAT_PATTERNS: Array<[RegExp, string]> = [
  [/ignore\s+(previous|all|above|prior)(\s+\w+)*\s+instructions/i, 'prompt_injection'],
  [/you\s+are\s+now\s+/i, 'role_hijack'],
  [/do\s+not\s+tell\s+the\s+user/i, 'deception_hide'],
  [/system\s+prompt\s+override/i, 'sys_prompt_override'],
  [/disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, 'disregard_rules'],
  [/act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have)\s+(restrictions|limits|rules)/i, 'bypass_restrictions'],
  [/curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, 'exfil_curl'],
  [/wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, 'exfil_wget'],
  [/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, 'read_secrets'],
  [/authorized_keys/i, 'ssh_backdoor'],
];

const INVISIBLE_CHARS = new Set([
  '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff',
  '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
]);

export interface SanitizeResult {
  safe: boolean;
  reason?: string;
}

export function sanitizeMemoryContent(content: string): SanitizeResult {
  for (const char of content) {
    if (INVISIBLE_CHARS.has(char)) {
      return {
        safe: false,
        reason: `Blocked: invisible unicode character U+${char.codePointAt(0)!.toString(16).padStart(4, '0').toUpperCase()}`,
      };
    }
  }

  for (const [pattern, id] of THREAT_PATTERNS) {
    if (pattern.test(content)) {
      return {
        safe: false,
        reason: `Blocked: threat pattern '${id}'`,
      };
    }
  }

  return { safe: true };
}

export function stripMemoryFenceTags(text: string): string {
  return text.replace(/<\/?memory-context>/gi, '');
}
