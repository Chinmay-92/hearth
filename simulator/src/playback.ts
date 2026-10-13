// Scripted playback: a stand-in for the Claude agent loop when no API key is
// available (HEARTH_PLAYBACK=1). Each demo line maps to the tool calls a model
// would make. Those calls go to the real Hearth MCP server, so the trace,
// elicitation prompts and MCP App card are all real. Only the choice of tools
// and the wording of the spoken reply are pre-written, and the reply is built
// from the tool's actual structured result.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { type AgentEvent, runMcpTool } from "./agent.ts";

type Call = (name: string, args: Record<string, unknown>) => Promise<Record<string, any> | undefined>;
type Line = { match: RegExp; run: (m: RegExpMatchArray, speaker: string, call: Call) => Promise<string> };

const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(":00", "");
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "long" });
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function nextWeekday(target: number, hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() + (((target - d.getDay() + 7) % 7) || 7));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00`;
}

const LINES: Line[] = [
  {
    match: /did i take my pills|what('s| is) due|what do i need to take/i,
    async run(_m, _who, call) {
      const due = await call("whats_due", { horizon_hours: 4 });
      if (!due) return "Sorry, I couldn't check your medications just now.";
      const overdue = due.items.filter((i: any) => i.state === "overdue");
      const now = due.items.filter((i: any) => i.state === "due_now");
      let say = overdue.length
        ? `Not yet. Your ${list(overdue.map((i: any) => i.medication.toLowerCase()))} ${overdue.length > 1 ? "were" : "was"} due at ${time(overdue[0].dueAt)}.`
        : now.length
          ? `It's time for your ${list(now.map((i: any) => i.medication.toLowerCase()))} now.`
          : "You're all caught up, nothing is due right now.";
      const meds = [...overdue, ...now];
      if (meds.some((i: any) => /food/.test(i.instructions))) say += " Remember to take the metformin with food.";
      return say;
    },
  },
  {
    match: /(?:just )?took my (.+)/i,
    async run(m, _who, call) {
      const names = m[1].replace(/[.!]$/, "").split(/\s*(?:,|\band\b)\s*/i).filter(Boolean);
      const done: string[] = [];
      let low: Record<string, any> | undefined;
      for (const medication of names) {
        const r = await call("record_dose", { medication, status: "taken" });
        if (r) done.push(r.medication.toLowerCase());
        if (r?.refillSoon) low = r;
      }
      let say = done.length ? `Got it, I've logged your ${list(done)}.` : "Sorry, I didn't catch which medication.";
      if (low) say += ` Heads up: you have ${low.pillsRemaining} ${low.medication.toLowerCase()} left. Want me to ask Priya to pick up a refill?`;
      return say;
    },
  },
  {
    match: /tripped|fell|dizzy|chest pain/i,
    async run(m, _who, call) {
      const r = await call("log_checkin", { symptoms: m.input!.replace(/^i\s+/i, "").replace(/[.!]$/, ""), mood: 2 });
      if (r?.alerted) return `I've let ${r.alerted} know. Please sit down somewhere safe for a few minutes. If you hit your head or the dizziness gets worse, call 911.`;
      if (r?.concern?.level === "urgent") return "Okay, I won't alert anyone. Please sit down and rest, and if the dizziness gets worse, call 911.";
      return "I've noted that. Please take it easy.";
    },
  },
  {
    match: /(\w+) (?:can|will) (?:drive|take)|needs a driver/i,
    async run(m, _who, call) {
      const driver = m[1] && !/appointment/i.test(m[1]) ? m[1] : "Raj";
      const r = await call("assign_driver", { driver });
      const a = r?.appointment;
      return a ? `Okay, ${a.driver} is driving to the ${a.title.replace(/\s*\(.*\)/, "").toLowerCase()} on ${day(a.at)}, and I've let ${a.driver} know.` : "I couldn't find an appointment that needs a driver.";
    },
  },
  {
    match: /slept|knee|hurts|pain|feeling/i,
    async run(m, _who, call) {
      const pain = Number(m.input!.match(/\b(?:maybe |about |a )?(\d{1,2})\b/)?.[1]);
      const sleep = /slept badly|didn't sleep|poorly/i.test(m.input!) ? 5 : undefined;
      const r = await call("log_checkin", {
        ...(Number.isFinite(pain) ? { pain } : {}),
        ...(sleep ? { sleep_hours: sleep } : {}),
        mood: 3,
        symptoms: m.input!.replace(/^i\s+/i, "").replace(/[.!]$/, ""),
      });
      const c = r?.concern;
      if (c && c.level !== "none") return "I'm sorry, that sounds rough. I've logged it, and your knee pain is higher than usual. Want me to let Priya know, or just add it to tonight's family update?";
      return "Thanks, I've logged your check-in. I hope the knee eases up today.";
    },
  },
  {
    match: /how('s| has| is) (mom|asha)|doing this week|weekly update/i,
    async run(_m, _who, call) {
      const d = await call("family_digest", { days: 7 });
      if (!d) return "Sorry, I couldn't pull the digest together.";
      const next = d.upcomingAppointments?.find((a: any) => !a.driver);
      let say = `${d.recipient} took ${d.adherencePercent}% of her doses this week.`;
      const flags: string = (d.flags ?? []).join(" ");
      const notes = [/Pain has been rising/.test(flags) && "her knee pain has been creeping up", /missed/.test(flags) && "she's missed a few evening pills"].filter(Boolean);
      if (notes.length) say += ` ${cap(list(notes as string[]))}.`;
      if (next) say += ` Her ${next.title.replace(/\s*\(.*\)/, "").toLowerCase()} on ${day(next.at)} still needs a driver.`;
      return say;
    },
  },
  {
    match: /eye exam|book|schedule/i,
    async run(_m, _who, call) {
      const r = await call("schedule_appointment", {
        title: "Eye exam",
        when: nextWeekday(2, 14),
        with_whom: "Dr. Okafor",
        location: "Lakeside Eye Center",
        needs_ride: true,
      });
      const a = r?.appointment;
      if (!a) return "Sorry, I couldn't book that.";
      return a.driver
        ? `Done. The eye exam is on ${day(a.at)} at ${time(a.at)}, and ${a.driver} is driving. I've let ${a.driver} know.`
        : `I've added the eye exam on ${day(a.at)} at ${time(a.at)}. It still needs a driver.`;
    },
  },
  {
    match: /^(?:tell|message|text) (\w+) (?:that )?(.+)/i,
    async run(m, who, call) {
      const r = await call("notify_family", { to: m[1], message: cap(m[2].replace(/[.!]$/, "")) + "!", from: who });
      return r?.sent ? `Sent. ${cap(m[1])} will get it as a notification.` : "Okay, I didn't send anything.";
    },
  },
];

export class PlaybackSimulator {
  private tools: Map<string, McpTool> | undefined;
  private mcp: Client;

  constructor(mcp: Client) {
    this.mcp = mcp;
  }

  reset() {}

  async turn(utterance: string, speaker: string, emit: (e: AgentEvent) => void): Promise<void> {
    if (!this.tools) this.tools = new Map((await this.mcp.listTools()).tools.map((t) => [t.name, t]));
    const text = utterance.replace(/^alexa,?\s*/i, "").trim();
    const call: Call = async (name, args) => {
      const r = await runMcpTool(this.mcp, this.tools, name, args, emit);
      return r.isError ? undefined : ((r.result as CallToolResult | undefined)?.structuredContent as Record<string, any> | undefined);
    };
    for (const line of LINES) {
      const m = text.match(line.match);
      if (m) return emit({ type: "say", text: await line.run(m, speaker, call) });
    }
    emit({ type: "say", text: "I'm running in scripted demo mode, so I only know the demo lines. Try one of the suggestions below." });
  }
}
