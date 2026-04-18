export function normalizeContent(content: string): string {
  return content
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export async function computeContentHash(content: string, target: string): Promise<string> {
  const input = normalizeContent(content) + ':' + target;
  const encoder = new TextEncoder();
  const data = encoder.encode(input);

  if (typeof globalThis.crypto?.subtle?.digest === 'function') {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .substring(0, 32);
  }

  // Fallback: simple hash for environments without SubtleCrypto
  let hash = 0;
  const str = new TextDecoder().decode(data);
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(16, '0').substring(0, 32);
}
