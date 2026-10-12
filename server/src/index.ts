import { createApp } from "./app.ts";
import { seedDemo } from "./seed.ts";
import { CareStore } from "./store.ts";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const store = new CareStore(process.env.HEARTH_DB ?? "hearth.db");

if (!store.getProfile()) {
  seedDemo(store, { notifyTopic: process.env.HEARTH_NTFY_TOPIC });
  console.log("No care profile found; seeded the demo household.");
}

const { app, close } = createApp(store, {
  host,
  token: process.env.HEARTH_TOKEN,
  allowedOrigins: process.env.HEARTH_ALLOWED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean),
});

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
