/**
 * Request guard for Craft's loopback MCP servers (session-tools-server,
 * pool-server). Defense-in-depth against DNS rebinding: a web page in a local
 * browser can resolve an attacker domain to 127.0.0.1 and reach the server —
 * but the browser still sends the attacker `Host`/`Origin`, which we reject.
 *
 * Native MCP clients (Hermes, Codex, Copilot subprocesses) connect to
 * http://127.0.0.1:<port>/mcp and never send a web Origin, so they pass.
 */

import { timingSafeEqual, createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

/** Extract hostname from a Host header value (may include port). */
function hostHeaderHostname(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Returns a rejection reason, or null when the request is a trusted loopback
 * request. Rules:
 * - `Host` is required and must be loopback (rejects DNS rebinding).
 * - `Origin`, when present, must be loopback (rejects web content).
 */
export function loopbackRequestRejection(req: IncomingMessage): string | null {
  const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
  if (!host) return 'Missing Host header';
  const hostname = hostHeaderHostname(host);
  if (!hostname || !isLoopbackHostname(hostname)) {
    return `Non-loopback Host: ${host}`;
  }

  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  if (origin) {
    let originHostname: string | null = null;
    try {
      originHostname = new URL(origin).hostname;
    } catch {
      originHostname = null;
    }
    if (!originHostname || !isLoopbackHostname(originHostname)) {
      return `Non-loopback Origin: ${origin}`;
    }
  }

  return null;
}

/** Timing-safe bearer token check against `Authorization: Bearer <token>`. */
export function bearerTokenRejection(req: IncomingMessage, expectedToken: string): string | null {
  const auth = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  const presented = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  // Hash both sides so timingSafeEqual gets equal-length buffers.
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expectedToken).digest();
  if (!presented || !timingSafeEqual(a, b)) {
    return 'Missing or invalid bearer token';
  }
  return null;
}

/**
 * Apply the loopback guard (and optional bearer auth) to an incoming request.
 * Writes the error response and returns false when the request must not be
 * processed; returns true when it may proceed.
 */
export function enforceLoopbackRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options?: { authToken?: string; debug?: (msg: string) => void },
): boolean {
  const loopbackReason = loopbackRequestRejection(req);
  if (loopbackReason) {
    options?.debug?.(`Rejected non-loopback request: ${loopbackReason}`);
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Forbidden');
    return false;
  }

  if (options?.authToken) {
    const tokenReason = bearerTokenRejection(req, options.authToken);
    if (tokenReason) {
      options?.debug?.(`Rejected unauthenticated request: ${tokenReason}`);
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('Unauthorized');
      return false;
    }
  }

  return true;
}
