import { CareStore } from "./store.ts";
import { seedDemo } from "./seed.ts";

const path = process.env.HEARTH_DB ?? "hearth.db";
const store = new CareStore(path);
seedDemo(store, { notifyTopic: process.env.HEARTH_NTFY_TOPIC });
console.log(`Seeded demo household into ${path}`);
store.close();
