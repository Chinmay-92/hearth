// A small OAuth 2.1 authorization server + resource-server guard, shaped to
// what the Alexa+ MCP Toolkit expects:
//   - Protected Resource Metadata (RFC 9728) at /.well-known/oauth-protected-resource
//   - Authorization server metadata (RFC 8414) at /.well-known/oauth-authorization-server
//   - client_credentials -> `mcp:service` token (initialize, tools/list; no user data)
//   - authorization_code + PKCE S256 -> `mcp:tools mcp:resources` + refresh token
//     (account linking: a family member approves with the household PIN and
//     says who uses this Alexa, so every tool call knows who is speaking)
//   - 401 *without* WWW-Authenticate when a user-level token is required, which
//     is Alexa+'s cue to start account linking.
// One pre-registered client (Alexa+); no dynamic client registration.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import express, { type Express, type NextFunction, type Request, type Response } from "express";

export type OAuthConfig = {
  /** Public base URL, e.g. https://hearth.example.com (no trailing slash). */
  publicUrl: string;
  clientId: string;
  clientSecret: string;
  /** Household PIN a family member enters to approve account linking. */
  linkPin: string;
  household: () => string;
  /** People who can be chosen as "who uses this Alexa" on the consent page. */
  members?: () => string[];
  accessTtlSec?: number;
  refreshTtlSec?: number;
  now?: () => number;
};

export type TokenInfo = { scopes: string[]; kind: "service" | "user" | "static"; member?: string | null };

const SERVICE_SCOPE = "mcp:service";
const USER_SCOPES = ["mcp:tools", "mcp:resources"];
/** JSON-RPC methods that touch household data and therefore need a user-level token. */
const USER_METHODS = new Set(["tools/call", "resources/read", "resources/subscribe", "prompts/get", "completion/complete"]);

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const b64url = (buf: Buffer) => buf.toString("base64url");
const newToken = () => b64url(randomBytes(32));

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function oauthError(res: Response, status: number, error: string, description: string) {
  res.status(status).setHeader("Cache-Control", "no-store").json({ error, error_description: description });
}

export class OAuthServer {
  private db: DatabaseSync;
  private cfg: Required<OAuthConfig>;
  private pinFailures = 0;
  private lockedUntil = 0;

  constructor(db: DatabaseSync, cfg: OAuthConfig) {
    this.db = db;
    this.cfg = { accessTtlSec: 3600, refreshTtlSec: 90 * 86400, now: () => Date.now(), members: () => [], ...cfg, publicUrl: cfg.publicUrl.replace(/\/+$/, "") };
    db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_codes (
        code_hash TEXT PRIMARY KEY, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL,
        scope TEXT NOT NULL, resource TEXT, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, scope TEXT NOT NULL,
        expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    `);
    // Who uses the linked Alexa (added after the first release).
    for (const table of ["oauth_codes", "oauth_tokens"]) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === "member")) db.exec(`ALTER TABLE ${table} ADD COLUMN member TEXT`);
    }
  }

  /** Update the public base URL, e.g. when a dev tunnel restarts with a new hostname. */
  setPublicUrl(url: string) {
    this.cfg.publicUrl = url.replace(/\/+$/, "");
  }

  get resource() {
    return `${this.cfg.publicUrl}/mcp`;
  }

  // ------------------------------------------------------------ metadata

  protectedResourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.cfg.publicUrl],
      scopes_supported: [SERVICE_SCOPE, ...USER_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "Hearth",
    };
  }

  authorizationServerMetadata() {
    const base = this.cfg.publicUrl;
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      scopes_supported: [SERVICE_SCOPE, ...USER_SCOPES],
    };
  }

  // ------------------------------------------------------------ tokens

  private issue(kind: "access" | "refresh", scope: string, ttlSec: number, member: string | null = null) {
    const token = newToken();
    this.db
      .prepare("INSERT INTO oauth_tokens (token_hash, kind, scope, expires, member) VALUES (?, ?, ?, ?, ?)")
      .run(sha256(token), kind, scope, this.cfg.now() + ttlSec * 1000, member);
    return token;
  }

  private lookup(token: string, kind: "access" | "refresh") {
    const row = this.db
      .prepare("SELECT scope, expires, revoked, member FROM oauth_tokens WHERE token_hash = ? AND kind = ?")
      .get(sha256(token), kind) as { scope: string; expires: number; revoked: number; member: string | null } | undefined;
    if (!row || row.revoked || row.expires < this.cfg.now()) return null;
    return row;
  }

  verifyAccessToken(token: string): TokenInfo | null {
    const row = this.lookup(token, "access");
    if (!row) return null;
    const scopes = row.scope.split(" ");
    return { scopes, kind: scopes.includes(SERVICE_SCOPE) ? "service" : "user", member: row.member };
  }

  private authenticateClient(req: Request): boolean {
    let id: string | undefined;
    let secret: string | undefined;
    const basic = req.headers.authorization?.match(/^Basic\s+(.+)$/i);
    if (basic) {
      const decoded = Buffer.from(basic[1], "base64").toString("utf8");
      const i = decoded.indexOf(":");
      id = decodeURIComponent(decoded.slice(0, i));
      secret = decodeURIComponent(decoded.slice(i + 1));
    } else if (req.body?.client_secret) {
      id = req.body.client_id;
      secret = req.body.client_secret;
    }
    return Boolean(id && secret && safeEqual(id, this.cfg.clientId) && safeEqual(secret, this.cfg.clientSecret));
  }

  private tokenResponse(res: Response, body: Record<string, unknown>) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.json({ token_type: "Bearer", expires_in: this.cfg.accessTtlSec, ...body });
  }

  private handleToken = (req: Request, res: Response) => {
    if (req.query && Object.keys(req.query).some((k) => /secret/i.test(k))) {
      return oauthError(res, 400, "invalid_request", "Client credentials must not be sent in the query string");
    }
    if (!this.authenticateClient(req)) return oauthError(res, 401, "invalid_client", "Client authentication failed");
    const p = req.body as Record<string, string | undefined>;

    switch (p.grant_type) {
      case "client_credentials": {
        if (p.resource && p.resource !== this.resource) return oauthError(res, 403, "access_denied", `resource must be ${this.resource}`);
        const requested = (p.scope ?? SERVICE_SCOPE).split(" ").filter(Boolean);
        if (requested.some((s) => s !== SERVICE_SCOPE)) return oauthError(res, 400, "invalid_scope", "client_credentials only grants mcp:service");
        // No refresh token for this grant: the client simply asks again.
        return this.tokenResponse(res, { access_token: this.issue("access", SERVICE_SCOPE, this.cfg.accessTtlSec), scope: SERVICE_SCOPE });
      }

      case "authorization_code": {
        if (!p.code || !p.code_verifier || !p.redirect_uri) return oauthError(res, 400, "invalid_request", "code, code_verifier and redirect_uri are required");
        const hash = sha256(p.code);
        const row = this.db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(hash) as
          | { redirect_uri: string; challenge: string; scope: string; resource: string | null; expires: number; member: string | null }
          | undefined;
        this.db.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").run(hash); // single use
        if (!row || row.expires < this.cfg.now()) return oauthError(res, 400, "invalid_grant", "Authorization code is invalid or expired");
        if (row.redirect_uri !== p.redirect_uri) return oauthError(res, 400, "invalid_grant", "redirect_uri mismatch");
        if (b64url(createHash("sha256").update(p.code_verifier).digest()) !== row.challenge) return oauthError(res, 400, "invalid_grant", "PKCE verification failed");
        if (p.resource && p.resource !== this.resource) return oauthError(res, 400, "invalid_target", `resource must be ${this.resource}`);
        return this.tokenResponse(res, {
          access_token: this.issue("access", row.scope, this.cfg.accessTtlSec, row.member),
          refresh_token: this.issue("refresh", row.scope, this.cfg.refreshTtlSec, row.member),
          scope: row.scope,
        });
      }

      case "refresh_token": {
        if (!p.refresh_token) return oauthError(res, 400, "invalid_request", "refresh_token is required");
        const row = this.lookup(p.refresh_token, "refresh");
        if (!row) return oauthError(res, 400, "invalid_grant", "Refresh token is invalid or expired");
        // Rotate: the old refresh token stops working.
        this.db.prepare("UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?").run(sha256(p.refresh_token));
        return this.tokenResponse(res, {
          access_token: this.issue("access", row.scope, this.cfg.accessTtlSec, row.member),
          refresh_token: this.issue("refresh", row.scope, this.cfg.refreshTtlSec, row.member),
          scope: row.scope,
        });
      }

      default:
        return oauthError(res, 400, "unsupported_grant_type", `Unsupported grant_type ${p.grant_type ?? "(missing)"}`);
    }
  };

  // ------------------------------------------------------------ authorize (account linking)

  private validateAuthorizeParams(q: Record<string, unknown>): string | null {
    if (q.client_id !== this.cfg.clientId) return "Unknown client_id.";
    if (q.response_type !== "code") return "response_type must be code.";
    if (q.code_challenge_method !== "S256" || typeof q.code_challenge !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) return "PKCE with S256 is required.";
    if (typeof q.redirect_uri !== "string" || !/^https:\/\//.test(q.redirect_uri)) return "redirect_uri must be an https URL.";
    if (q.resource && q.resource !== this.resource) return `resource must be ${this.resource}.`;
    return null;
  }

  private consentPage(q: Record<string, string>, error?: string) {
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const members = this.cfg.members();
    const hidden = ["client_id", "redirect_uri", "response_type", "scope", "state", "code_challenge", "code_challenge_method", "resource"]
      .filter((k) => q[k] != null)
      .map((k) => `<input type="hidden" name="${k}" value="${esc(String(q[k]))}">`)
      .join("");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link Hearth to Alexa</title>
<style>
:root{--bg:#fbf7f2;--ink:#2b2420;--muted:#7a6d64;--ember:#d9622b;--card:#fff;--line:#ece3da}
@media (prefers-color-scheme:dark){:root{--bg:#1d1916;--ink:#f3ebe3;--muted:#b3a597;--card:#26211d;--line:#3a322c}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,sans-serif;padding:16px}
main{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:28px;max-width:420px;width:100%}
h1{font-size:22px;margin:0 0 6px}p{color:var(--muted);margin:0 0 18px}
label{display:block;font-weight:600;margin-bottom:6px}
select{width:100%;box-sizing:border-box;font:inherit;padding:12px;border-radius:12px;border:1px solid var(--line);background:transparent;color:inherit}
input[type=password]{width:100%;box-sizing:border-box;font:inherit;font-size:22px;letter-spacing:.3em;padding:12px;border-radius:12px;border:1px solid var(--line);background:transparent;color:inherit}
button{margin-top:16px;width:100%;font:600 17px system-ui;padding:14px;border:0;border-radius:12px;background:var(--ember);color:#fff;cursor:pointer}
.err{color:#c0392b;font-weight:600;margin-bottom:12px}
</style></head><body><main>
<h1>Link Hearth to Alexa</h1>
<p>Alexa is asking to access <strong>${esc(this.cfg.household())}</strong>: medications, check-ins, appointments and family messages. Enter the household PIN to approve.</p>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<form method="post" action="/oauth/authorize">${hidden}
<label for="pin">Household PIN</label>
<input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="one-time-code" required autofocus>
${members.length ? `<label for="member" style="margin-top:16px">Who uses this Alexa?</label>
<select id="member" name="member">${members.map((m) => `<option${m === q.member ? " selected" : ""}>${esc(m)}</option>`).join("")}<option value="">Shared by everyone</option></select>
<p style="margin:6px 0 0;font-size:14px">Hearth uses this to know who is speaking, e.g. who sent a message or logged a dose.</p>` : ""}
<button type="submit">Allow Alexa</button></form></main></body></html>`;
  }

  private handleAuthorizeGet = (req: Request, res: Response) => {
    const q = req.query as Record<string, string>;
    const err = this.validateAuthorizeParams(q);
    if (err) return res.status(400).type("text/plain").send(err);
    res.type("html").send(this.consentPage(q));
  };

  private handleAuthorizePost = (req: Request, res: Response) => {
    const q = req.body as Record<string, string>;
    const err = this.validateAuthorizeParams(q);
    if (err) return res.status(400).type("text/plain").send(err);
    if (this.cfg.now() < this.lockedUntil) return res.status(429).type("html").send(this.consentPage(q, "Too many attempts. Try again in a few minutes."));
    if (!safeEqual(String(q.pin ?? ""), this.cfg.linkPin)) {
      if (++this.pinFailures >= 5) {
        this.lockedUntil = this.cfg.now() + 5 * 60_000;
        this.pinFailures = 0;
      }
      return res.status(401).type("html").send(this.consentPage(q, "That PIN didn't match."));
    }
    this.pinFailures = 0;
    const member = this.cfg.members().find((m) => m === q.member) ?? null;
    const code = newToken();
    this.db
      .prepare("INSERT INTO oauth_codes (code_hash, redirect_uri, challenge, scope, resource, expires, member) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(sha256(code), q.redirect_uri, q.code_challenge, USER_SCOPES.join(" "), q.resource ?? null, this.cfg.now() + 5 * 60_000, member);
    const target = new URL(q.redirect_uri);
    target.searchParams.set("code", code);
    if (q.state) target.searchParams.set("state", q.state);
    res.redirect(302, target.toString());
  };

  // ------------------------------------------------------------ wiring

  mount(app: Express) {
    const prm = (_req: Request, res: Response) => void res.json(this.protectedResourceMetadata());
    app.get("/.well-known/oauth-protected-resource", prm);
    app.get("/.well-known/oauth-protected-resource/mcp", prm);
    app.get("/.well-known/oauth-authorization-server", (_req, res) => void res.json(this.authorizationServerMetadata()));
    const form = express.urlencoded({ extended: false });
    app.get("/oauth/authorize", this.handleAuthorizeGet);
    app.post("/oauth/authorize", form, this.handleAuthorizePost);
    app.post("/oauth/token", form, express.json(), this.handleToken);
  }
}

/**
 * Guard for /mcp. Accepts OAuth access tokens (if configured) and/or a static
 * bearer token. Service tokens may initialize and list; anything that reads or
 * writes household data needs a user-level token, otherwise 401 so Alexa+
 * starts account linking. Per the Alexa+ toolkit, 401s carry no WWW-Authenticate.
 */
export function mcpAuth(opts: { oauth?: OAuthServer; staticToken?: string }) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!opts.oauth && !opts.staticToken) return next();
    const unauthorized = (message: string) => res.status(401).json({ error: "unauthorized", message });
    const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!bearer) return unauthorized("Access token required.");
    if (opts.staticToken && safeEqual(bearer, opts.staticToken)) {
      (req as Request & { auth?: AuthInfo }).auth = { token: bearer, clientId: "static", scopes: [] };
      return next();
    }
    const info = opts.oauth?.verifyAccessToken(bearer);
    if (!info) return unauthorized("Access token is invalid or expired.");
    // The SDK passes req.auth to tool handlers as extra.authInfo; Hearth reads the speaker from it.
    (req as Request & { auth?: AuthInfo }).auth = { token: bearer, clientId: "alexa", scopes: info.scopes, extra: { member: info.member ?? null } };
    const method = (req.body as { method?: string } | undefined)?.method;
    if (req.method === "POST" && method && USER_METHODS.has(method) && info.kind !== "user") {
      return unauthorized("Link your Hearth household in the Alexa app to use this.");
    }
    next();
  };
}
