// Things Hearth does on its own clock:
//   - Overdue-dose reminders. 30 minutes after a dose is due with nothing
//     logged, the care recipient gets a gentle reminder (on every connected
//     Hearth screen, and on her own phone if `recipientNotify` is set). If it's
//     still not logged 3 hours after it was due, the primary family member is
//     told. Nothing is sent during quiet hours, and each stage fires once.
//   - The weekly summary email, at a configured day and time.
import { sendAlert } from "./alerts.ts";
import type { EventHub } from "./events.ts";
import { deliver } from "./notify.ts";
import { type CareStore, dayKey } from "./store.ts";
import { sendWeeklySummary } from "./weekly.ts";

const MIN = 60_000;
export const REMIND_AFTER_MS = 30 * MIN;
export const ESCALATE_AFTER_MS = 3 * 60 * MIN;

export type SchedulerOptions = {
  /** Quiet hours as [startHour, endHour) in local time; default 21:00–08:00. */
  quietHours?: [number, number];
  /** "sun 18:00" style; null disables the weekly email. */
  weekly?: string | null;
};

const speakTime = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(":00", "");
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

function isQuiet(now: Date, [start, end]: [number, number]) {
  const h = now.getHours();
  return start > end ? h >= start || h < end : h >= start && h < end;
}

/** One pass of the reminder rules. Returns what fired (for tests and logs). */
export function runReminders(store: CareStore, hub: EventHub, opts: SchedulerOptions = {}) {
  const fired: { stage: 1 | 2; medications: string[]; dueAt: string }[] = [];
  const profile = store.getProfile();
  const now = store.now();
  if (!profile || isQuiet(now, opts.quietHours ?? [21, 8])) return fired;

  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Group unlogged doses by their due time so "lisinopril and metformin" is one reminder.
  const groups = new Map<string, { due: Date; meds: { id: number; name: string; slot: string }[] }>();
  for (const s of store.slots(startOfDay, now)) {
    if (s.status) continue;
    const g = groups.get(s.slot.slice(11)) ?? { due: s.due, meds: [] };
    g.meds.push({ id: s.med.id, name: s.med.name, slot: s.slot });
    groups.set(s.slot.slice(11), g);
  }

  for (const { due, meds } of groups.values()) {
    const late = now.getTime() - due.getTime();
    const names = meds.map((m) => m.name.toLowerCase());
    for (const stage of [1, 2] as const) {
      if (late < (stage === 1 ? REMIND_AFTER_MS : ESCALATE_AFTER_MS)) continue;
      // Claim every med in the group; skip if they were all reminded already.
      const claimed = meds.filter((m) => store.claimReminder(m.id, m.slot, stage));
      if (!claimed.length) continue;
      const these = claimed.map((m) => m.name.toLowerCase());
      // Starting up long after a dose (e.g. after a restart): skip straight to telling the family.
      if (stage === 1 && late >= ESCALATE_AFTER_MS) continue;
      if (stage === 1) {
        const spoken = `${profile.recipient}, it's past time for your ${speakTime(due)} ${list(these)}. Did you take ${these.length > 1 ? "them" : "it"}?`;
        hub.emit({ kind: "dose_reminder", stage, medications: these, dueAt: due.toISOString(), spoken });
        store.addNotification({ to: profile.recipient, urgency: "info", message: `Reminder: ${list(these)} due at ${speakTime(due)}`, delivery: profile.recipientNotify ? "sending" : "screen" });
        if (profile.recipientNotify) {
          void deliver({ name: profile.recipient, relation: "self", notify: profile.recipientNotify }, "soon", "Medication reminder", spoken);
        }
      } else {
        const primary = profile.family[0];
        if (!primary) continue;
        const spoken = `${profile.recipient} hasn't logged her ${speakTime(due)} ${list(these)} yet, and it's been ${Math.floor(late / (60 * MIN))} hours.`;
        hub.emit({ kind: "dose_reminder", stage, medications: these, dueAt: due.toISOString(), spoken });
        sendAlert(store, hub, primary, "soon", spoken, "Hearth");
      }
      fired.push({ stage, medications: names.filter((n) => these.includes(n)), dueAt: due.toISOString() });
    }
  }
  return fired;
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Parses "sun 18:00" into a day index and minutes after midnight. */
export function parseWeekly(spec: string): { day: number; minutes: number } | null {
  const m = spec.trim().toLowerCase().match(/^([a-z]{3})[a-z]*\s+(\d{1,2}):(\d{2})$/);
  if (!m || !DAYS.includes(m[1])) return null;
  return { day: DAYS.indexOf(m[1]), minutes: Number(m[2]) * 60 + Number(m[3]) };
}

/** Sends the weekly summary once per week, at or after the configured time. */
export async function maybeSendWeekly(store: CareStore, hub: EventHub, spec: string, fetchImpl?: typeof fetch) {
  const when = parseWeekly(spec);
  const now = store.now();
  if (!when || now.getDay() !== when.day || now.getHours() * 60 + now.getMinutes() < when.minutes) return null;
  const key = dayKey(now);
  if (store.getKv("weekly_summary_sent") === key || !store.getProfile()) return null;
  store.setKv("weekly_summary_sent", key);
  return sendWeeklySummary(store, hub, undefined, fetchImpl);
}

export function startScheduler(store: CareStore, hub: EventHub, opts: SchedulerOptions & { intervalMs?: number; reminders?: boolean } = {}) {
  const tick = () => {
    try {
      if (opts.reminders !== false) for (const f of runReminders(store, hub, opts)) console.log(`reminder stage ${f.stage}: ${f.medications.join(", ")} due ${f.dueAt}`);
      if (opts.weekly) void maybeSendWeekly(store, hub, opts.weekly).then((r) => r && console.log(`weekly summary sent: ${r.subject}`));
    } catch (err) {
      console.error("scheduler:", err);
    }
  };
  const first = setTimeout(tick, 2000);
  const timer = setInterval(tick, opts.intervalMs ?? MIN);
  timer.unref();
  first.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
