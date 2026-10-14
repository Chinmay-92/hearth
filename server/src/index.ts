import { createApp } from "./app.ts";
import { EventHub } from "./events.ts";
import { OAuthServer } from "./oauth.ts";
import { parseWeekly, startScheduler } from "./scheduler.ts";
import { seedDemo } from "./seed.ts";
import { CareStore } from "./store.ts";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
// HEARTH_DEMO_TIME=09:10 starts Hearth's clock at that time today (it then runs normally),
// so recordings show the morning doses as overdue whatever the real time is.
const demoTime = process.env.HEARTH_DEMO_TIME?.match(/^(\d{1,2}):(\d{2})$/);
const clockOffset = demoTime ? new Date().setHours(Number(demoTime[1]), Number(demoTime[2]), 0, 0) - Date.now() : 0;
const store = new CareStore(process.env.HEARTH_DB ?? "hearth.db", () => new Date(Date.now() + clockOffset));

if (!store.getProfile()) {
  seedDemo(store, { notifyTopic: process.env.HEARTH_NTFY_TOPIC, familyEmail: process.env.HEARTH_DEMO_EMAIL });
  console.log("No care profile found; seeded the demo household.");
}

// Alexa+ mode: OAuth 2.1 (service tokens + account linking). Enabled when a client id is configured.
const env = process.env;
let oauth: OAuthServer | undefined;
if (env.HEARTH_OAUTH_CLIENT_ID) {
  const missing = ["HEARTH_PUBLIC_URL", "HEARTH_OAUTH_CLIENT_SECRET", "HEARTH_LINK_PIN"].filter((k) => !env[k]);
  if (missing.length) {
    console.error(`Alexa+ OAuth mode needs ${missing.join(", ")}. Run \`npm run alexa:credentials\`.`);
    process.exit(1);
  }
  oauth = new OAuthServer(store.db, {
    publicUrl: env.HEARTH_PUBLIC_URL!,
    clientId: env.HEARTH_OAUTH_CLIENT_ID,
    clientSecret: env.HEARTH_OAUTH_CLIENT_SECRET!,
    linkPin: env.HEARTH_LINK_PIN!,
    household: () => store.getProfile()?.household ?? "your household",
    members: () => {
      const p = store.getProfile();
      return p ? [p.recipient, ...p.family.map((f) => f.name)] : [];
    },
  });
  console.log(`Alexa+ OAuth enabled for ${oauth.resource}`);
}

const hub = new EventHub();
const { app, close } = createApp(store, {
  hub,
  inboxToken: env.HEARTH_INBOX_TOKEN,
  host,
  oauth,
  publicHosts: env.HEARTH_PUBLIC_URL ? [new URL(env.HEARTH_PUBLIC_URL).hostname] : undefined,
  token: process.env.HEARTH_TOKEN,
  allowedOrigins: process.env.HEARTH_ALLOWED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean),
});

if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host) && !process.env.HEARTH_TOKEN && !oauth) {
  console.warn("WARNING: listening on a non-loopback address without HEARTH_TOKEN. Anyone who can reach this port can read care data.");
}

// Overdue-dose reminders and the weekly summary email. HEARTH_REMINDERS=0 turns reminders off.
const weekly = env.HEARTH_WEEKLY_SUMMARY ?? "sun 18:00";
if (weekly !== "off" && !parseWeekly(weekly)) console.warn(`HEARTH_WEEKLY_SUMMARY="${weekly}" is not like "sun 18:00"; weekly email disabled.`);
const stopScheduler =
  env.HEARTH_REMINDERS === "0" && weekly === "off"
    ? () => {}
    : startScheduler(store, hub, {
        weekly: weekly !== "off" && parseWeekly(weekly) ? weekly : null,
        reminders: env.HEARTH_REMINDERS !== "0",
      });
if (env.HEARTH_INBOX_TOKEN) console.log("Care-team inbox enabled at POST /inbox/notes");

const server = app.listen(port, host, () => {
  console.log(`Hearth MCP server listening on http://${host}:${port}/mcp (protocol 2025-11-25, Streamable HTTP)`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    stopScheduler();
    await close();
    server.close();
    store.close();
    process.exit(0);
  });
}
