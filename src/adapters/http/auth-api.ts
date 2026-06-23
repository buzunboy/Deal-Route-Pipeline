import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { z } from 'zod';
import type {
  AuthenticateUseCase,
  RefreshUseCase,
  LogoutUseCase,
  TokenIssuer,
  Logger,
} from '../../application/index.js';
import { MALFORMED, TOO_LARGE, readBody, sendJson, sendError, errMessage } from './http-helpers.js';
import { tryMapAuthError } from './auth-error-map.js';

/** Options for the auth router (CORS is the only knob; the surface is unauthenticated). */
export interface AuthApiOptions {
  /**
   * `Access-Control-Allow-Origin` for the browser admin panel. UNSET ⇒ no CORS headers
   * (server-to-server only). When set it is echoed verbatim (never `*` — this surface
   * carries credentials in the body) and the preflight advertises `Content-Type`. The
   * panel calls `/auth/login` server-side, but the JWKS / a future browser flow may be
   * cross-origin, so CORS is wired the same way `ReviewApi` does it.
   */
  corsAllowOrigin?: string;
}

/**
 * `AuthApi` (Auth/IAM) — the THIRD bare-Node HTTP router, sibling to `ReviewApi` (`/api/*`)
 * and `PublicApi` (`/v1/*`). It owns ONLY the UNAUTHENTICATED auth endpoints and the PUBLIC
 * JWKS — the credential (password / refresh token) in the request body IS the auth; there is
 * no bearer here. The gated Users/Roles admin endpoints live on `ReviewApi` (they need the
 * per-request JWT guard), not here.
 *
 *   POST /auth/login                 { email, password }       → 200 { accessToken, refreshToken, … }
 *   POST /auth/refresh               { refreshToken }          → 200 (a rotated pair)
 *   POST /auth/logout                { refreshToken }          → 204 (idempotent)
 *   GET  /.well-known/jwks.json      —                         → 200 { keys: [JWK] } (public, cacheable)
 *
 * `serve.ts` dispatches `/auth/*` + `/.well-known/jwks.json` to this router by prefix
 * (before the `/v1` vs `/api` split). Like the other routers it exposes a socket-free
 * `handle(req, res)` for testing.
 */
export class AuthApi {
  private server: Server | null = null;
  private readonly corsAllowOrigin?: string;

  constructor(
    private readonly authenticate: AuthenticateUseCase,
    private readonly refresh: RefreshUseCase,
    private readonly logout: LogoutUseCase,
    private readonly tokenIssuer: TokenIssuer,
    private readonly logger: Logger,
    options: AuthApiOptions = {},
  ) {
    this.corsAllowOrigin = options.corsAllowOrigin;
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          this.logger.error('auth API request failed', { error: errMessage(err) });
          if (!res.headersSent) sendError(res, 500, 'internal error');
        });
      });
      this.server.listen(port, () => {
        this.logger.info('auth API listening', { port });
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /** Exposed for testing without binding a socket. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    this.applyCors(res);
    if (method === 'OPTIONS') {
      res.writeHead(this.corsAllowOrigin ? 204 : 405);
      res.end();
      return;
    }

    if (method === 'GET' && path === '/.well-known/jwks.json') {
      // Public key set for external verifiers + the live smoke test. The pipeline itself
      // does NOT fetch this (it holds the keys directly); it exists for completeness.
      const jwks = await this.tokenIssuer.jwks();
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=300',
      });
      res.end(JSON.stringify(jwks));
      return;
    }

    if (method === 'POST' && path === '/auth/login') return this.handleLogin(req, res);
    if (method === 'POST' && path === '/auth/refresh') return this.handleRefresh(req, res);
    if (method === 'POST' && path === '/auth/logout') return this.handleLogout(req, res);

    sendError(res, 404, `Not found: ${method} ${path}`);
  }

  private async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
    if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
    const parsed = LoginBody.safeParse(body);
    if (!parsed.success) return sendError(res, 400, 'email and password are required');
    return this.runMapped(res, async () => {
      const session = await this.authenticate.authenticate({
        email: parsed.data.email,
        password: parsed.data.password,
        userAgent: headerStr(req, 'user-agent'),
        ip: clientIp(req),
      });
      sendJson(res, 200, session);
    });
  }

  private async handleRefresh(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
    if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
    const parsed = RefreshBody.safeParse(body);
    if (!parsed.success) return sendError(res, 400, 'refreshToken is required');
    return this.runMapped(res, async () => {
      const session = await this.refresh.refresh({
        refreshToken: parsed.data.refreshToken,
        userAgent: headerStr(req, 'user-agent'),
        ip: clientIp(req),
      });
      sendJson(res, 200, session);
    });
  }

  private async handleLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    if (body === TOO_LARGE) return sendError(res, 413, 'request body too large');
    if (body === MALFORMED) return sendError(res, 400, 'malformed JSON body');
    const parsed = LogoutBody.safeParse(body);
    if (!parsed.success) return sendError(res, 400, 'refreshToken is required');
    // Logout is idempotent and must never confirm a token's validity — always 204.
    await this.logout.logout(parsed.data.refreshToken);
    res.writeHead(204);
    res.end();
  }

  /** Run an auth action, translating typed auth errors to their status; else re-throw. */
  private async runMapped(res: ServerResponse, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (tryMapAuthError(res, err)) return;
      throw err; // unexpected → top-level generic 500 (no leaked internals)
    }
  }

  private applyCors(res: ServerResponse): void {
    if (this.corsAllowOrigin === undefined) return;
    res.setHeader('access-control-allow-origin', this.corsAllowOrigin);
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'Content-Type');
    res.setHeader('vary', 'Origin');
  }
}

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
const RefreshBody = z.object({ refreshToken: z.string().min(1) });
const LogoutBody = z.object({ refreshToken: z.string().min(1) });

/** A single request header as a string (joining a multi-value header), or undefined. */
function headerStr(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.join(', ') : v;
}

/** Best-effort client IP for the refresh-token row (never trusted for auth). */
function clientIp(req: IncomingMessage): string | undefined {
  const fwd = headerStr(req, 'x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? undefined;
}
