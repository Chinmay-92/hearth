// Streamable HTTP transport (MCP spec 2025-11-25) for Hearth.
//   POST   /mcp  JSON-RPC requests/notifications (responses as JSON or SSE)
//   GET    /mcp  server->client SSE stream for an existing session
//   DELETE /mcp  end a session
// Every session gets its own McpServer + transport; all share one CareStore.
import { randomUUID } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Express, NextFunction, Request, Response } from "express";
import { createHearthServer, SERVER_INFO } from "./hearth.ts";
import type { CareStore } from "./store.ts";

export type AppOptions = {
  host?: string;
  /** Browser origins allowed to call /mcp. Requests with no Origin header (CLI, server-to-server) are allowed. */
  allowedOrigins?: string[];
  /** If set, every /mcp request must carry `Authorization: Bearer <token>`. */
  token?: string;
};

const jsonRpcError = (res: Response, status: number, code: number, message: string) =>
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });

export function createApp(store: CareStore, opts: AppOptions = {}): { app: Express; close: () => Promise<void> } {
  const host = opts.host ?? "127.0.0.1";
  const app = createMcpExpressApp({ host });
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const allowed = new Set(opts.allowedOrigins ?? []);

  // Spec: servers MUST validate Origin to prevent DNS rebinding; reject with 403.
  const originGuard = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && !allowed.has(origin) && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
      return jsonRpcError(res, 403, -32000, `Origin ${origin} is not allowed`);
    }
    next();
  };
  const auth = (req: Request, res: Response, next: NextFunction) => {
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="hearth"');
      return jsonRpcError(res, 401, -32000, "Unauthorized");
    }
    next();
  };

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
      await createHearthServer(store).connect(transport);
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
