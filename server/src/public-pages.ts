// Public, unauthenticated pages the Alexa+ add-on listing needs: privacy
// policy, terms of use, and the icon/carousel images (HTTPS URLs in addon.json).
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>:root{--bg:#fbf7f2;--ink:#2b2420;--muted:#7a6d64}@media (prefers-color-scheme:dark){:root{--bg:#1d1916;--ink:#f3ebe3;--muted:#b3a597}}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.6 system-ui,-apple-system,sans-serif}
main{max-width:680px;margin:0 auto;padding:40px 16px}h1{font-size:28px}h2{font-size:19px;margin-top:28px}p,li{color:var(--muted)}</style>
</head><body><main><h1>${title}</h1>${body}<p><small>Last updated October 2026.</small></p></main></body></html>`;

const PRIVACY = page(
  "Hearth privacy policy",
  `<p>Hearth is a self-hosted caregiving tool. Each household runs its own Hearth server, and that server is the only place your data is stored.</p>
<h2>What Hearth stores</h2><ul><li>The care profile: the care recipient's first name and family members' names and relations.</li>
<li>Medication schedules and dose records, daily check-ins (pain, mood, sleep, symptoms in the speaker's words), care notes, appointments, and a log of alerts sent.</li></ul>
<h2>How it's used</h2><p>Only to answer the household's own requests through Alexa and other assistants the household connects, and to send alerts to family members the household lists. Hearth does not sell, share or analyze data for advertising.</p>
<h2>Third parties</h2><p>Requests reach Hearth through Amazon Alexa and are subject to Amazon's privacy notice. If the household configures push notifications, alert text is sent to the chosen service (for example ntfy.sh or a webhook the household controls).</p>
<h2>Deleting data</h2><p>The household owner can delete the Hearth database file at any time. Unlinking Hearth in the Alexa app revokes Alexa's access.</p>`,
);

const TERMS = page(
  "Hearth terms of use",
  `<p>Hearth helps families coordinate care. It is <strong>not a medical device</strong> and does not provide medical advice, diagnosis or treatment. Always follow the instructions of a qualified clinician.</p>
<p><strong>In an emergency, call 911.</strong> Do not rely on Hearth, Alexa or push notifications to summon help.</p>
<p>Hearth is provided "as is" under the MIT License, without warranty of any kind. Alerts can be delayed or fail to deliver.</p>`,
);

export function mountPublicPages(app: Express) {
  app.use("/assets", express.static(fileURLToPath(new URL("../assets", import.meta.url)), { index: false, maxAge: "1d" }));
  app.get("/privacy", (_req, res) => void res.type("html").send(PRIVACY));
  app.get("/terms", (_req, res) => void res.type("html").send(TERMS));
}
