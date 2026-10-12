import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ElicitRequestSchema, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { createApp } from "../src/app.ts";
import { assessCheckIn, familyDigest } from "../src/insights.ts";
import { seedDemo } from "../src/seed.ts";
import { CareStore } from "../src/store.ts";

process.env.HEARTH_DRY_RUN = "1";
const FIXED_NOW = new Date(2026, 9, 12, 9, 0); // Mon 12 Oct 2026, 09:00 local

function freshStore() {
  const store = new CareStore(":memory:", () => FIXED_NOW);
  seedDemo(store);
  return store;
}

describe("insights", () => {
  test("digest finds the seeded story: rising pain, missed evening doses, low metformin, no driver", () => {
    const d = familyDigest(freshStore(), 7);
    assert.equal(d.series.length, 7);
    assert.ok(d.adherencePercent! < 100 && d.adherencePercent! > 50, `adherence ${d.adherencePercent}`);
    const flags = d.flags.join(" | ");
    assert.match(flags, /Pain has been rising/);
    assert.match(flags, /Metformin runs out/);
    assert.match(flags, /No one is driving to "Orthopedics/);
  });

  test("urgent phrases escalate, mild ones are watched, calm ones are not", () => {
    const store = freshStore();
    const base = { pain: 3, mood: 4, sleepHours: 7, note: "" };
    assert.equal(assessCheckIn(store, { ...base, symptoms: "I fell in the bathroom" }).level, "urgent");
    assert.equal(assessCheckIn(store, { ...base, symptoms: "a little dizzy this morning" }).level, "watch");
    assert.equal(assessCheckIn(store, { ...base, pain: 9, symptoms: "" }).level, "urgent");
  });
});

describe("MCP over Streamable HTTP", () => {
  let url: URL;
  let closeApp: () => Promise<void>;
  let httpServer: ReturnType<ReturnType<typeof createApp>["app"]["listen"]>;
  let store: CareStore;

  before(async () => {
    store = freshStore();
    const { app, close } = createApp(store);
    closeApp = close;
    httpServer = app.listen(0, "127.0.0.1");
    await new Promise((r) => httpServer.once("listening", r));
    url = new URL(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`);
  });
  after(async () => {
    await closeApp();
    httpServer.close();
  });

  async function connect(elicit?: (msg: string, schema: unknown) => { action: "accept" | "decline"; content?: Record<string, unknown> }) {
    const client = new Client({ name: "test", version: "0" }, { capabilities: elicit ? { elicitation: { form: {} } } : {} });
    if (elicit) client.setRequestHandler(ElicitRequestSchema, async (req) => elicit(req.params.message, (req.params as { requestedSchema?: unknown }).requestedSchema));
    const transport = new StreamableHTTPClientTransport(url);
    await client.connect(transport);
    return { client, transport };
  }
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
    client.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema);
  const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join(" ");

  test("negotiates protocol 2025-11-25 and lists tools, resources, prompts", async () => {
    const { client, transport } = await connect();
    assert.equal(LATEST_PROTOCOL_VERSION, "2025-11-25");
    assert.equal(transport.protocolVersion, "2025-11-25");
    assert.equal(client.getServerVersion()?.name, "hearth");
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["add_care_note", "assign_driver", "family_digest", "log_checkin", "notify_family", "record_dose", "schedule_appointment", "whats_due"]);
    const digest = (await client.listTools()).tools.find((t) => t.name === "family_digest")!;
    assert.equal((digest._meta as { ui: { resourceUri: string } }).ui.resourceUri, "ui://hearth/digest");
    const ui = await client.readResource({ uri: "ui://hearth/digest" });
    assert.equal(ui.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.ok((await client.listPrompts()).prompts.some((p) => p.name === "morning_checkin"));
    await client.close();
  });

  test("whats_due -> record_dose -> whats_due round trip persists across sessions", async () => {
    const a = await connect();
    assert.match(textOf(await call(a.client, "whats_due")), /Lisinopril/);
    const rec = await call(a.client, "record_dose", { medication: "my blood pressure pill" });
    assert.match(textOf(rec), /Recorded Lisinopril 10 mg as taken for the 8:00 AM dose/);
    await a.client.close();

    const b = await connect(); // a different device, same household
    const due = await call(b.client, "whats_due");
    assert.doesNotMatch(textOf(due), /Lisinopril/);
    assert.match(textOf(due), /Metformin/);
    await b.client.close();
  });

  test("urgent check-in elicits consent and alerts the primary caregiver", async () => {
    let asked = "";
    const { client } = await connect((msg) => ((asked = msg), { action: "accept", content: { alert: true } }));
    const r = await call(client, "log_checkin", { pain: 5, symptoms: "I fell getting out of bed", mood: 2 });
    assert.match(asked, /Should I alert Priya/);
    assert.match(textOf(r), /Priya has been alerted/);
    assert.equal(store.notifications(new Date(0))[0].urgency, "urgent");
    await client.close();
  });

  test("notify_family without elicitation requires explicit confirmation", async () => {
    const { client } = await connect();
    const first = await call(client, "notify_family", { to: "my son", message: "Can you bring milk?" });
    assert.match(textOf(first), /Not sent yet/);
    const second = await call(client, "notify_family", { to: "my son", message: "Can you bring milk?", confirmed: true });
    assert.match(textOf(second), /Sent to Raj/);
    await client.close();
  });

  test("notify_family with elicitation honours a decline", async () => {
    const { client } = await connect(() => ({ action: "decline" }));
    const r = await call(client, "notify_family", { to: "everyone", message: "test" });
    assert.match(textOf(r), /didn't send/);
    await client.close();
  });

  test("schedule_appointment asks who drives and notifies them", async () => {
    const { client } = await connect((_m, schema) => {
      assert.ok(JSON.stringify(schema).includes("Raj (son)"));
      return { action: "accept", content: { driver: "Raj" } };
    });
    const r = await call(client, "schedule_appointment", { title: "Eye exam", when: "2026-10-20T14:00" });
    assert.match(textOf(r), /Raj is driving and has been notified/);
    await client.close();
  });

  test("without elicitation, schedule_appointment hands off to assign_driver", async () => {
    const { client } = await connect();
    const r = await call(client, "schedule_appointment", { title: "Dental cleaning", when: "2026-10-22T09:00" });
    const id = (r.structuredContent as { appointment: { id: number } }).appointment.id;
    assert.match(textOf(r), new RegExp(`call assign_driver with appointment_id ${id}`));
    const a = await call(client, "assign_driver", { driver: "my daughter", appointment_id: id });
    assert.match(textOf(a), /Priya is driving to Dental cleaning/);
    assert.equal(store.notifications(new Date(0))[0].to, "Priya");
    await client.close();
  });

  test("rejects foreign browser origins (DNS rebinding) and unknown sessions", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "0" } } };
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const evil = await fetch(url, { method: "POST", headers: { ...headers, origin: "https://evil.example" }, body: JSON.stringify(init) });
    assert.equal(evil.status, 403);
    const ghost = await fetch(url, { method: "POST", headers: { ...headers, "mcp-session-id": "nope" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) });
    assert.equal(ghost.status, 404);
  });
});
