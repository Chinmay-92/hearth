// Records a family alert and delivers it in the background. Alexa+ expects
// tool calls to return in under 500 ms, so nothing here waits on the network.
import type { EventHub } from "./events.ts";
import { deliver } from "./notify.ts";
import type { CareStore, FamilyMember, Notification } from "./store.ts";

export function sendAlert(
  store: CareStore,
  hub: EventHub,
  member: FamilyMember,
  urgency: Notification["urgency"],
  message: string,
  from: string,
): Notification {
  const title = urgency === "urgent" ? `Urgent from ${store.requireProfile().household}` : `Hearth update from ${from}`;
  const n = store.addNotification({ to: member.name, urgency, message, delivery: member.notify ? "sending" : "outbox" });
  hub.emit({ kind: "alert", to: member.name, urgency, message });
  if (member.notify) {
    void deliver(member, urgency, title, message).then((d) =>
      store.setNotificationDelivery(n.id, d.ok ? d.channel : `${d.channel} failed: ${d.detail}`),
    );
  }
  return n;
}
