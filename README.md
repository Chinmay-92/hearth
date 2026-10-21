# Hearth: an Alexa+ caregiving co-pilot

**Hearth is a self-hosted MCP server that turns Alexa+ into a shared memory and early-warning system for families caring for an aging parent.**

Mom talks to the Echo in her kitchen: *"I took my metformin."* *"I slept badly and my knee hurts on the stairs."* Hearth records it, compares it with her baseline, and decides whether it matters. Her daughter, three states away, asks her own Alexa *"How's Mom doing this week?"* and gets a spoken answer and an interactive card. The card shows medication adherence, pain and sleep trends, missed doses, a refill running out, and an orthopedics appointment that still has no driver.

If Mom says *"I tripped on the rug and I'm dizzy"*, Hearth doesn't just log it. In the middle of the tool call it asks her, *"Should I alert Sarah right away?"*, and on a yes it sends Sarah a push notification.

> Track: **Alexa+** (self-hosted MCP server, spec **2025-11-25**, **Streamable HTTP**), running on a **real Echo Dot** through the Alexa+ MCP Toolkit, with a web simulator as a fallback
> Mini-challenge: **Open Source**, with [`mcp-http-probe`](https://github.com/Chinmay-92/mcp-http-probe), a conformance checker for Streamable HTTP MCP servers (on [npm](https://www.npmjs.com/package/mcp-http-probe) and the [GitHub Marketplace](https://github.com/marketplace/actions/mcp-http-probe))

**Website:** https://hearth-site-six.vercel.app · **Demo video (under 3 min):** https://www.youtube.com/watch?v=Z35pSKCaUfc

---

## Why this matters

In the US, more than one in five adults is an unpaid family caregiver, and many coordinate care from a distance. The information they need is spread across pill organizers, sticky notes, group texts and the parent's own memory. Voice suits the person being cared for, who may not use apps. The family needs the opposite: a summary, trends, and a nudge when something changes.

Hearth connects the two. It keeps **one shared household state** that any device or family member reaches through Alexa+. The care recipient adds to it simply by talking.

## What it does

| Capability | MCP feature used | Example |
|---|---|---|
| Medication schedule, dose logging, refill forecasting | tools with `structuredContent`, annotations | "Did I take my pills?" / "I just took my lisinopril" |
| Daily check-ins with baseline-aware concern detection | tool → **elicitation** (form mode) when urgent | "I tripped and I'm dizzy" → *"Should I alert Sarah now?"* |
| Family digest with trends and flags | **MCP App** (`ui://hearth/digest`, `text/html;profile=mcp-app`) | "How's Mom doing this week?" → interactive card on Echo Show |
| Messaging family through a confirm step | elicitation, with a `confirmed` fallback for clients without it | "Tell David thanks for the groceries" |
| Appointments with ride coordination | elicitation with a titled-enum (`oneOf`) driver picker, plus notification | "Mom's knee appointment needs a driver" → pick David → David is notified |
| State across sessions, devices and family members | shared SQLite store, per-session `McpServer` | Mom logs at 8am; Sarah's digest at 9pm sees it |
| Guided routines | **prompts** (`morning_checkin`, `weekly_family_update`) | |
| Inspectable data | **resources** (`hearth://profile`), templated `hearth://day/{date}` with completion | |
| Proactive overdue-dose reminders | scheduler → **`notifications/message`** pushed on each session's GET SSE stream | 30 min late: *"Margaret, it's past time for your 8 AM metformin"* on her screen (yellow light). 3 h late: Sarah is told |
| Notes from the care team | `POST /inbox/notes` (own token) → note + family alert + push; `whats_due` reads it to Mom word for word | A clinic portal or inbound-email webhook posts *"Keep the lisinopril at 10 mg"*; Mom hears it next time she asks |
| Weekly summary email for family without an Echo | tool with elicitation confirm (`send_weekly_summary`) + weekly schedule | Sundays 6 pm, David gets the digest by email (Resend, or ntfy's email forwarding) |
| Knowing who is speaking | account linking asks *"Who uses this Alexa?"*; the member rides in the OAuth token to `extra.authInfo`. Shared devices pass `_meta["hearth/speaker"]` | Messages are signed, doses say *"logged by David"*, check-ins *"reported by Sarah"* |
| Audit trail | `notifications/message` logging when alerts go out | |

Hearth also acts on its own clock. A scheduler checks every minute for doses with nothing logged: after 30 minutes it reminds the care recipient on every connected Hearth screen (and on her phone if `recipientNotify` is set in the profile), and after 3 hours it tells the primary family member. Each stage fires once, and nothing is sent during quiet hours (9 pm–8 am). Alexa+ add-ons can't push to an Echo on their own yet (see [feature request 3](docs/FRICTION_LOG.md#feature-requests)), so on a real Echo Dot the reminder reaches the family's phones and is mentioned the next time Mom asks what's due; screens connected to Hearth over MCP (the simulator, an Echo Show web view) get it straight away and catch up on the last 15 minutes when they connect.

Push notifications are delivered through [ntfy.sh](https://ntfy.sh) (free, no account; install the app and subscribe to a topic) or any webhook (Slack, Discord, Zapier). With neither configured, alerts go to an outbox in the database.

## Two ways to talk to Hearth

1. **A real Echo Dot or Echo Show via the Alexa+ MCP Toolkit.** Alexa+ is the MCP client. Hearth ships with what the toolkit requires: OAuth 2.1 with `client_credentials` service tokens, account linking with PKCE (a family member approves with a household PIN), RFC 9728 metadata, a bare `401` to trigger linking, tool calls under 500 ms, listing pages and art. Step-by-step guide: **[alexa/README.md](alexa/README.md)**.
2. **The web Alexa+ simulator** in this repo, for judges without a device and for showing the MCP traffic live.

Both talk to the same Hearth server and household, so something logged on the Echo Dot shows up in the simulator's digest, and the reverse.

## Architecture

```
 Echo / Alexa+ ─┐                                   ┌─ ntfy.sh push → family phones
                │  MCP 2025-11-25                   │
 Alexa+ sim  ───┼── Streamable HTTP ──► Hearth MCP ─┼─ webhooks (Slack/Discord/…)
 (this repo)    │   POST/GET/DELETE /mcp   server   │
 MCP Inspector ─┘   sessions · Origin   (Node 22+)  └─ SQLite: profile, meds, doses,
 Claude, etc.       check · bearer auth                check-ins, notes, appts, alerts
```

- **`server/`** is the Hearth MCP server. It uses the official `@modelcontextprotocol/sdk` 1.32.1, whose `LATEST_PROTOCOL_VERSION` is `2025-11-25`, over Streamable HTTP with session IDs. On top of that it adds GET SSE streams, DELETE session teardown, Origin validation (403), CORS for browser clients, and optional bearer auth. Each connection gets its own `McpServer`, so elicitation reaches the right device. Every connection shares one `CareStore`.
- **`simulator/`** is the alternate "simulated Alexa+" path the rules allow. It's a web Echo Show with speech in (Web Speech API), speech out (speechSynthesis), and an ambient home screen. It also hosts MCP Apps (the `ui/initialize` handshake → `tool-input` / `tool-result` → `size-changed`) and answers elicitation by tap or by voice ("yes" / "David"). The agent loop is Claude (`claude-opus-5-5`, adaptive thinking, low effort for voice latency) calling Hearth's tools over a real MCP client session. A live **MCP trace** panel shows every `tools/call`, result, card and `elicitation/create`.
- **`packages/mcp-http-probe/`** is the open-source contribution: a dependency-free conformance CLI for Streamable HTTP MCP servers. Hearth passes all 23 checks. It's published on [npm](https://www.npmjs.com/package/mcp-http-probe) (`npx mcp-http-probe <url>`) and as a GitHub Action on the [Marketplace](https://github.com/marketplace/actions/mcp-http-probe), so any MCP server can gate CI on it:
  ```yaml
  - uses: Chinmay-92/mcp-http-probe@v1
    with:
      url: http://127.0.0.1:8787/mcp
  ```

## Quick start

Requires **Node.js 22.18 or later**. The `.ts` files run directly through Node's built-in type stripping, so there's no build step.

```bash
git clone https://github.com/Chinmay-92/hearth.git && cd hearth
npm install

# 1. Start the MCP server. On first run it seeds a demo household: Margaret (78), with daughter Sarah and son David.
npm run dev:server          # → http://127.0.0.1:8787/mcp

# 2. In a second terminal, start the Alexa+ simulator
export ANTHROPIC_API_KEY=sk-ant-...      # used only by the simulator's agent loop
npm run dev:sim             # → open http://127.0.0.1:5173 in Chrome or Edge (for voice input)
# No API key? Run the simulator in scripted playback mode instead:
#   HEARTH_PLAYBACK=1 npm run dev:sim

# 3. Optional: verify spec conformance
npm run probe
```

Use the mic button or type. The suggestion chips walk through the demo story. Switch **Speaking:** to Sarah to see the family-member side.

To get real push notifications on your phone, install the ntfy app, subscribe to a topic name of your choice, then reseed:

```bash
HEARTH_NTFY_TOPIC=hearth-demo-<something-unique> npm run seed
```

### Connect other MCP clients

- **MCP Inspector:** `npx @modelcontextprotocol/inspector`. Choose transport *Streamable HTTP* and URL `http://127.0.0.1:8787/mcp`.
- **Claude Code:** `claude mcp add --transport http hearth http://127.0.0.1:8787/mcp`
- **Alexa+ or any remote client:** expose the server through a tunnel and **set a token**:
  ```bash
  HOST=0.0.0.0 HEARTH_TOKEN=$(openssl rand -hex 24) npm run dev:server
  cloudflared tunnel --url http://localhost:8787     # or ngrok http 8787
  ```
  Clients then send `Authorization: Bearer <token>`.

### Run it on your Echo Dot

See **[alexa/README.md](alexa/README.md)**. In short:

```bash
cloudflared tunnel --url http://localhost:8787                  # public HTTPS URL
npm run alexa:credentials -- https://<tunnel>.trycloudflare.com  # OAuth client + household PIN → .env
npm run dev:server                                               # Hearth in Alexa+ mode
# then: alexa-ai new mcp → node alexa/configure-addon.ts … → alexa-ai deploy → configure-account-linking
```

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | where the MCP server listens |
| `HEARTH_DB` | `hearth.db` | SQLite file (`:memory:` for ephemeral) |
| `HEARTH_TOKEN` | unset | require `Authorization: Bearer …` on `/mcp` |
| `HEARTH_ALLOWED_ORIGINS` | localhost only | comma-separated browser origins allowed to call `/mcp` |
| `HEARTH_NTFY_TOPIC` | unset | used by `npm run seed` to route family alerts to ntfy.sh |
| `HEARTH_DRY_RUN` | unset | `1` = never call external notification services |
| `HEARTH_MCP_URL` | `http://127.0.0.1:8787/mcp` | simulator → server URL |
| `HEARTH_MODEL` | `claude-opus-5-5` | simulator's Claude model |
| `HEARTH_PLAYBACK` | unset | `1` = simulator replays scripted demo lines through the real MCP server (no API key needed; spoken replies are pre-written, tool calls and elicitation are live) |
| `HEARTH_DEMO_TIME` | unset | e.g. `09:12` starts Hearth's clock at that time today, so the morning doses show as due whatever the real time is |
| `HEARTH_PUBLIC_URL` | unset | public HTTPS base URL (tunnel); enables the Host allow-list and OAuth metadata |
| `HEARTH_OAUTH_CLIENT_ID` / `_SECRET` | unset | Alexa+ OAuth client; setting the ID turns on Alexa+ mode |
| `HEARTH_LINK_PIN` | unset | household PIN entered during account linking |
| `HEARTH_REMINDERS` | on | `0` turns off overdue-dose reminders |
| `HEARTH_WEEKLY_SUMMARY` | `sun 18:00` | when to email the weekly summary; `off` to disable |
| `RESEND_API_KEY` / `HEARTH_EMAIL_FROM` | unset | send the weekly summary through [Resend](https://resend.com). Without them it goes through ntfy's email forwarding (if the member has an ntfy topic), else the outbox |
| `HEARTH_DEMO_EMAIL` | `david@example.com` | email address seeded for David (the family member without an Echo) |
| `HEARTH_INBOX_TOKEN` | unset | turns on `POST /inbox/notes` for care-team notes; set it for the simulator too to enable its **Clinic note** button |

### Care-team inbox

A clinic portal, Zapier, or an inbound-email webhook (Mailgun, Postmark) can post notes for the family:

```bash
curl -X POST http://127.0.0.1:8787/inbox/notes -H "Authorization: Bearer $HEARTH_INBOX_TOKEN" \
  -H "content-type: application/json" \
  -d '{"from": "Dr. Bennett'"'"'s office", "text": "Keep the lisinopril at 10 mg and book a follow-up in three months."}'
```

It accepts JSON, form posts (`sender`, `subject`, `stripped-text`) or plain text. The note is saved as a care-team note, the primary family member gets an alert, connected screens show it, and `whats_due` reads it to the care recipient word for word until she has heard it.

`npm run alexa:credentials` generates the Alexa+ variables into `.env`, which the server and simulator load automatically.

## Tests

```bash
npm test          # 41 tests: MCP over HTTP (elicitation, sessions, origin), reminders, inbox, weekly email, speaker identity, the Alexa+ OAuth contract, probe vs. 4 reference servers
npm run typecheck
```

The server tests use the real SDK `Client` over Streamable HTTP. They cover protocol negotiation (`2025-11-25`), persistence across sessions, elicitation accept and decline, the no-elicitation fallbacks (confirmation, `assign_driver`), the titled-enum driver picker, the MCP App resource, and rejection of foreign Origins, Hosts and unknown sessions.

`test/features.test.ts` moves a fake clock through a day to check the reminder stages, quiet hours and late starts. It also checks the weekly email (rendered and sent through a stubbed Resend), the care-team inbox (auth, JSON and inbound-email forms, read-out rules), `_meta` speaker identity, and that reminders reach a connected client as `notifications/message`.

`test/oauth.test.ts` plays the part of Alexa+. It runs metadata discovery, the client-credentials service token (lists tools, gets a 401 on `tools/call`), account linking with PKCE and the PIN (including "who uses this Alexa", which then signs messages, also after a refresh), single-use codes, refresh rotation without `resource`, and checks that a linked `tools/call` finishes in under 500 ms.

## Project layout

```
server/src/
  index.ts          entry point (env config, seeding, listen)
  app.ts            Streamable HTTP transport, sessions, Origin/Host/CORS
  oauth.ts          OAuth 2.1 server for Alexa+ (service tokens, account linking, PKCE)
  public-pages.ts   privacy/terms pages and listing art for the add-on
  hearth.ts         MCP tools, resources, prompts, elicitation, speaker identity
  insights.ts       what's due, concern assessment, digest trends
  scheduler.ts      overdue-dose reminders, weekly summary schedule
  weekly.ts         weekly summary email (text + HTML)
  events.ts         event hub: pushes to every connected session
  alerts.ts         record + deliver a family alert
  store.ts          SQLite care store (node:sqlite)
  notify.ts         ntfy.sh / webhook / email delivery
  seed.ts           demo household with a story in the data
  ui/digest-app.ts  MCP App view for family_digest
simulator/
  src/agent.ts      Claude tool-use loop over an MCP client
  src/server.ts     device sessions, SSE turn stream, elicitation bridge
  public/           Echo Show-style UI, MCP Apps host, speech I/O
alexa/              Echo Dot guide, add-on listing copy, addon.json patcher
packages/mcp-http-probe/   open-source conformance CLI (MIT)
docs/               demo script and Devpost submission kit
```

## Safety notes

Hearth is a coordination tool, not a medical device. It never gives medical advice beyond what the family recorded. It tells people to call 911 for emergencies, and it asks for confirmation before contacting anyone. Concern detection is deliberately conservative: a false positive costs one text message.

## License

MIT. See [LICENSE](LICENSE).
