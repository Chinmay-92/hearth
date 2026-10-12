// The Hearth MCP server definition: tools, resources and prompts over a shared
// CareStore. A fresh McpServer is created per MCP session (see app.ts) so each
// device/assistant gets its own elicitation channel, while all of them share
// the same household state.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { assessCheckIn, familyDigest, refillsNeeded, whatsDue } from "./insights.ts";
import { deliver } from "./notify.ts";
import { type CareStore, dayKey, type FamilyMember, type Notification } from "./store.ts";
import { DIGEST_UI_URI, digestAppHtml, MCP_APP_MIME } from "./ui/digest-app.ts";

export const SERVER_INFO = { name: "hearth", title: "Hearth — family caregiving co-pilot", version: "0.1.0" };

const INSTRUCTIONS = `Hearth helps a family care for an older relative through their voice assistant.
The person speaking is usually the care recipient (named in hearth://profile), but family members also use it.
Keep spoken replies short and warm. Never give medical advice beyond what the family has recorded; for emergencies, tell the person to call 911.
Typical flows: "did I take my pills?" -> whats_due; "I took my metformin" -> record_dose; "I slept badly and my knee hurts" -> log_checkin (then follow its suggestion);
"how's Mom doing this week?" -> family_digest; "tell Priya ..." -> notify_family; "I have a doctor's appointment Tuesday" -> schedule_appointment.`;

const text = (s: string) => ({ type: "text" as const, text: s });

function speakTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function speakDay(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

export function createHearthServer(store: CareStore): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: INSTRUCTIONS,
    capabilities: { logging: {} },
  });

  /** Ask the human a structured question if the client supports form elicitation. */
  async function ask(message: string, requestedSchema: Parameters<typeof server.server.elicitInput>[0] extends infer P
    ? P extends { requestedSchema: infer S } ? S : never : never): Promise<ElicitResult | null> {
    if (!server.server.getClientCapabilities()?.elicitation) return null;
    return server.server.elicitInput({ mode: "form", message, requestedSchema });
  }

  async function sendAlert(member: FamilyMember, urgency: Notification["urgency"], message: string, from: string) {
    const title = urgency === "urgent" ? `Urgent from ${store.requireProfile().household}` : `Hearth update from ${from}`;
    const d = await deliver(member, urgency, title, message);
    store.addNotification({ to: member.name, urgency, message, delivery: d.ok ? d.channel : `${d.channel} failed: ${d.detail}` });
    await server.sendLoggingMessage({
      level: urgency === "urgent" ? "warning" : "info",
      logger: "hearth.notify",
      data: { to: member.name, urgency, channel: d.channel, ok: d.ok },
    });
    return d;
  }

  // ---------------------------------------------------------------- tools

  server.registerTool(
    "whats_due",
    {
      title: "What's due",
      description:
        "Medications that are overdue, due now, or coming up in the next few hours, plus the next appointment and any refills running low. Use for 'did I take my pills?', 'what do I need to take?', 'what's on today?'.",
      inputSchema: { horizon_hours: z.number().int().min(1).max(24).default(4).describe("How far ahead to look.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ horizon_hours }): Promise<CallToolResult> => {
      const due = whatsDue(store, horizon_hours);
      const parts: string[] = [];
      const overdue = due.items.filter((i) => i.state === "overdue");
      const now = due.items.filter((i) => i.state === "due_now");
      const later = due.items.filter((i) => i.state === "upcoming");
      if (overdue.length) parts.push(`Overdue: ${overdue.map((i) => `${i.medication} ${i.dose} (was due ${speakTime(i.dueAt)})`).join(", ")}.`);
      if (now.length) parts.push(`Due now: ${now.map((i) => `${i.medication} ${i.dose}, ${i.instructions}`).join("; ")}.`);
      if (later.length) parts.push(`Coming up: ${later.map((i) => `${i.medication} at ${speakTime(i.dueAt)}`).join(", ")}.`);
      if (!due.items.length) parts.push(`Nothing is due in the next ${horizon_hours} hours. All caught up.`);
      if (due.nextAppointment) parts.push(`Next appointment: ${due.nextAppointment.title} on ${speakDay(due.nextAppointment.at)} at ${speakTime(due.nextAppointment.at)}.`);
      for (const r of due.refills) parts.push(`${r.medication} has about ${r.daysLeft} days left — time to refill.`);
      return { content: [text(parts.join(" "))], structuredContent: due };
    },
  );

  server.registerTool(
    "record_dose",
    {
      title: "Record a dose",
      description:
        "Record that a medication was taken or skipped. Matches the closest scheduled time today. Use when someone says 'I took my metformin' or 'I'm skipping the evening pill'.",
      inputSchema: {
        medication: z.string().describe("Medication name as spoken, e.g. 'metformin' or 'my blood pressure pill'."),
        status: z.enum(["taken", "skipped"]).default("taken"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ medication, status }): Promise<CallToolResult> => {
      let med = store.findMedication(medication);
      if (!med && /blood pressure/i.test(medication)) med = store.medications().find((m) => /blood pressure/i.test(m.instructions));
      if (!med) {
        const known = store.medications().map((m) => m.name).join(", ");
        return { isError: true, content: [text(`I don't have a medication called "${medication}". Known medications: ${known}.`)] };
      }
      const { slot, replaced } = store.recordDose(med, status);
      const after = store.findMedication(med.name)!;
      const refill = refillsNeeded(store).find((r) => r.medication === med.name);
      let msg = `Recorded ${med.name} ${med.dose} as ${status} for the ${speakTime(`${slot}:00`)} dose${replaced ? " (updated the earlier entry)" : ""}.`;
      if (refill) msg += ` Heads up: only ${after.pillsRemaining} left, about ${refill.daysLeft} days. Offer to remind the family to pick up a refill.`;
      return {
        content: [text(msg)],
        structuredContent: { medication: med.name, slot, status, pillsRemaining: after.pillsRemaining, refillSoon: Boolean(refill) },
      };
    },
  );

  server.registerTool(
    "log_checkin",
    {
      title: "Daily check-in",
      description:
        "Log how the care recipient is feeling: pain, mood, sleep and any symptoms in their own words. Hearth compares against their recent baseline and returns a concern level with a suggested next step. Always call this when someone describes how they feel.",
      inputSchema: {
        pain: z.number().int().min(0).max(10).optional().describe("Pain 0-10, if mentioned."),
        mood: z.number().int().min(1).max(5).optional().describe("Mood 1 (very low) to 5 (great), inferred from what they said."),
        sleep_hours: z.number().min(0).max(16).optional(),
        symptoms: z.string().default("").describe("Symptoms in the person's own words, e.g. 'knee hurts on the stairs, a bit dizzy'."),
        note: z.string().default(""),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args): Promise<CallToolResult> => {
      const entry = { pain: args.pain ?? null, mood: args.mood ?? null, sleepHours: args.sleep_hours ?? null, symptoms: args.symptoms, note: args.note };
      const concern = assessCheckIn(store, entry); // assess before inserting so the baseline excludes today
      const saved = store.addCheckIn(entry);
      const profile = store.requireProfile();
      let msg = `Check-in saved.`;
      if (concern.level !== "none") msg += ` Concern level: ${concern.level} (${concern.reasons.join("; ")}). ${concern.suggestion}`;

      // Urgent: proactively ask, right now, whether to alert the primary caregiver.
      let alerted: string | null = null;
      if (concern.level === "urgent") {
        const primary = profile.family[0];
        const answer = await ask(
          `${profile.recipient} mentioned ${concern.reasons.join(" and ")}. Should I alert ${primary.name} right away?`,
          {
            type: "object",
            properties: { alert: { type: "boolean", title: `Alert ${primary.name} now`, default: true } },
            required: ["alert"],
          },
        );
        if (answer?.action === "accept" && answer.content?.alert) {
          const d = await sendAlert(primary, "urgent", `${profile.recipient} reported: ${[entry.symptoms, entry.note].filter(Boolean).join(". ") || concern.reasons.join(", ")}. (via Hearth check-in)`, profile.recipient);
          alerted = primary.name;
          msg += d.ok ? ` ${primary.name} has been alerted.` : ` I tried to alert ${primary.name} but delivery failed; it is saved in the outbox.`;
        } else if (answer) {
          msg += ` They chose not to alert anyone right now.`;
        }
      }
      return { content: [text(msg)], structuredContent: { checkInId: saved.id, concern, alerted } };
    },
  );

  server.registerTool(
    "family_digest",
    {
      title: "Family digest",
      description:
        "A summary for family members of how the care recipient has been doing: medication adherence, pain/mood/sleep trends, flags worth attention, upcoming appointments, notes and alerts. On screen devices this renders as an interactive card.",
      inputSchema: { days: z.number().int().min(3).max(30).default(7) },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: DIGEST_UI_URI }, "ui/resourceUri": DIGEST_UI_URI },
    },
    async ({ days }): Promise<CallToolResult> => {
      const d = familyDigest(store, days);
      const lines = [
        `${d.recipient}'s last ${d.periodDays} days: medication adherence ${d.adherencePercent ?? "unknown"}%.`,
        d.flags.length ? `Worth attention: ${d.flags.join(" ")}` : "Nothing unusual.",
      ];
      if (d.upcomingAppointments[0]) lines.push(`Next: ${d.upcomingAppointments[0].title}, ${speakDay(d.upcomingAppointments[0].at)}.`);
      return { content: [text(lines.join(" "))], structuredContent: d };
    },
  );

  server.registerTool(
    "notify_family",
    {
      title: "Message the family",
      description:
        "Send a message to a family member (or everyone) by push notification. The person is asked to confirm before anything is sent. If the client cannot show a confirmation, read the message back, get a yes, and call again with confirmed=true.",
      inputSchema: {
        to: z.string().describe("Family member name or relation ('Priya', 'my son'), or 'everyone'."),
        message: z.string().min(1),
        urgency: z.enum(["info", "soon", "urgent"]).default("info"),
        from: z.string().optional().describe("Who is speaking, if known. Defaults to the care recipient."),
        confirmed: z.boolean().default(false).describe("Set true only after the person verbally confirmed, when elicitation is unavailable."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ to, message, urgency, from, confirmed }): Promise<CallToolResult> => {
      const profile = store.requireProfile();
      const sender = from ?? profile.recipient;
      const who = to.replace(/^my\s+/i, "");
      const recipients = /^(everyone|all|family|the family)$/i.test(who) ? profile.family : [store.findFamily(who)].filter((x): x is FamilyMember => !!x);
      if (!recipients.length) {
        return { isError: true, content: [text(`I don't know "${to}". Family on file: ${profile.family.map((f) => `${f.name} (${f.relation})`).join(", ")}.`)] };
      }
      const names = recipients.map((r) => r.name).join(" and ");
      let finalMessage = message;
      const answer = await ask(`Send this to ${names}? "${message}"`, {
        type: "object",
        properties: {
          send: { type: "boolean", title: `Send to ${names}`, default: true },
          message: { type: "string", title: "Message", default: message },
        },
        required: ["send"],
      });
      if (answer) {
        if (answer.action !== "accept" || !answer.content?.send) return { content: [text("Okay, I didn't send anything.")], structuredContent: { sent: false } };
        if (typeof answer.content.message === "string" && answer.content.message.trim()) finalMessage = answer.content.message.trim();
      } else if (!confirmed) {
        return {
          content: [text(`Not sent yet. Read this back and ask for a yes: "${message}" to ${names}. Then call notify_family again with confirmed=true.`)],
          structuredContent: { sent: false, needsConfirmation: true },
        };
      }
      const results = [];
      for (const r of recipients) results.push({ to: r.name, ...(await sendAlert(r, urgency, finalMessage, sender)) });
      const failed = results.filter((r) => !r.ok);
      return {
        content: [text(failed.length ? `Sent, but delivery to ${failed.map((f) => f.to).join(", ")} failed. It's saved in the outbox.` : `Sent to ${names}.`)],
        structuredContent: { sent: true, results },
      };
    },
  );

  server.registerTool(
    "schedule_appointment",
    {
      title: "Schedule an appointment",
      description:
        "Add a medical appointment. If a ride is needed, Hearth asks which family member will drive, records it, and notifies them. Resolve relative dates ('next Tuesday at 2') to an ISO 8601 local datetime before calling.",
      inputSchema: {
        title: z.string().describe("e.g. 'Eye exam'"),
        when: z.string().describe("ISO 8601 local datetime, e.g. 2026-10-20T14:00"),
        with_whom: z.string().default(""),
        location: z.string().default(""),
        needs_ride: z.boolean().default(true),
        driver: z.string().optional().describe("Family member who will drive, if already known."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ title, when, with_whom, location, needs_ride, driver }): Promise<CallToolResult> => {
      const at = new Date(when);
      if (Number.isNaN(at.getTime())) return { isError: true, content: [text(`"${when}" is not a date I can read. Use ISO 8601, e.g. 2026-10-20T14:00.`)] };
      const profile = store.requireProfile();
      let chosen = driver ? store.findFamily(driver) : undefined;
      if (needs_ride && !chosen) {
        const answer = await ask(`Who can drive ${profile.recipient} to "${title}" on ${speakDay(at.toISOString())} at ${speakTime(at.toISOString())}?`, {
          type: "object",
          properties: {
            driver: { type: "string", title: "Driver", oneOf: [...profile.family.map((f) => ({ const: f.name, title: `${f.name} (${f.relation})` })), { const: "none", title: "Not sure yet" }] },
          },
          required: ["driver"],
        });
        if (answer?.action === "accept" && typeof answer.content?.driver === "string" && answer.content.driver !== "none") chosen = store.findFamily(answer.content.driver);
      }
      const appt = store.addAppointment({ at: at.toISOString(), title, withWhom: with_whom, location, driver: chosen?.name ?? null });
      let msg = `Added ${title} on ${speakDay(appt.at)} at ${speakTime(appt.at)}.`;
      if (chosen) {
        await sendAlert(chosen, "soon", `You're driving ${profile.recipient} to ${title}${location ? ` at ${location}` : ""} on ${speakDay(appt.at)} at ${speakTime(appt.at)}.`, profile.recipient);
        msg += ` ${chosen.name} is driving and has been notified.`;
      } else if (needs_ride) {
        msg += ` No driver yet; I'll flag it in the family digest.`;
      }
      return { content: [text(msg)], structuredContent: { appointment: appt } };
    },
  );

  server.registerTool(
    "add_care_note",
    {
      title: "Add a care note",
      description: "Save a note for the whole family, e.g. instructions from a doctor visit or something the care recipient mentioned. Shows up in the family digest.",
      inputSchema: { text: z.string().min(1), author: z.string().optional().describe("Who is speaking. Defaults to the care recipient.") },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ text: body, author }): Promise<CallToolResult> => {
      const note = store.addNote(author ?? store.requireProfile().recipient, body);
      return { content: [text(`Saved the note for the family.`)], structuredContent: { note } };
    },
  );

  // ------------------------------------------------------------ resources

  server.registerResource(
    "profile",
    "hearth://profile",
    { title: "Care profile", description: "Who is being cared for, the family, and medication schedule.", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ ...store.requireProfile(), medications: store.medications() }, null, 2) }],
    }),
  );

  server.registerResource(
    "day-log",
    new ResourceTemplate("hearth://day/{date}", {
      list: undefined,
      complete: { date: () => [0, 1, 2, 3, 4, 5, 6].map((n) => dayKey(new Date(store.now().getTime() - n * 86_400_000))) },
    }),
    { title: "Day log", description: "Everything recorded on a given day (YYYY-MM-DD).", mimeType: "application/json" },
    async (uri, { date }) => {
      const start = new Date(`${date}T00:00:00`);
      const end = new Date(`${date}T23:59:59`);
      const inDay = (iso: string) => new Date(iso) >= start && new Date(iso) <= end;
      const body = {
        date,
        doses: store.slots(start, end).map((s) => ({ medication: s.med.name, due: s.due.toISOString(), status: s.status })),
        checkIns: store.checkIns(start).filter((c) => inDay(c.at)),
        notes: store.notes(start).filter((n) => inDay(n.at)),
        alerts: store.notifications(start).filter((n) => inDay(n.at)),
      };
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body, null, 2) }] };
    },
  );

  server.registerResource(
    "digest-app",
    DIGEST_UI_URI,
    { title: "Family digest card", description: "MCP App view for family_digest (Echo Show / web).", mimeType: MCP_APP_MIME },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: MCP_APP_MIME, text: digestAppHtml() }] }),
  );

  // -------------------------------------------------------------- prompts

  server.registerPrompt(
    "morning_checkin",
    { title: "Morning check-in", description: "A gentle morning routine: what's due, how they slept, how they feel." },
    () => ({
      messages: [
        {
          role: "user",
          content: text(
            `Run ${store.getProfile()?.recipient ?? "the care recipient"}'s morning check-in. First call whats_due and mention anything due now. Then ask, one question at a time, how they slept and how they're feeling. Log the answers with log_checkin and follow its suggestion. Keep each turn to one or two sentences.`,
          ),
        },
      ],
    }),
  );

  server.registerPrompt(
    "weekly_family_update",
    {
      title: "Weekly family update",
      description: "Summarize the week and send it to the family.",
      argsSchema: { to: z.string().default("everyone").describe("Who should receive the update.") },
    },
    ({ to }) => ({
      messages: [
        {
          role: "user",
          content: text(`Call family_digest for the last 7 days, write a warm 3-sentence update that leads with anything needing action, then send it with notify_family to ${to}.`),
        },
      ],
    }),
  );

  return server;
}
