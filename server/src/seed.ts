// Demo household: Asha (78) lives alone; her daughter Priya coordinates care
// remotely and her son Raj lives nearby. Two weeks of history are generated
// relative to "now" with a story baked in: knee pain creeping up over the last
// few days and a pattern of missed evening doses, so the digest has something
// real to find.
import { type CareStore, slotKey } from "./store.ts";

export function seedDemo(store: CareStore, opts: { notifyTopic?: string } = {}) {
  const db = store.db;
  db.exec("DELETE FROM doses; DELETE FROM checkins; DELETE FROM notes; DELETE FROM appointments; DELETE FROM notifications; DELETE FROM medications; DELETE FROM kv;");

  store.setProfile({
    recipient: "Asha",
    household: "Asha's home",
    emergencyContact: "Priya",
    family: [
      { name: "Priya", relation: "daughter", notify: opts.notifyTopic ? `ntfy:${opts.notifyTopic}` : undefined },
      { name: "Raj", relation: "son", notify: opts.notifyTopic ? `ntfy:${opts.notifyTopic}` : undefined },
    ],
  });

  const meds = [
    store.addMedication({ name: "Lisinopril", dose: "10 mg", times: ["08:00"], pillsRemaining: 24, pillsPerDose: 1, instructions: "for blood pressure" }),
    store.addMedication({ name: "Metformin", dose: "500 mg", times: ["08:00", "20:00"], pillsRemaining: 9, pillsPerDose: 1, instructions: "with food" }),
    store.addMedication({ name: "Atorvastatin", dose: "20 mg", times: ["20:00"], pillsRemaining: 40, pillsPerDose: 1, instructions: "at bedtime" }),
  ];

  const now = store.now();
  let rng = 42;
  const rand = () => ((rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

  for (let back = 13; back >= 0; back--) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    // Doses: evenings slip more often in the last week.
    for (const med of meds) {
      for (const t of med.times) {
        const slot = slotKey(day, t);
        const due = new Date(`${slot}:00`);
        if (due.getTime() > now.getTime() - 90 * 60_000) continue; // leave today's pending slots open
        const evening = t >= "18:00";
        const missChance = evening && back <= 6 ? 0.35 : 0.05;
        const status = rand() < missChance ? null : "taken";
        if (status) {
          const at = new Date(due.getTime() + Math.round(rand() * 40) * 60_000);
          db.prepare("INSERT INTO doses (med_id, slot, status, at) VALUES (?, ?, 'taken', ?)").run(med.id, slot, at.toISOString());
        }
      }
    }
    // Morning check-in (skip today so the demo can log a fresh one).
    if (back === 0) continue;
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 8, 15 + Math.round(rand() * 30));
    const rising = back <= 4 ? (5 - back) * 0.9 : 0;
    const pain = Math.min(9, Math.round(2 + rand() * 1.5 + rising));
    store.addCheckIn({
      at: at.toISOString(),
      pain,
      mood: Math.max(1, Math.min(5, Math.round(4 - rising / 2 + (rand() - 0.5)))),
      sleepHours: Math.round((7 - rising / 2.5 + (rand() - 0.5)) * 2) / 2,
      symptoms: back === 2 ? "knee is stiff in the morning" : back === 1 ? "knee hurts on the stairs" : "",
      note: "",
    });
  }

  const daysAgo = (n: number, h = 19) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, h).toISOString();
  store.addNote("Priya", "Dr. Mehta said to keep ibuprofen to twice a day max because of the blood pressure meds.", daysAgo(5));
  store.addNote("Raj", "Dropped off groceries. Fridge is stocked through Sunday.", daysAgo(2, 17));

  const inDays = (n: number, h: number, m = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + n, h, m).toISOString();
  store.addAppointment({ at: inDays(3, 10, 30), title: "Orthopedics follow-up (knee)", withWhom: "Dr. Alvarez", location: "Lakeside Clinic", driver: null });
  store.addAppointment({ at: inDays(9, 14), title: "Primary care check-up", withWhom: "Dr. Mehta", location: "Riverside Family Medicine", driver: "Raj" });
}
