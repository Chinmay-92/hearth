// Streamable HTTP transport (MCP spec 2025-11-25) for Hearth.
//   POST   /mcp  JSON-RPC requests/notifications (responses as JSON or SSE)
//   GET    /mcp  server->client SSE stream for an existing session
//   DELETE /mcp  end a session
//   POST   /inbox/notes  care-team notes from a clinic portal or email webhook (own token)
// Every session gets its own McpServer + transport; all share one CareStore and EventHub.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { sendAlert } from "./alerts.ts";
import { EventHub } from "./events.ts";
import { createHearthServer, SERVER_INFO } from "./hearth.ts";
import { mcpAuth, type OAuthServer } from "./oauth.ts";
import { mountPublicPages } from "./public-pages.ts";
import type { CareStore } from "./store.ts";

export type AppOptions = {
  host?: string;
  /** Browser origins allowed to call /mcp. Requests with no Origin header (CLI, server-to-server) are allowed. */
  allowedOrigins?: string[];
  /** If set, `Authorization: Bearer <token>` grants full access (simulator, Inspector, Claude). */
  token?: string;
  /** OAuth 2.1 server for Alexa+ (service tokens + account linking). */
  oauth?: OAuthServer;
  /** Public hostnames (e.g. a tunnel) accepted in the Host header in addition to localhost. */
  publicHosts?: string[];
  /** Shared with the scheduler so reminders reach every connected session. */
  hub?: EventHub;
  /** Bearer token for POST /inbox/notes. The inbox is off when unset. */
  inboxToken?: string;
};

const INBOX_MAX = 4000;

/** Pulls sender and text out of JSON, form posts (e.g. Mailgun/Postmark inbound email) or plain text. */
function parseInbound(body: unknown, query: Record<string, unknown>): { from: string; text: string } {
  const b = (typeof body === "object" && body ? body : {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => keys.map((k) => b[k] ?? query[k]).find((v) => typeof v === "string" && v.trim()) as string | undefined;
  const raw = typeof body === "string" ? body : pick("text", "body", "message", "stripped-text", "body-plain", "TextBody");
  const subject = pick("subject", "Subject");
  const from = (pick("from", "author", "sender", "From") ?? "Care team").replace(/\s*<[^>]*>\s*/, "").trim() || "Care team";
  const text = [subject, raw].filter(Boolean).join(": ").trim();
  return { from: from.slice(0, 120), text: text.slice(0, INBOX_MAX) };
}

const jsonRpcError = (res: Response, status: number, code: number, message: string) =>
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });

export function createApp(store: CareStore, opts: AppOptions = {}): { app: Express; close: () => Promise<void> } {
  const host = opts.host ?? "127.0.0.1";
  // DNS-rebinding protection on the Host header: localhost plus any configured public hostname.
  const app = createMcpExpressApp({
    host,
    allowedHosts: opts.publicHosts?.length ? ["127.0.0.1", "localhost", "[::1]", ...opts.publicHosts] : undefined,
  });
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const allowed = new Set(opts.allowedOrigins ?? []);
  const hub = opts.hub ?? new EventHub();

  const originAllowed = (origin: string) =>
    allowed.has(origin) || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

  // Spec: servers MUST validate Origin to prevent DNS rebinding; reject with 403.
  // Allowed browser origins also get CORS headers so web-based MCP clients work.
  const originGuard = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (!origin) return next();
    if (!originAllowed(origin)) return jsonRpcError(res, 403, -32000, `Origin ${origin} is not allowed`);
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID");
      res.setHeader("Access-Control-Max-Age", "86400");
      return res.status(204).end();
    }
    next();
  };
  app.options("/mcp", originGuard);
  const auth = mcpAuth({ oauth: opts.oauth, staticToken: opts.token });
  opts.oauth?.mount(app);
  mountPublicPages(app);

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, server: SERVER_INFO, sessions: transports.size, hasProfile: Boolean(store.getProfile()) });
  });

  app.post("/mcp", originGuard, auth, async (req, res) => {
    const sid = req.header("mcp-session-id");
    let transport = sid ? transports.get(sid) : undefined;

    if (!transport) {
      if (sid) return jsonRpcError(res, 404, -32001, "Session not found");
      if (!isInitializeRequest(req.body)) return jsonRpcError(res, 400, -32000, "Bad Request: no session; send initialize first");
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => void transports.set(id, transport!),
      });
      transport.onclose = () => {
        if (transport!.sessionId) transports.delete(transport!.sessionId);
      };
      await createHearthServer(store, hub).connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  });

  const sessionRequest = async (req: Request, res: Response) => {
    const sid = req.header("mcp-session-id");
    if (!sid) return jsonRpcError(res, 400, -32000, "Bad Request: missing Mcp-Session-Id");
    const transport = transports.get(sid);
    if (!transport) return jsonRpcError(res, 404, -32001, "Session not found");
    await transport.handleRequest(req, res);
  };
  // Care-team inbox: a clinic portal, Zapier, or an inbound-email webhook posts
  // instructions here; they reach the family and are read to the care recipient.
  app.post(
    "/inbox/notes",
    express.json({ limit: "64kb" }),
    express.urlencoded({ extended: false, limit: "64kb" }),
    express.text({ type: "text/*", limit: "64kb" }),
    (req, res) => {
      if (!opts.inboxToken) return void res.status(404).json({ error: "The care-team inbox is not enabled (set HEARTH_INBOX_TOKEN)." });
      const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
      if (bearer.length !== opts.inboxToken.length || !timingSafeEqual(Buffer.from(bearer), Buffer.from(opts.inboxToken))) {
        return void res.status(401).json({ error: "unauthorized" });
      }
      const profile = store.getProfile();
      if (!profile) return void res.status(409).json({ error: "No care profile yet." });
      const { from, text } = parseInbound(req.body, req.query as Record<string, unknown>);
      if (!text) return void res.status(400).json({ error: "Send the note as text, or JSON/form with a text field." });
      const note = store.addNote(from, text, undefined, "care_team");
      hub.emit({ kind: "care_team_note", from, text, noteId: note.id });
      const primary = profile.family[0];
      if (primary) sendAlert(store, hub, primary, "info", `New note from ${from}: ${text}`, from);
      res.status(201).json({ id: note.id, from, readToRecipient: "next time she asks what's due" });
    },
  );

  app.get("/mcp", originGuard, auth, sessionRequest);
  app.delete("/mcp", originGuard, auth, sessionRequest);

  return {
    app,
    close: async () => {
      await Promise.all([...transports.values()].map((t) => t.close()));
      transports.clear();
    },
  };
}
