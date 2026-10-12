// Alexa+ simulator backend. Each browser tab is one "device": it owns an MCP
// client session to the Hearth server and a conversation with Claude.
//   POST /api/session            -> { id }  (connects to Hearth over Streamable HTTP)
//   POST /api/turn   {id, text, speaker}  -> text/event-stream of AgentEvents + elicitation prompts
//   POST /api/elicit {id, requestId, action, content}
//   GET  /api/ambient?id=        -> whats_due for the idle screen (direct MCP call, no LLM)
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import express, { type Response } from "express";
import { AlexaSimulator } from "./agent.ts";

const HEARTH_URL = process.env.HEARTH_MCP_URL ?? "http://127.0.0.1:8787/mcp";
const PORT = Number(process.env.PORT ?? 5173);

type Device = {
  client: Client;
  sim: AlexaSimulator;
  stream: Response | null; // SSE stream of the turn in flight
  elicits: Map<string, (r: ElicitResult) => void>;
};
const devices = new Map<string, Device>();

async function createDevice(): Promise<string> {
  const id = randomUUID();
  const client = new Client(
    { name: "alexa-plus-simulator", title: "Alexa+ Simulator (Hearth demo)", version: "0.1.0" },
    {
      capabilities: {
        elicitation: { form: {} },
        extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
      },
    },
  );
  const device: Device = { client, sim: new AlexaSimulator(client), stream: null, elicits: new Map() };

  // Server-initiated elicitation: forward to the screen, wait for a tap or a spoken yes/no.
  client.setRequestHandler(ElicitRequestSchema, (req) => {
    const requestId = randomUUID();
    const params = req.params as { message: string; requestedSchema?: unknown };
    return new Promise<ElicitResult>((resolve) => {
      device.elicits.set(requestId, resolve);
      if (!device.stream) return resolve({ action: "cancel" });
      sse(device.stream, { type: "elicit", requestId, message: params.message, schema: params.requestedSchema });
    });
  });

  await client.connect(new StreamableHTTPClientTransport(new URL(HEARTH_URL), {
    requestInit: process.env.HEARTH_TOKEN ? { headers: { Authorization: `Bearer ${process.env.HEARTH_TOKEN}` } } : undefined,
  }));
  devices.set(id, device);
  return id;
}

function sse(res: Response, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const app = express();
app.use(express.json());
app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

app.post("/api/session", async (_req, res) => {
  try {
    res.json({ id: await createDevice(), hearth: HEARTH_URL });
  } catch (err) {
    res.status(502).json({ error: `Could not reach the Hearth MCP server at ${HEARTH_URL}: ${err}` });
  }
});

app.post("/api/turn", async (req, res) => {
  const { id, text, speaker } = req.body as { id: string; text: string; speaker?: string };
  const device = devices.get(id);
  if (!device) return void res.status(404).json({ error: "unknown session" });
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  device.stream = res;
  try {
    await device.sim.turn(String(text).slice(0, 2000), speaker || "Asha", (e) => sse(res, e));
  } catch (err) {
    console.error(err);
    sse(res, { type: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    for (const resolve of device.elicits.values()) resolve({ action: "cancel" });
    device.elicits.clear();
    device.stream = null;
    sse(res, { type: "done" });
    res.end();
  }
});

app.post("/api/elicit", (req, res) => {
  const { id, requestId, action, content } = req.body as { id: string; requestId: string; action: ElicitResult["action"]; content?: Record<string, string | number | boolean> };
  const resolve = devices.get(id)?.elicits.get(requestId);
  if (!resolve) return void res.status(404).json({ error: "no pending question" });
  devices.get(id)!.elicits.delete(requestId);
  resolve(action === "accept" ? { action, content } : { action });
  res.json({ ok: true });
});

app.post("/api/reset", (req, res) => {
  devices.get((req.body as { id: string }).id)?.sim.reset();
  res.json({ ok: true });
});

app.get("/api/ambient", async (req, res) => {
  const device = devices.get(String(req.query.id));
  if (!device) return void res.status(404).json({ error: "unknown session" });
  try {
    const r = await device.client.request({ method: "tools/call", params: { name: "whats_due", arguments: { horizon_hours: 12 } } }, CallToolResultSchema);
    res.json(r.structuredContent ?? {});
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Alexa+ simulator on http://127.0.0.1:${PORT}  (Hearth MCP: ${HEARTH_URL})`);
  if (!process.env.ANTHROPIC_API_KEY) console.log("Note: ANTHROPIC_API_KEY is not set; the SDK will fall back to an `ant auth login` profile if present.");
});
