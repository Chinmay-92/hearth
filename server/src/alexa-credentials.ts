// Generates the OAuth client and household PIN for the Alexa+ add-on and
// appends them to ../.env (which `npm run dev:server` loads).
import { randomBytes, randomInt } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../../.env", import.meta.url));
const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
if (/^HEARTH_OAUTH_CLIENT_ID=/m.test(current)) {
  console.log(`${envPath} already has Alexa+ credentials. Delete those lines to regenerate.`);
  process.exit(0);
}
const publicUrl = process.argv[2] ?? "https://REPLACE-WITH-YOUR-TUNNEL-URL";
const vars = {
  HEARTH_PUBLIC_URL: publicUrl.replace(/\/+$/, ""),
  HEARTH_OAUTH_CLIENT_ID: `hearth-alexa-${randomBytes(4).toString("hex")}`,
  HEARTH_OAUTH_CLIENT_SECRET: randomBytes(32).toString("base64url"),
  HEARTH_LINK_PIN: String(randomInt(100000, 1000000)),
};
appendFileSync(envPath, `${current && !current.endsWith("\n") ? "\n" : ""}# Alexa+ add-on (generated ${new Date().toISOString()})\n${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n")}\n`);
console.log(`Wrote Alexa+ credentials to ${envPath}\n`);
console.log(`  Client ID:      ${vars.HEARTH_OAUTH_CLIENT_ID}`);
console.log(`  Client secret:  (in .env — paste it at the alexa-ai configure-account-linking prompt)`);
console.log(`  Household PIN:  ${vars.HEARTH_LINK_PIN}  (family members enter this when linking in the Alexa app)`);
