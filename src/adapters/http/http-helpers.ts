import { type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

/**
 * Shared bare-Node HTTP helpers (Auth/IAM extraction). `ReviewApi`, `AuthApi`, and any
 * future router reuse the SAME body reader, send helpers, sentinels, and constant-time
 * compare — so the 413/400/401 behaviour, the body-size cap, and the JSON envelope can't
 * drift between routers. No framework dependency (the house keeps the surface light +
 * swappable); these are pure functions over Node's req/res.
 */

/** Max accepted request-body size. Auth + review bodies are a few hundred bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

/** Sentinels distinguishing malformed / oversized bodies from an (allowed) empty one. */
export const MALFORMED = Symbol('malformed-json');
export const TOO_LARGE = Symbol('body-too-large');

/**
 * Read and JSON-parse a request body, bounding total size so a client cannot exhaust
 * memory by streaming an unbounded body (Node imposes no default cap). Returns the
 * TOO_LARGE / MALFORMED sentinels for the handler to map to 413 / 400; an empty body
 * parses to `{}`.
 */
export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  let oversize = false;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      // Stop buffering but keep draining the stream to completion, so the connection
      // stays usable and the handler can return a clean 413 (destroying the socket
      // mid-request makes the client see a reset).
      oversize = true;
      chunks.length = 0;
    } else if (!oversize) {
      chunks.push(buf);
    }
  }
  if (oversize) return TOO_LARGE;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Don't swallow: signal malformed input so the handler returns a clear 400.
    return MALFORMED;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/**
 * Stream raw bytes back with an explicit content-type and `private, no-store` (a shared
 * cache or the browser must not retain reviewer-only artifacts). Always 200; the
 * absent case is a 404 handled by the caller before this is reached.
 */
export function sendBytes(res: ServerResponse, contentType: string, bytes: Uint8Array): void {
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'private, no-store',
  });
  res.end(Buffer.from(bytes));
}

/** Constant-time string compare to avoid leaking a secret (token/hash) via timing. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Parse an integer query param; null when present-but-not-an-integer (caller 400s). */
export function parseIntParam(raw: string | null, fallback: number): number | null {
  if (raw === null || raw === '') return fallback;
  if (!/^-?\d+$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
