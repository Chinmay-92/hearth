import { createApp } from "./app.ts";
import { OAuthServer } from "./oauth.ts";
import { seedDemo } from "./seed.ts";
import { CareStore } from "./store.ts";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const store = new CareStore(process.env.HEARTH_DB ?? "hearth.db");

if (!store.getProfile()) {
  seedDemo(store, { notifyTopic: process.env.HEARTH_NTFY_TOPIC });
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
  });
  console.log(`Alexa+ OAuth enabled for ${oauth.resource}`);
}

const { app, close } = createApp(store, {
  host,
  oauth,
  publicHosts: env.HEARTH_PUBLIC_URL ? [new URL(env.HEARTH_PUBLIC_URL).hostname] : undefined,
  token: process.env.HEARTH_TOKEN,
  allowedOrigins: process.env.HEARTH_ALLOWED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean),
});

if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host) && !process.env.HEARTH_TOKEN && !oauth) {
  console.warn("WARNING: listening on a non-loopback address without HEARTH_TOKEN. Anyone who can reach this port can read care data.");
}

const server = app.listen(port, host, () => {
  console.log(`Hearth MCP server listening on http://${host}:${port}/mcp (protocol 2025-11-25, Streamable HTTP)`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await close();
    server.close();
    store.close();
    process.exit(0);
  });
}
