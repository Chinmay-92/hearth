// The weekly summary email, for family members who don't have an Echo. It is
// the same family_digest the Echo Show renders, written as a short email with
// anything that needs action first.
import type { EventHub } from "./events.ts";
import { familyDigest } from "./insights.ts";
import { deliverEmail } from "./notify.ts";
import type { CareStore, FamilyMember } from "./store.ts";

type Digest = ReturnType<typeof familyDigest>;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const avg = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
};

export function renderWeeklySummary(d: Digest, household: string) {
  const subject = `${d.recipient}'s week: ${d.adherencePercent ?? "?"}% of meds taken${d.flags.length ? `, ${d.flags.length} thing${d.flags.length === 1 ? "" : "s"} to look at` : ""}`;
  const pain = avg(d.series.map((r) => r.pain));
  const sleep = avg(d.series.map((r) => r.sleep));
  const mood = avg(d.series.map((r) => r.mood));
  const stats = [
    ["Meds taken", d.adherencePercent == null ? "–" : `${d.adherencePercent}%`],
    ["Avg pain", pain == null ? "–" : `${pain}/10`],
    ["Avg sleep", sleep == null ? "–" : `${sleep}h`],
    ["Avg mood", mood == null ? "–" : `${mood}/5`],
  ];
  const appts = d.upcomingAppointments.map((a) => `${a.title}, ${when(a.at)}${a.driver ? ` (${a.driver} driving)` : " (needs a driver)"}`);
  const notes = d.recentNotes.map((n) => `${n.source === "care_team" ? "[Care team] " : ""}${n.text} (${n.author})`);

  const text = [
    `How ${d.recipient} did this week (${household})`,
    "",
    stats.map(([k, v]) => `${k}: ${v}`).join(" · "),
    "",
    d.flags.length ? `Worth attention:\n${d.flags.map((f) => `- ${f}`).join("\n")}` : "Nothing unusual this week.",
    appts.length ? `\nComing up:\n${appts.map((a) => `- ${a}`).join("\n")}` : "",
    notes.length ? `\nNotes:\n${notes.map((n) => `- ${n}`).join("\n")}` : "",
    "",
    `Ask Alexa "How's ${d.recipient} doing?" any time for the latest. Sent by Hearth.`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  const list = (title: string, items: string[]) =>
    items.length
      ? `<h2 style="font:600 13px system-ui;text-transform:uppercase;letter-spacing:.05em;color:#7a6d64;margin:22px 0 8px">${title}</h2>` +
        items.map((i) => `<p style="margin:0 0 6px;padding:8px 10px;border-radius:8px;background:#fff7f1;border-left:3px solid #d9622b">${esc(i)}</p>`).join("")
      : "";
  const html = `<!doctype html><html><body style="margin:0;background:#fbf7f2;color:#2b2420;font:15px/1.5 system-ui,-apple-system,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<p style="margin:0;color:#d9622b;font-weight:600">Hearth · weekly summary</p>
<h1 style="font-size:22px;margin:4px 0 16px">How ${esc(d.recipient)} did this week</h1>
<table role="presentation" width="100%" style="border-collapse:separate;border-spacing:6px"><tr>${stats
    .map(([k, v]) => `<td style="background:#fff;border:1px solid #ece3da;border-radius:12px;padding:10px;text-align:center"><b style="display:block;font-size:20px">${esc(v)}</b><span style="font-size:12px;color:#7a6d64">${esc(k)}</span></td>`)
    .join("")}</tr></table>
${d.flags.length ? list("Worth attention", d.flags) : `<p style="color:#4f8a6b;font-weight:600">Nothing unusual this week.</p>`}
${list("Coming up", appts)}
${list("Notes", notes)}
<p style="margin-top:24px;color:#7a6d64;font-size:13px">Ask Alexa “How's ${esc(d.recipient)} doing?” any time for the latest. Sent by Hearth for ${esc(household)}.</p>
</div></body></html>`;
  return { subject, text, html };
}

/** Sends the summary to the given family members (default: everyone with an email address). */
export async function sendWeeklySummary(store: CareStore, hub: EventHub, recipients?: FamilyMember[], fetchImpl?: typeof fetch) {
  const profile = store.requireProfile();
  const to = (recipients ?? profile.family).filter((m) => m.email);
  const { subject, text, html } = renderWeeklySummary(familyDigest(store, 7), profile.household);
  const results = await Promise.all(
    to.map(async (m) => {
      const n = store.addNotification({ to: m.name, urgency: "info", message: `Weekly summary email: ${subject}`, delivery: "sending" });
      const d = await deliverEmail(m, subject, text, html, fetchImpl);
      store.setNotificationDelivery(n.id, d.ok ? d.channel : `${d.channel} failed: ${d.detail}`);
      return { to: m.name, email: m.email!, channel: d.channel, ok: d.ok };
    }),
  );
  if (to.length) hub.emit({ kind: "weekly_summary", to: to.map((m) => m.name), subject });
  return { subject, results };
}
