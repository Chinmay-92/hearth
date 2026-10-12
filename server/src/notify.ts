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
