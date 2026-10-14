// Delivers family alerts. Each family member's `notify` field picks a channel:
//   "ntfy:<topic>"     -> push notification via ntfy.sh (free, no account; install the ntfy app)
//   "https://..."      -> JSON POST to any webhook (Slack/Discord/Zapier/your own)
//   omitted            -> recorded in the Hearth outbox only
import type { FamilyMember, Notification } from "./store.ts";

export type Delivery = { channel: string; ok: boolean; detail?: string };

export async function deliver(
  to: FamilyMember,
  urgency: Notification["urgency"],
  title: string,
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Delivery> {
  const target = to.notify?.trim();
  if (!target || process.env.HEARTH_DRY_RUN === "1") return { channel: "outbox", ok: true };
  try {
    if (target.startsWith("ntfy:")) {
      const res = await fetchImpl(`https://ntfy.sh/${encodeURIComponent(target.slice(5))}`, {
        method: "POST",
        headers: {
          Title: title,
          Priority: urgency === "urgent" ? "urgent" : urgency === "soon" ? "high" : "default",
          Tags: urgency === "urgent" ? "rotating_light,house" : "house",
        },
        body: message,
        signal: AbortSignal.timeout(5000),
      });
      return { channel: "ntfy", ok: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` };
    }
    if (/^https?:\/\//.test(target)) {
      const res = await fetchImpl(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `${title}\n${message}`, title, message, urgency, to: to.name }),
        signal: AbortSignal.timeout(5000),
      });
      return { channel: "webhook", ok: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` };
    }
    return { channel: "outbox", ok: true, detail: `unrecognised notify target "${target}"` };
  } catch (err) {
    return { channel: target.startsWith("ntfy:") ? "ntfy" : "webhook", ok: false, detail: String(err) };
  }
}

/**
 * Sends an email (the weekly summary). Channels, in order:
 *   RESEND_API_KEY + HEARTH_EMAIL_FROM -> Resend's HTTP API (HTML + text)
 *   member.notify = "ntfy:<topic>"     -> ntfy.sh's email forwarding (text only)
 *   otherwise                          -> recorded in the outbox only
 */
export async function deliverEmail(
  to: FamilyMember,
  subject: string,
  text: string,
  html: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Delivery> {
  if (!to.email || process.env.HEARTH_DRY_RUN === "1") return { channel: "outbox", ok: true };
  try {
    if (process.env.RESEND_API_KEY && process.env.HEARTH_EMAIL_FROM) {
      const res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: process.env.HEARTH_EMAIL_FROM, to: [to.email], subject, text, html }),
        signal: AbortSignal.timeout(10_000),
      });
      return { channel: "email", ok: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` };
    }
    if (to.notify?.startsWith("ntfy:")) {
      const res = await fetchImpl(`https://ntfy.sh/${encodeURIComponent(to.notify.slice(5))}`, {
        method: "POST",
        headers: { Title: subject, Email: to.email, Tags: "house" },
        body: text,
        signal: AbortSignal.timeout(10_000),
      });
      return { channel: "ntfy-email", ok: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` };
    }
    return { channel: "outbox", ok: true, detail: "no email provider configured" };
  } catch (err) {
    return { channel: "email", ok: false, detail: String(err) };
  }
}
