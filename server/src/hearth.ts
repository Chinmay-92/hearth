// The Hearth MCP server definition: tools, resources and prompts over a shared
// CareStore. A fresh McpServer is created per MCP session (see app.ts) so each
// device/assistant gets its own elicitation channel, while all of them share
// the same household state.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ElicitResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { sendAlert as deliverAlert } from "./alerts.ts";
import { EventHub } from "./events.ts";
import { assessCheckIn, familyDigest, refillsNeeded, whatsDue } from "./insights.ts";
import { type CareStore, dayKey, type FamilyMember, type Notification } from "./store.ts";
import { sendWeeklySummary } from "./weekly.ts";
import { DIGEST_UI_URI, digestAppHtml, MCP_APP_MIME } from "./ui/digest-app.ts";

export const SERVER_INFO = { name: "hearth", title: "Hearth — family caregiving co-pilot", version: "0.1.0" };

const INSTRUCTIONS = `Hearth helps a family care for an older relative through their voice assistant.
The person speaking is usually the care recipient (named in hearth://profile), but family members also use it.
Keep spoken replies short and warm. Never give medical advice beyond what the family has recorded; for emergencies, tell the person to call 911.
Typical flows: "did I take my pills?" -> whats_due; "I took my metformin" -> record_dose; "I slept badly and my knee hurts" -> log_checkin (then follow its suggestion);
"how's Mom doing this week?" -> family_digest; "tell Sarah ..." -> notify_family; "I have a doctor's appointment Tuesday" -> schedule_appointment;
"send David the weekly summary" -> send_weekly_summary. whats_due also reads out new notes from the care team (e.g. the doctor's office), word for word.
Hearth knows who is speaking when the device was linked to a person (or the client passes _meta "hearth/speaker"); tools use it as the default sender or author.`;

/** Client-supplied speaker hint for devices shared by several people (e.g. the simulator's "Speaking:" switch). */
export const SPEAKER_META_KEY = "hearth/speaker";
type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const text = (s: string) => ({ type: "text" as const, text: s });

function speakTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function speakDay(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

export function createHearthServer(store: CareStore, hub: EventHub = new EventHub()): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: INSTRUCTIONS,
    capabilities: { logging: {} },
  });

  // Push things Hearth decides on its own (reminders, care-team notes, alerts) to
  // this client as logging notifications on its standalone SSE stream.
  const unsubscribe = hub.subscribe((e) => {
    const level = e.kind === "alert" && e.urgency === "urgent" ? "warning" : e.kind === "dose_reminder" ? "notice" : "info";
    void server.sendLoggingMessage({ level, logger: `hearth.${e.kind}`, data: e }).catch(() => {});
  });
  server.server.onclose = unsubscribe;
  // Catch a newly connected screen up on recent reminders and notes, once its
  // standalone SSE stream (opened right after initialization) is likely up.
  server.server.oninitialized = () => {
    const missed = hub.recent();
    if (missed.length) {
      setTimeout(() => {
        for (const e of missed) void server.sendLoggingMessage({ level: "info", logger: `hearth.${e.kind}`, data: { ...e, replay: true } }).catch(() => {});
      }, 500).unref();
    }
  };

  /**
   * Who is speaking: the person the Alexa was linked to (OAuth), else the
   * client's _meta hint. Returns null when unknown (a shared device).
   */
  function speakerOf(extra: Extra): string | null {
    const linked = (extra.authInfo?.extra as { member?: unknown } | undefined)?.member;
    const hinted = extra._meta?.[SPEAKER_META_KEY];
    const name = typeof linked === "string" && linked ? linked : typeof hinted === "string" ? hinted : null;
    if (!name) return null;
    const profile = store.requireProfile();
    if (name.toLowerCase() === profile.recipient.toLowerCase()) return profile.recipient;
    return store.findFamily(name)?.name ?? null;
  }

  /**
   * Ask the human a structured question if the client supports form elicitation.
   * The request rides on the tool call's own SSE response stream (relatedRequestId),
   * not the standalone GET stream, so it reaches the device that asked.
   */
  async function ask(extra: Extra, message: string, requestedSchema: Parameters<typeof server.server.elicitInput>[0] extends infer P
    ? P extends { requestedSchema: infer S } ? S : never : never): Promise<ElicitResult | null> {
    if (!server.server.getClientCapabilities()?.elicitation) return null;
    return server.server.elicitInput({ mode: "form", message, requestedSchema }, { relatedRequestId: extra.requestId });
  }

  const sendAlert = (member: FamilyMember, urgency: Notification["urgency"], message: string, from: string) =>
    deliverAlert(store, hub, member, urgency, message, from);

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
    async ({ horizon_hours }, extra): Promise<CallToolResult> => {
      const due = whatsDue(store, horizon_hours);
      const parts: string[] = [];
      const speaker = speakerOf(extra);
      const recipient = store.requireProfile().recipient;
      const careTeam = store.unheardCareTeamNotes();
      const overdue = due.items.filter((i) => i.state === "overdue");
      const now = due.items.filter((i) => i.state === "due_now");
      const later = due.items.filter((i) => i.state === "upcoming");
      if (overdue.length) parts.push(`Overdue: ${overdue.map((i) => `${i.medication} ${i.dose} (was due ${speakTime(i.dueAt)})`).join(", ")}.`);
      if (now.length) parts.push(`Due now: ${now.map((i) => `${i.medication} ${i.dose}, ${i.instructions}`).join("; ")}.`);
      if (later.length) parts.push(`Coming up: ${later.map((i) => `${i.medication} at ${speakTime(i.dueAt)}`).join(", ")}.`);
      if (!due.items.length) parts.push(`Nothing is due in the next ${horizon_hours} hours. All caught up.`);
      if (due.nextAppointment) parts.push(`Next appointment: ${due.nextAppointment.title} on ${speakDay(due.nextAppointment.at)} at ${speakTime(due.nextAppointment.at)}.`);
      for (const r of due.refills) parts.push(`${r.medication} has about ${r.daysLeft} days left — time to refill.`);
      for (const n of careTeam) parts.push(`New note from ${n.author}: "${n.text}" Read this to them word for word.`);
      // Only the care recipient hearing it counts as heard.
      if (careTeam.length && speaker === recipient) store.markNotesHeard(careTeam.map((n) => n.id));
      return { content: [text(parts.join(" "))], structuredContent: { ...due, careTeamNotes: careTeam.map(({ id, at, author, text }) => ({ id, at, author, text })) } };
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
    async ({ medication, status }, extra): Promise<CallToolResult> => {
      const speaker = speakerOf(extra);
      const loggedBy = speaker && speaker !== store.requireProfile().recipient ? speaker : null;
      let med = store.findMedication(medication);
      if (!med && /blood pressure/i.test(medication)) med = store.medications().find((m) => /blood pressure/i.test(m.instructions));
      if (!med) {
        const known = store.medications().map((m) => m.name).join(", ");
        return { isError: true, content: [text(`I don't have a medication called "${medication}". Known medications: ${known}.`)] };
      }
      const { slot, replaced } = store.recordDose(med, status);
      const after = store.findMedication(med.name)!;
      const refill = refillsNeeded(store).find((r) => r.medication === med.name);
      let msg = `Recorded ${med.name} ${med.dose} as ${status} for the ${speakTime(`${slot}:00`)} dose${replaced ? " (updated the earlier entry)" : ""}${loggedBy ? `, logged by ${loggedBy}` : ""}.`;
      if (refill) msg += ` Heads up: only ${after.pillsRemaining} left, about ${refill.daysLeft} days. Offer to remind the family to pick up a refill.`;
      return {
        content: [text(msg)],
        structuredContent: { medication: med.name, slot, status, pillsRemaining: after.pillsRemaining, refillSoon: Boolean(refill), loggedBy },
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
    async (args, extra): Promise<CallToolResult> => {
      const speaker = speakerOf(extra);
      const reporter = speaker && speaker !== store.requireProfile().recipient ? speaker : null;
      const note = reporter ? [`Reported by ${reporter}.`, args.note].filter(Boolean).join(" ") : args.note;
      const entry = { pain: args.pain ?? null, mood: args.mood ?? null, sleepHours: args.sleep_hours ?? null, symptoms: args.symptoms, note };
      const concern = assessCheckIn(store, entry); // assess before inserting so the baseline excludes today
      const saved = store.addCheckIn(entry);
      const profile = store.requireProfile();
      let msg = `Check-in saved.`;
      if (concern.level !== "none") msg += ` Concern level: ${concern.level} (${concern.reasons.join("; ")}). ${concern.suggestion}`;

      // Urgent: proactively ask, right now, whether to alert the primary caregiver.
      let alerted: string | null = null;
      if (concern.level === "urgent") {
        // If the primary caregiver is the one reporting it, ask about the next person instead.
        const primary = profile.family.find((f) => f.name !== reporter) ?? profile.family[0];
        const answer = await ask(
          extra,
          `From ${profile.recipient}'s check-in: ${concern.reasons.join("; ")}. Should I alert ${primary.name} right away?`,
          {
            type: "object",
            properties: { alert: { type: "boolean", title: `Alert ${primary.name} now`, default: true } },
            required: ["alert"],
          },
        );
        if (answer?.action === "accept" && answer.content?.alert) {
          sendAlert(primary, "urgent", `${profile.recipient} reported: ${[entry.symptoms, entry.note].filter(Boolean).join(". ") || concern.reasons.join(", ")}. (via Hearth check-in)`, profile.recipient);
          alerted = primary.name;
          msg += ` ${primary.name} has been alerted.`;
        } else if (answer) {
          msg += ` They chose not to alert anyone right now.`;
        }
      }
      return { content: [text(msg)], structuredContent: { checkInId: saved.id, concern, alerted, reportedBy: reporter } };
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
      _meta: {
        ui: { resourceUri: DIGEST_UI_URI, invoking: "Pulling together the family digest…", invoked: "Here's how things have been going" },
        "ui/resourceUri": DIGEST_UI_URI,
      },
    },
    async ({ days }): Promise<CallToolResult> => {
      const d = familyDigest(store, days);
      const lines = [
        `${d.recipient}'s last ${d.periodDays} days: medication adherence ${d.adherencePercent ?? "unknown"}%.`,
        d.flags.length ? `Worth attention: ${d.flags.join(" ")}` : "Nothing unusual.",
      ];
      const next = d.upcomingAppointments[0];
      if (next) lines.push(`Next: ${next.title}, ${speakDay(next.at)}${next.driver ? `, ${next.driver} driving` : " (appointment_id " + next.id + ", needs a driver)"}.`);
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
        to: z.string().describe("Family member name or relation ('Sarah', 'my son'), or 'everyone'."),
        message: z.string().min(1),
        urgency: z.enum(["info", "soon", "urgent"]).default("info"),
        from: z.string().optional().describe("Who is speaking, if known. Defaults to the linked speaker, then the care recipient."),
        confirmed: z.boolean().default(false).describe("Set true only after the person verbally confirmed, when elicitation is unavailable."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ to, message, urgency, from, confirmed }, extra): Promise<CallToolResult> => {
      const profile = store.requireProfile();
      const sender = from ?? speakerOf(extra) ?? profile.recipient;
      const who = to.replace(/^my\s+/i, "");
      const recipients = /^(everyone|all|family|the family)$/i.test(who) ? profile.family : [store.findFamily(who)].filter((x): x is FamilyMember => !!x);
      if (!recipients.length) {
        return { isError: true, content: [text(`I don't know "${to}". Family on file: ${profile.family.map((f) => `${f.name} (${f.relation})`).join(", ")}.`)] };
      }
      const names = recipients.map((r) => r.name).join(" and ");
      let finalMessage = message;
      const answer = await ask(extra, `Send this to ${names}? "${message}"`, {
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
      const results = recipients.map((r) => ({ to: r.name, notificationId: sendAlert(r, urgency, finalMessage, sender).id }));
      return { content: [text(`Sent to ${names}.`)], structuredContent: { sent: true, from: sender, results } };
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
    async ({ title, when, with_whom, location, needs_ride, driver }, extra): Promise<CallToolResult> => {
      const at = new Date(when);
      if (Number.isNaN(at.getTime())) return { isError: true, content: [text(`"${when}" is not a date I can read. Use ISO 8601, e.g. 2026-10-20T14:00.`)] };
      const profile = store.requireProfile();
      let chosen = driver ? store.findFamily(driver) : undefined;
      if (needs_ride && !chosen) {
        const answer = await ask(extra, `Who can drive ${profile.recipient} to "${title}" on ${speakDay(at.toISOString())} at ${speakTime(at.toISOString())}?`, {
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
        sendAlert(chosen, "soon", `You're driving ${profile.recipient} to ${title}${location ? ` at ${location}` : ""} on ${speakDay(appt.at)} at ${speakTime(appt.at)}.`, profile.recipient);
        msg += ` ${chosen.name} is driving and has been notified.`;
      } else if (needs_ride) {
        const options = profile.family.map((f) => `${f.name} (${f.relation})`).join(" or ");
        msg += ` It still needs a driver. Ask whether ${options} can drive, then call assign_driver with appointment_id ${appt.id}.`;
      }
      return { content: [text(msg)], structuredContent: { appointment: appt } };
    },
  );

  server.registerTool(
    "assign_driver",
    {
      title: "Assign a driver",
      description:
        "Set which family member is driving to an upcoming appointment and notify them. Use after schedule_appointment says a driver is needed, or when someone says 'I'll take Mom to her appointment'.",
      inputSchema: {
        driver: z.string().describe("Family member name or relation, e.g. 'David' or 'my son'."),
        appointment_id: z.number().int().optional().describe("From schedule_appointment or family_digest. If omitted, the next appointment without a driver."),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ driver, appointment_id }): Promise<CallToolResult> => {
      const profile = store.requireProfile();
      const member = store.findFamily(driver.replace(/^my\s+/i, ""));
      if (!member) return { isError: true, content: [text(`I don't know "${driver}". Family on file: ${profile.family.map((f) => f.name).join(", ")}.`)] };
      const upcoming = store.appointments(store.now(), new Date(store.now().getTime() + 60 * 86_400_000));
      const appt = appointment_id != null ? upcoming.find((a) => a.id === appointment_id) : upcoming.find((a) => !a.driver);
      if (!appt) return { isError: true, content: [text("I couldn't find an upcoming appointment that needs a driver.")] };
      store.setAppointmentDriver(appt.id, member.name);
      sendAlert(member, "soon", `You're driving ${profile.recipient} to ${appt.title}${appt.location ? ` at ${appt.location}` : ""} on ${speakDay(appt.at)} at ${speakTime(appt.at)}.`, profile.recipient);
      return {
        content: [text(`${member.name} is driving to ${appt.title} on ${speakDay(appt.at)} and has been notified.`)],
        structuredContent: { appointment: { ...appt, driver: member.name } },
      };
    },
  );

  server.registerTool(
    "add_care_note",
    {
      title: "Add a care note",
      description: "Save a note for the whole family, e.g. instructions from a doctor visit or something the care recipient mentioned. Shows up in the family digest.",
      inputSchema: { text: z.string().min(1), author: z.string().optional().describe("Who is speaking. Defaults to the linked speaker, then the care recipient.") },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ text: body, author }, extra): Promise<CallToolResult> => {
      const note = store.addNote(author ?? speakerOf(extra) ?? store.requireProfile().recipient, body);
      return { content: [text(`Saved the note for the family.`)], structuredContent: { note } };
    },
  );

  server.registerTool(
    "send_weekly_summary",
    {
      title: "Send the weekly summary",
      description:
        "Email the weekly family summary (adherence, trends, flags, appointments, notes) to family members who have an email address on file, for those without an Echo. Asks for confirmation first. It is also sent automatically once a week if configured.",
      inputSchema: {
        to: z.string().default("everyone").describe("Family member name or relation, or 'everyone'."),
        confirmed: z.boolean().default(false).describe("Set true only after the person verbally confirmed, when elicitation is unavailable."),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ to, confirmed }, extra): Promise<CallToolResult> => {
      const profile = store.requireProfile();
      const who = to.replace(/^my\s+/i, "");
      const chosen = /^(everyone|all|family|the family)$/i.test(who) ? profile.family : [store.findFamily(who)].filter((x): x is FamilyMember => !!x);
      if (!chosen.length) return { isError: true, content: [text(`I don't know "${to}". Family on file: ${profile.family.map((f) => f.name).join(", ")}.`)] };
      const withEmail = chosen.filter((m) => m.email);
      if (!withEmail.length) {
        return { isError: true, content: [text(`${chosen.map((m) => m.name).join(" and ")} ${chosen.length > 1 ? "have" : "has"} no email address on file. Add one to the profile first.`)] };
      }
      const names = withEmail.map((m) => m.name).join(" and ");
      const answer = await ask(extra, `Email this week's summary of ${profile.recipient} to ${names}?`, {
        type: "object",
        properties: { send: { type: "boolean", title: `Email ${names}`, default: true } },
        required: ["send"],
      });
      if (answer) {
        if (answer.action !== "accept" || !answer.content?.send) return { content: [text("Okay, I didn't send it.")], structuredContent: { sent: false } };
      } else if (!confirmed) {
        return {
          content: [text(`Not sent yet. Ask: "Email this week's summary to ${names}?" Then call send_weekly_summary again with confirmed=true.`)],
          structuredContent: { sent: false, needsConfirmation: true },
        };
      }
      // Rendering is instant; delivery runs in the background to stay inside Alexa+'s latency budget.
      const pending = sendWeeklySummary(store, hub, withEmail);
      pending.catch((err) => console.error("weekly summary:", err));
      const { subject } = await Promise.race([pending, new Promise<{ subject: string }>((r) => setTimeout(() => r({ subject: "" }), 300))]);
      return {
        content: [text(`Emailing the weekly summary to ${names}.`)],
        structuredContent: { sent: true, to: withEmail.map((m) => m.name), subject: subject || null },
      };
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
