// Persistent household care state. One SQLite file is shared by every MCP
// session, so what Mom tells Alexa in the kitchen at 8am is what her daughter
// sees when she asks for the family digest from another city at 9pm.
import { DatabaseSync } from "node:sqlite";

export type FamilyMember = {
  name: string;
  relation: string;
  /** ntfy.sh topic, webhook URL, or omitted for outbox-only delivery. */
  notify?: string;
};

export type Profile = {
  recipient: string;
  household: string;
  family: FamilyMember[];
  emergencyContact: string;
};

export type Medication = {
  id: number;
  name: string;
  dose: string;
  times: string[]; // "HH:MM", local time
  pillsRemaining: number;
  pillsPerDose: number;
  instructions: string;
};

export type DoseStatus = "taken" | "skipped";

export type CheckIn = {
  id: number;
  at: string;
  mood: number | null; // 1-5
  sleepHours: number | null;
  pain: number | null; // 0-10
  symptoms: string;
  note: string;
};

export type Appointment = {
  id: number;
  at: string;
  title: string;
  withWhom: string;
  location: string;
  driver: string | null;
};

export type Notification = {
  id: number;
  at: string;
  to: string;
  urgency: "info" | "soon" | "urgent";
  message: string;
  delivery: string;
};

export type CareNote = { id: number; at: string; author: string; text: string };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS medications (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, dose TEXT NOT NULL, times TEXT NOT NULL,
  pills_remaining INTEGER NOT NULL, pills_per_dose INTEGER NOT NULL DEFAULT 1,
  instructions TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS doses (
  id INTEGER PRIMARY KEY, med_id INTEGER NOT NULL REFERENCES medications(id),
  slot TEXT NOT NULL, status TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(med_id, slot));
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, mood INTEGER, sleep_hours REAL, pain INTEGER,
  symptoms TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, at TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, title TEXT NOT NULL, with_whom TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '', driver TEXT);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, to_whom TEXT NOT NULL, urgency TEXT NOT NULL,
  message TEXT NOT NULL, delivery TEXT NOT NULL);
`;

/** Local "YYYY-MM-DD" for a date. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Slot key identifying one scheduled dose, e.g. "2026-10-12T08:00". */
export function slotKey(d: Date, time: string): string {
  return `${dayKey(d)}T${time}`;
}

export function slotDate(slot: string): Date {
  return new Date(`${slot}:00`);
}

type Row = Record<string, unknown>;

export class CareStore {
  readonly db: DatabaseSync;
  /** Injectable clock so tests and the seeded demo are deterministic. */
  now: () => Date;

  constructor(path = ":memory:", now: () => Date = () => new Date()) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.now = now;
  }

  close() {
    this.db.close();
  }

  // ---- profile -----------------------------------------------------------

  getProfile(): Profile | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = 'profile'").get() as Row | undefined;
    return row ? (JSON.parse(String(row.value)) as Profile) : null;
  }

  setProfile(p: Profile) {
    this.db
      .prepare("INSERT INTO kv (key, value) VALUES ('profile', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(p));
  }

  requireProfile(): Profile {
    const p = this.getProfile();
    if (!p) throw new Error("Hearth has no care profile yet. Run `npm run seed` or call setup.");
    return p;
  }

  findFamily(name: string): FamilyMember | undefined {
    const n = name.trim().toLowerCase();
    return this.requireProfile().family.find(
      (f) => f.name.toLowerCase() === n || f.relation.toLowerCase() === n,
    );
  }

  // ---- medications -------------------------------------------------------

  addMedication(m: Omit<Medication, "id">): Medication {
    const r = this.db
      .prepare(
        "INSERT INTO medications (name, dose, times, pills_remaining, pills_per_dose, instructions) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(m.name, m.dose, JSON.stringify(m.times), m.pillsRemaining, m.pillsPerDose, m.instructions);
    return { ...m, id: Number(r.lastInsertRowid) };
  }

  medications(): Medication[] {
    return (this.db.prepare("SELECT * FROM medications ORDER BY id").all() as Row[]).map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      dose: String(r.dose),
      times: JSON.parse(String(r.times)) as string[],
      pillsRemaining: Number(r.pills_remaining),
      pillsPerDose: Number(r.pills_per_dose),
      instructions: String(r.instructions),
    }));
  }

  /** Case-insensitive match on name, tolerant of spoken variants ("the metformin", "lisinopril pill"). */
  findMedication(spoken: string): Medication | undefined {
    const s = spoken.toLowerCase();
    const meds = this.medications();
    return (
      meds.find((m) => m.name.toLowerCase() === s) ??
      meds.find((m) => s.includes(m.name.toLowerCase()) || m.name.toLowerCase().includes(s))
    );
  }

  /**
   * Record a dose against the closest scheduled slot today. Returns the slot
   * used, or throws if the med has no slot today.
   */
  recordDose(med: Medication, status: DoseStatus, at = this.now()): { slot: string; replaced: boolean } {
    const slot = this.closestSlot(med, at);
    const existing = this.db.prepare("SELECT status FROM doses WHERE med_id = ? AND slot = ?").get(med.id, slot) as
      | Row
      | undefined;
    this.db
      .prepare(
        "INSERT INTO doses (med_id, slot, status, at) VALUES (?, ?, ?, ?) ON CONFLICT(med_id, slot) DO UPDATE SET status = excluded.status, at = excluded.at",
      )
      .run(med.id, slot, status, at.toISOString());
    // Only decrement pills on the transition into "taken".
    if (status === "taken" && existing?.status !== "taken") {
      this.db
        .prepare("UPDATE medications SET pills_remaining = MAX(0, pills_remaining - pills_per_dose) WHERE id = ?")
        .run(med.id);
    } else if (status !== "taken" && existing?.status === "taken") {
      this.db.prepare("UPDATE medications SET pills_remaining = pills_remaining + pills_per_dose WHERE id = ?").run(med.id);
    }
    return { slot, replaced: Boolean(existing) };
  }

  private closestSlot(med: Medication, at: Date): string {
    let best = "";
    let bestDelta = Infinity;
    for (const t of med.times) {
      const slot = slotKey(at, t);
      const delta = Math.abs(slotDate(slot).getTime() - at.getTime());
      if (delta < bestDelta) {
        best = slot;
        bestDelta = delta;
      }
    }
    if (!best) throw new Error(`${med.name} has no scheduled times.`);
    return best;
  }

  /** Every scheduled slot between two instants with its recorded status (or null = no record). */
  slots(from: Date, to: Date): { med: Medication; slot: string; due: Date; status: DoseStatus | null }[] {
    const meds = this.medications();
    const recorded = new Map<string, DoseStatus>();
    for (const r of this.db
      .prepare("SELECT med_id, slot, status FROM doses WHERE slot >= ? AND slot <= ?")
      .all(slotKey(from, "00:00"), slotKey(to, "23:59")) as Row[]) {
      recorded.set(`${r.med_id}|${r.slot}`, r.status as DoseStatus);
    }
    const out: { med: Medication; slot: string; due: Date; status: DoseStatus | null }[] = [];
    for (let d = new Date(from.getFullYear(), from.getMonth(), from.getDate()); d <= to; d.setDate(d.getDate() + 1)) {
      for (const med of meds) {
        for (const t of med.times) {
          const slot = slotKey(d, t);
          const due = slotDate(slot);
          if (due < from || due > to) continue;
          out.push({ med, slot, due, status: recorded.get(`${med.id}|${slot}`) ?? null });
        }
      }
    }
    return out.sort((a, b) => a.due.getTime() - b.due.getTime());
  }

  // ---- check-ins, notes, appointments, notifications ---------------------

  addCheckIn(c: Omit<CheckIn, "id" | "at"> & { at?: string }): CheckIn {
    const at = c.at ?? this.now().toISOString();
    const r = this.db
      .prepare("INSERT INTO checkins (at, mood, sleep_hours, pain, symptoms, note) VALUES (?, ?, ?, ?, ?, ?)")
      .run(at, c.mood, c.sleepHours, c.pain, c.symptoms, c.note);
    return { ...c, at, id: Number(r.lastInsertRowid) };
  }

  checkIns(since: Date): CheckIn[] {
    return (this.db.prepare("SELECT * FROM checkins WHERE at >= ? ORDER BY at").all(since.toISOString()) as Row[]).map(
      (r) => ({
        id: Number(r.id),
        at: String(r.at),
        mood: r.mood == null ? null : Number(r.mood),
        sleepHours: r.sleep_hours == null ? null : Number(r.sleep_hours),
        pain: r.pain == null ? null : Number(r.pain),
        symptoms: String(r.symptoms),
        note: String(r.note),
      }),
    );
  }

  addNote(author: string, text: string, at = this.now().toISOString()): CareNote {
    const r = this.db.prepare("INSERT INTO notes (at, author, text) VALUES (?, ?, ?)").run(at, author, text);
    return { id: Number(r.lastInsertRowid), at, author, text };
  }

  notes(since: Date): CareNote[] {
    return (this.db.prepare("SELECT * FROM notes WHERE at >= ? ORDER BY at DESC").all(since.toISOString()) as Row[]).map(
      (r) => ({ id: Number(r.id), at: String(r.at), author: String(r.author), text: String(r.text) }),
    );
  }

  addAppointment(a: Omit<Appointment, "id">): Appointment {
    const r = this.db
      .prepare("INSERT INTO appointments (at, title, with_whom, location, driver) VALUES (?, ?, ?, ?, ?)")
      .run(a.at, a.title, a.withWhom, a.location, a.driver);
    return { ...a, id: Number(r.lastInsertRowid) };
  }

  setAppointmentDriver(id: number, driver: string) {
    this.db.prepare("UPDATE appointments SET driver = ? WHERE id = ?").run(driver, id);
  }

  appointments(from: Date, to: Date): Appointment[] {
    return (
      this.db
        .prepare("SELECT * FROM appointments WHERE at >= ? AND at <= ? ORDER BY at")
        .all(from.toISOString(), to.toISOString()) as Row[]
    ).map((r) => ({
      id: Number(r.id),
      at: String(r.at),
      title: String(r.title),
      withWhom: String(r.with_whom),
      location: String(r.location),
      driver: r.driver == null ? null : String(r.driver),
    }));
  }

  addNotification(n: Omit<Notification, "id" | "at">): Notification {
    const at = this.now().toISOString();
    const r = this.db
      .prepare("INSERT INTO notifications (at, to_whom, urgency, message, delivery) VALUES (?, ?, ?, ?, ?)")
      .run(at, n.to, n.urgency, n.message, n.delivery);
    return { ...n, at, id: Number(r.lastInsertRowid) };
  }

  setNotificationDelivery(id: number, delivery: string) {
    this.db.prepare("UPDATE notifications SET delivery = ? WHERE id = ?").run(delivery, id);
  }

  notifications(since: Date): Notification[] {
    return (
      this.db.prepare("SELECT * FROM notifications WHERE at >= ? ORDER BY at DESC").all(since.toISOString()) as Row[]
    ).map((r) => ({
      id: Number(r.id),
      at: String(r.at),
      to: String(r.to_whom),
      urgency: r.urgency as Notification["urgency"],
      message: String(r.message),
      delivery: String(r.delivery),
    }));
  }
}
