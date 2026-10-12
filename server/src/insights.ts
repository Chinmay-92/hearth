// Pure-ish reasoning over the care store: what's due, how the week went, and
// whether something someone just said should worry the family.
import { type CareStore, type CheckIn, dayKey } from "./store.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A dose counts as overdue once it is this late with no record. */
export const OVERDUE_AFTER_MS = 90 * 60_000;

export type DueItem = {
  medication: string;
  dose: string;
  instructions: string;
  dueAt: string;
  state: "overdue" | "due_now" | "upcoming";
  minutesFromNow: number;
};

export function whatsDue(store: CareStore, horizonHours = 4) {
  const now = store.now();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const items: DueItem[] = [];
  for (const s of store.slots(startOfDay, new Date(now.getTime() + horizonHours * HOUR))) {
    if (s.status) continue;
    const delta = s.due.getTime() - now.getTime();
    const state = delta < -OVERDUE_AFTER_MS ? "overdue" : delta <= 30 * 60_000 ? "due_now" : "upcoming";
    items.push({
      medication: s.med.name,
      dose: s.med.dose,
      instructions: s.med.instructions,
      dueAt: s.due.toISOString(),
      state,
      minutesFromNow: Math.round(delta / 60_000),
    });
  }
  const nextAppointment = store.appointments(now, new Date(now.getTime() + 2 * DAY))[0] ?? null;
  return { now: now.toISOString(), items, nextAppointment, refills: refillsNeeded(store) };
}

export function refillsNeeded(store: CareStore, thresholdDays = 7) {
  return store
    .medications()
    .map((m) => {
      const perDay = m.times.length * m.pillsPerDose;
      const daysLeft = perDay ? Math.floor(m.pillsRemaining / perDay) : Infinity;
      return { medication: m.name, pillsRemaining: m.pillsRemaining, daysLeft };
    })
    .filter((r) => r.daysLeft <= thresholdDays)
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

// ---- concern assessment --------------------------------------------------

export type Concern = {
  level: "none" | "watch" | "urgent";
  reasons: string[];
  /** What the assistant should offer to do next, phrased for speech. */
  suggestion: string | null;
};

// Phrases an older adult might say to a voice assistant that warrant a human
// knowing quickly. Deliberately conservative: false positives cost a text
// message; false negatives cost much more.
const URGENT_PATTERNS: [RegExp, string][] = [
  [/\bchest (pain|tight|pressure)|heart (racing|pounding)/i, "chest pain or heart symptoms"],
  [/\b(fell|fall(en)?|tripped|slipped)\b/i, "a fall"],
  [/\b(can'?t|cannot|hard to) breathe|short(ness)? of breath/i, "trouble breathing"],
  [/\b(confus|disorient|don'?t know where)/i, "confusion"],
  [/\b(slurr|face (droop|numb)|arm (numb|weak))/i, "possible stroke signs"],
  [/\bblack ?out|faint(ed)?|passed out\b/i, "fainting"],
];

const WATCH_PATTERNS: [RegExp, string][] = [
  [/\bdizz(y|iness)|light-?headed/i, "dizziness"],
  [/\bnause|vomit|threw up/i, "nausea"],
  [/\b(not|haven'?t been) eating|no appetite/i, "poor appetite"],
  [/\blonely|sad|down\b|depress/i, "low mood"],
  [/\bswell(ing|en)\b/i, "swelling"],
];

export function assessCheckIn(store: CareStore, c: Pick<CheckIn, "pain" | "mood" | "sleepHours" | "symptoms" | "note">): Concern {
  const reasons: string[] = [];
  let level: Concern["level"] = "none";
  const text = `${c.symptoms} ${c.note}`;

  for (const [re, label] of URGENT_PATTERNS) if (re.test(text)) reasons.push(`mentioned ${label}`), (level = "urgent");
  for (const [re, label] of WATCH_PATTERNS) if (re.test(text)) reasons.push(`mentioned ${label}`), level === "none" && (level = "watch");

  const baseline = baselines(store, 7);
  if (c.pain != null) {
    if (c.pain >= 8) reasons.push(`pain is ${c.pain}/10`), (level = "urgent");
    else if (c.pain >= 6) reasons.push(`pain is ${c.pain}/10`), level === "none" && (level = "watch");
    if (baseline.pain != null && c.pain - baseline.pain >= 3) {
      reasons.push(`pain is ${(c.pain - baseline.pain).toFixed(1)} points above the 7-day average`);
      if (level === "none") level = "watch";
    }
  }
  if (c.mood != null && c.mood <= 2) reasons.push(`mood is ${c.mood}/5`), level === "none" && (level = "watch");
  if (c.sleepHours != null && c.sleepHours < 4) reasons.push(`only ${c.sleepHours}h of sleep`), level === "none" && (level = "watch");

  const missed = missedDoses(store, 2);
  if (missed.length >= 2) {
    reasons.push(`${missed.length} doses missed in the last 48 hours`);
    if (level === "none") level = "watch";
  }

  const profile = store.getProfile();
  const primary = profile?.family[0]?.name ?? "family";
  const suggestion =
    level === "urgent"
      ? `This sounds serious. Offer to alert ${primary} right now, and remind them to call 911 if it is an emergency.`
      : level === "watch"
        ? `Offer to let ${primary} know, or add it to tonight's family digest.`
        : null;
  return { level, reasons, suggestion };
}

function baselines(store: CareStore, days: number) {
  const recent = store.checkIns(new Date(store.now().getTime() - days * DAY));
  return {
    pain: avg(recent.map((c) => c.pain)),
    mood: avg(recent.map((c) => c.mood)),
    sleep: avg(recent.map((c) => c.sleepHours)),
  };
}

function avg(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export function missedDoses(store: CareStore, days: number) {
  const now = store.now();
  return store
    .slots(new Date(now.getTime() - days * DAY), new Date(now.getTime() - OVERDUE_AFTER_MS))
    .filter((s) => s.status !== "taken")
    .map((s) => ({ medication: s.med.name, dueAt: s.due.toISOString(), status: s.status ?? "missed" }));
}

// ---- family digest -------------------------------------------------------

export type DigestDay = {
  day: string;
  pain: number | null;
  mood: number | null;
  sleep: number | null;
  dosesTaken: number;
  dosesScheduled: number;
};

export function familyDigest(store: CareStore, days = 7) {
  const profile = store.requireProfile();
  const now = store.now();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));

  const byDay = new Map<string, DigestDay>();
  for (let d = new Date(from); d <= now; d.setDate(d.getDate() + 1)) {
    byDay.set(dayKey(d), { day: dayKey(d), pain: null, mood: null, sleep: null, dosesTaken: 0, dosesScheduled: 0 });
  }
  const checkIns = store.checkIns(from);
  for (const [k, row] of byDay) {
    const todays = checkIns.filter((c) => dayKey(new Date(c.at)) === k);
    row.pain = round1(avg(todays.map((c) => c.pain)));
    row.mood = round1(avg(todays.map((c) => c.mood)));
    row.sleep = round1(avg(todays.map((c) => c.sleepHours)));
  }
  // Only count slots that are already past their overdue window.
  for (const s of store.slots(from, new Date(now.getTime() - OVERDUE_AFTER_MS))) {
    const row = byDay.get(dayKey(s.due));
    if (!row) continue;
    row.dosesScheduled++;
    if (s.status === "taken") row.dosesTaken++;
  }
  const series = [...byDay.values()];
  const scheduled = series.reduce((a, r) => a + r.dosesScheduled, 0);
  const taken = series.reduce((a, r) => a + r.dosesTaken, 0);
  const adherence = scheduled ? Math.round((taken / scheduled) * 100) : null;

  const flags: string[] = [];
  const painTrend = trend(series.map((r) => r.pain));
  if (painTrend != null && painTrend >= 0.4) flags.push(`Pain has been rising (about +${painTrend.toFixed(1)} per day).`);
  const sleepTrend = trend(series.map((r) => r.sleep));
  if (sleepTrend != null && sleepTrend <= -0.3) flags.push("Sleep has been getting shorter.");
  const missed = missedDoses(store, days);
  const missedByMed = new Map<string, number>();
  for (const m of missed) missedByMed.set(m.medication, (missedByMed.get(m.medication) ?? 0) + 1);
  for (const [med, n] of missedByMed) if (n >= 2) flags.push(`${med} missed ${n} times this week.`);
  for (const r of refillsNeeded(store)) flags.push(`${r.medication} runs out in ${r.daysLeft} day${r.daysLeft === 1 ? "" : "s"}.`);
  const symptomMentions = checkIns.filter((c) => c.symptoms.trim()).map((c) => ({ at: c.at, symptoms: c.symptoms }));

  const upcoming = store.appointments(now, new Date(now.getTime() + 14 * DAY));
  for (const a of upcoming) if (!a.driver) flags.push(`No one is driving to "${a.title}" yet.`);

  return {
    recipient: profile.recipient,
    periodDays: days,
    generatedAt: now.toISOString(),
    adherencePercent: adherence,
    series,
    flags,
    symptomMentions: symptomMentions.slice(-5),
    upcomingAppointments: upcoming,
    recentNotes: store.notes(from).slice(0, 5),
    recentAlerts: store.notifications(from).slice(0, 5),
  };
}

function round1(x: number | null) {
  return x == null ? null : Math.round(x * 10) / 10;
}

/** Least-squares slope over the non-null points, in units per day. */
function trend(ys: (number | null)[]): number | null {
  const pts = ys.map((y, x) => [x, y] as const).filter((p): p is readonly [number, number] => p[1] != null);
  if (pts.length < 3) return null;
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n;
  const my = pts.reduce((a, p) => a + p[1], 0) / n;
  const num = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
  const den = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  return den ? num / den : null;
}
