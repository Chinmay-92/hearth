// Proactive reminders, the care-team inbox, the weekly summary email, speaker
// identity via _meta, and events pushed to connected MCP clients.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createApp } from "../src/app.ts";
import { EventHub, type HearthEvent } from "../src/events.ts";
import { familyDigest } from "../src/insights.ts";
import { maybeSendWeekly, parseWeekly, runReminders } from "../src/scheduler.ts";
import { seedDemo } from "../src/seed.ts";
import { CareStore } from "../src/store.ts";
import { renderWeeklySummary, sendWeeklySummary } from "../src/weekly.ts";

process.env.HEARTH_DRY_RUN = "1";

/** A store whose clock can be moved. Starts Mon 12 Oct 2026, 08:00 local. */
function clockStore() {
  let now = new Date(2026, 9, 12, 8, 0);
  const store = new CareStore(":memory:", () => now);
  seedDemo(store);
  const set = (h: number, m = 0, dayOffset = 0) => void (now = new Date(2026, 9, 12 + dayOffset, h, m));
  return { store, set };
}

function recorder() {
  const hub = new EventHub();
  const events: HearthEvent[] = [];
  hub.subscribe((e) => events.push(e));
  return { hub, events };
}

describe("overdue-dose reminders", () => {
  test("reminds the care recipient after 30 minutes, once, grouped by due time", () => {
    const { store, set } = clockStore();
    const { hub, events } = recorder();
    set(8, 20);
    assert.deepEqual(runReminders(store, hub), []);
    set(8, 31);
    const fired = runReminders(store, hub);
    assert.equal(fired.length, 1);
    assert.deepEqual(fired[0].medications.sort(), ["lisinopril", "metformin"]);
    const e = events.find((x) => x.kind === "dose_reminder");
    assert.ok(e && e.kind === "dose_reminder" && e.stage === 1);
    assert.match(e.spoken, /Margaret, it's past time for your 8 AM lisinopril and metformin/);
    set(8, 45);
    assert.deepEqual(runReminders(store, hub), [], "each stage fires once");
  });

  test("a dose logged in time cancels the reminder", () => {
    const { store, set } = clockStore();
    const { hub } = recorder();
    set(8, 10);
    store.recordDose(store.findMedication("lisinopril")!, "taken");
    set(8, 35);
    const fired = runReminders(store, hub);
    assert.deepEqual(fired.map((f) => f.medications), [["metformin"]]);
  });

  test("escalates to the primary family member after 3 hours", () => {
    const { store, set } = clockStore();
    const { hub, events } = recorder();
    set(8, 31);
    runReminders(store, hub);
    set(11, 5);
    const fired = runReminders(store, hub);
    assert.deepEqual(fired.map((f) => f.stage), [2]);
    const alert = store.notifications(new Date(0)).find((n) => n.to === "Sarah");
    assert.ok(alert);
    assert.match(alert.message, /Margaret hasn't logged her 8 AM lisinopril and metformin yet, and it's been 3 hours/);
    assert.ok(events.some((e) => e.kind === "alert" && e.to === "Sarah"));
  });

  test("after a late start it skips the stale reminder and goes straight to family", () => {
    const { store, set } = clockStore();
    const { hub, events } = recorder();
    set(13, 0);
    const fired = runReminders(store, hub);
    assert.deepEqual(fired.map((f) => f.stage), [2]);
    assert.ok(!events.some((e) => e.kind === "dose_reminder" && e.stage === 1));
  });

  test("stays silent during quiet hours", () => {
    const { store, set } = clockStore();
    const { hub } = recorder();
    set(22, 0); // the 20:00 doses are 2 hours late, but it's 10 pm
    assert.deepEqual(runReminders(store, hub), []);
  });
});

describe("weekly summary email", () => {
  test("renders the digest with action items first, in text and HTML", () => {
    const { store } = clockStore();
    const { subject, text, html } = renderWeeklySummary(familyDigest(store, 7), "Margaret's home");
    assert.match(subject, /^Margaret's week: \d+% of meds taken, \d+ things to look at$/);
    assert.match(text, /Worth attention:\n- Pain has been rising/);
    assert.match(text, /Orthopedics follow-up \(knee\).*needs a driver/);
    assert.match(html, /<h1[^>]*>How Margaret did this week<\/h1>/);
    assert.doesNotMatch(html, /<script/i);
  });

  test("sends through Resend to family members with an email address", async () => {
    const { store } = clockStore();
    const { hub, events } = recorder();
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const saved = { ...process.env };
    Object.assign(process.env, { HEARTH_DRY_RUN: "0", RESEND_API_KEY: "re_test", HEARTH_EMAIL_FROM: "Hearth <hearth@example.com>" });
    try {
      const r = await sendWeeklySummary(store, hub, undefined, fakeFetch);
      assert.deepEqual(r.results.map((x) => [x.to, x.channel, x.ok]), [["David", "email", true]]);
    } finally {
      process.env = saved;
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    assert.deepEqual(calls[0].body.to, ["david@example.com"]);
    assert.match(String(calls[0].body.html), /How Margaret did this week/);
    assert.ok(events.some((e) => e.kind === "weekly_summary"));
    assert.equal(store.notifications(new Date(0))[0].delivery, "email");
  });

  test("the schedule fires once, on the configured day and time", async () => {
    assert.deepEqual(parseWeekly("Sunday 18:30"), { day: 0, minutes: 1110 });
    assert.equal(parseWeekly("someday"), null);
    const { store, set } = clockStore();
    const { hub } = recorder();
    set(18, 30, 6); // Sunday 18 Oct
    assert.equal(await maybeSendWeekly(store, hub, "sun 19:00"), null, "too early");
    set(19, 1, 6);
    assert.ok(await maybeSendWeekly(store, hub, "sun 19:00"));
    set(19, 30, 6);
    assert.equal(await maybeSendWeekly(store, hub, "sun 19:00"), null, "already sent today");
  });
});

describe("over MCP: inbox, speaker identity, pushed events", () => {
  let base: string;
  let closeApp: () => Promise<void>;
  let http: ReturnType<ReturnType<typeof createApp>["app"]["listen"]>;
  let store: CareStore;
  let set: (h: number, m?: number) => void;
  const hub = new EventHub();

  before(async () => {
    ({ store, set } = clockStore());
    set(9, 0);
    const created = createApp(store, { hub, inboxToken: "inbox-secret" });
    closeApp = created.close;
    http = created.app.listen(0, "127.0.0.1");
    await new Promise((r) => http.once("listening", r));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  after(async () => {
    await closeApp();
    http.close();
  });

  async function connect() {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    return client;
  }
  const call = (client: Client, name: string, args: Record<string, unknown>, speaker?: string) =>
    client.request(
      { method: "tools/call", params: { name, arguments: args, ...(speaker ? { _meta: { "hearth/speaker": speaker } } : {}) } },
      CallToolResultSchema,
    );
  const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join(" ");
  const inbox = (body: string, type: string, token = "inbox-secret") =>
    fetch(`${base}/inbox/notes`, { method: "POST", headers: { "content-type": type, authorization: `Bearer ${token}` }, body });

  test("the care-team inbox needs its token, stores the note and tells the family", async () => {
    assert.equal((await inbox("hi", "text/plain", "wrong")).status, 401);
    const r = await inbox(JSON.stringify({ from: "Dr. Bennett's office", text: "Start the new eye drops twice a day from Monday." }), "application/json");
    assert.equal(r.status, 201);
    const note = store.unheardCareTeamNotes()[0];
    assert.equal(note.author, "Dr. Bennett's office");
    assert.equal(note.source, "care_team");
    assert.match(store.notifications(new Date(0))[0].message, /New note from Dr\. Bennett's office: Start the new eye drops/);
    // Inbound-email webhooks post forms: sender, subject and stripped-text.
    const mail = await inbox(new URLSearchParams({ sender: "Lakeside Eye Center <front@lakeside.example>", subject: "Appointment", "stripped-text": "Bring your current glasses." }).toString(), "application/x-www-form-urlencoded");
    assert.equal(mail.status, 201);
    assert.equal(store.unheardCareTeamNotes()[1].author, "Lakeside Eye Center");
    assert.equal(store.unheardCareTeamNotes()[1].text, "Appointment: Bring your current glasses.");
  });

  test("whats_due reads care-team notes, and only the care recipient hearing them clears them", async () => {
    const client = await connect();
    const bySarah = await call(client, "whats_due", {}, "Sarah");
    assert.match(textOf(bySarah), /New note from Dr\. Bennett's office: "Start the new eye drops/);
    assert.equal(store.unheardCareTeamNotes().length, 2, "Sarah hearing it doesn't count");
    await call(client, "whats_due", {}, "Margaret");
    assert.equal(store.unheardCareTeamNotes().length, 0);
    assert.doesNotMatch(textOf(await call(client, "whats_due", {}, "Margaret")), /New note/);
    await client.close();
  });

  test("_meta speaker sets who logged a dose, who reported a check-in, and who a message is from", async () => {
    const client = await connect();
    const dose = await call(client, "record_dose", { medication: "metformin" }, "David");
    assert.match(textOf(dose), /logged by David/);
    const msg = await call(client, "notify_family", { to: "Sarah", message: "Mom's fridge is full", confirmed: true }, "David");
    assert.equal((msg.structuredContent as { from: string }).from, "David");
    const check = await call(client, "log_checkin", { symptoms: "seemed tired", mood: 3 }, "Sarah");
    assert.equal((check.structuredContent as { reportedBy: string }).reportedBy, "Sarah");
    assert.match(store.checkIns(new Date(0)).at(-1)!.note, /Reported by Sarah/);
    // Unknown names are ignored rather than trusted.
    const odd = await call(client, "record_dose", { medication: "atorvastatin", status: "skipped" }, "Mallory");
    assert.doesNotMatch(textOf(odd), /logged by/);
    await client.close();
  });

  test("send_weekly_summary without elicitation needs confirmation, then emails David", async () => {
    const client = await connect();
    assert.match(textOf(await call(client, "send_weekly_summary", { to: "Sarah" })), /no email address on file/);
    assert.match(textOf(await call(client, "send_weekly_summary", { to: "David" })), /Not sent yet/);
    const r = await call(client, "send_weekly_summary", { to: "David", confirmed: true });
    assert.match(textOf(r), /Emailing the weekly summary to David/);
    await client.close();
  });

  test("reminders are pushed to connected clients as logging notifications", async () => {
    const client = await connect();
    const got = new Promise<{ logger?: string; data: unknown }>((resolve) =>
      client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
        if (n.params.logger === "hearth.dose_reminder") resolve(n.params);
      }),
    );
    await new Promise((r) => setTimeout(r, 100)); // let the standalone GET SSE stream open
    set(20, 31);
    runReminders(store, hub);
    const n = await got;
    assert.match((n.data as { spoken: string }).spoken, /Margaret/);
    await client.close();
  });
});
