# Running Hearth on a real Echo Dot (Alexa+ MCP add-on)

This guide connects the Hearth MCP server to **Alexa+ on your own Echo device** through Amazon's [Alexa+ MCP Toolkit](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview.html). Once it's set up, you say *"Alexa, did I take my pills?"* to the Echo Dot on your counter, and Alexa+ calls Hearth's `whats_due` tool.

```
Echo Dot ──voice──► Alexa+ (MCP client) ──Streamable HTTP + OAuth──► tunnel ──► Hearth on your laptop
                         ▲                                                          │
                         └──── Alexa app on your phone: account linking (PIN) ◄─────┘
```

## What Hearth already does for Alexa+

| Toolkit requirement | Where it's handled |
|---|---|
| Streamable HTTP, MCP 2025-11-25 (and older clients that send `2025-03-26`) | `server/src/app.ts` and SDK version negotiation |
| Protected Resource Metadata (RFC 9728) at `/.well-known/oauth-protected-resource` | `server/src/oauth.ts` |
| Auth server metadata at `/.well-known/oauth-authorization-server`, with `client_credentials` and PKCE `S256` | `server/src/oauth.ts` |
| Service tokens (`mcp:service`) for initialize and tools/list; user tokens (`mcp:tools mcp:resources`) for anything touching household data | `mcpAuth()` in `oauth.ts` |
| `401` **without** `WWW-Authenticate` when linking is needed, which tells Alexa+ to start account linking | `mcpAuth()` |
| Refresh token on every code exchange, with rotation; refresh requests don't need `resource` | `oauth.ts` |
| Tool round trip under 500 ms (alerts are delivered in the background) | `hearth.ts` `sendAlert()`; covered by `test/oauth.test.ts` |
| Works without elicitation: `notify_family` falls back to a `confirmed` flag; `schedule_appointment` hands off to `assign_driver` | `hearth.ts` |
| Privacy policy, terms, and icon/carousel images served over HTTPS | `server/src/public-pages.ts`, `server/assets/` |
| Voice-first tool text, since an Echo Dot has no screen. Screen devices also get the MCP App digest card. | `hearth.ts`, `ui/digest-app.ts` |

## Before you start

- The Echo Dot must be on **Alexa+**, which is US only today. Ask it *"Alexa, are you Alexa+?"*. It must be registered to the same Amazon account as your Alexa developer account, with locale en-US.
- You need an Alexa developer account with your profile completed and the marketplace set to US, plus an AWS account.
- You need **Node.js 24+** for the Alexa AI CLI. Hearth itself runs on Node 22.18+.
- You need a tunnel tool: [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (`brew install cloudflared`) or ngrok.

## Step by step

### 1. Expose Hearth over HTTPS

```bash
cloudflared tunnel --url http://localhost:8787
# → https://<random-words>.trycloudflare.com   (keep this terminal open)
```

Quick tunnels get a new URL every time they restart. For a demo that runs over several days, use a [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/) or a reserved ngrok domain. Alexa+ caches the URL at deploy time.

### 2. Generate OAuth credentials and the household PIN

```bash
npm run alexa:credentials -- https://<random-words>.trycloudflare.com
```

This writes `HEARTH_PUBLIC_URL`, `HEARTH_OAUTH_CLIENT_ID`, `HEARTH_OAUTH_CLIENT_SECRET` and `HEARTH_LINK_PIN` to `.env`, and prints the client ID and PIN.

Optionally, for real push alerts, add `HEARTH_NTFY_TOPIC=hearth-<something-unique>` to `.env`, run `npm run seed`, and subscribe to that topic in the ntfy phone app.

### 3. Start Hearth in Alexa+ mode

```bash
npm run dev:server
# Alexa+ OAuth enabled for https://<random-words>.trycloudflare.com/mcp
```

Check it's reachable from the internet:

```bash
curl https://<random-words>.trycloudflare.com/.well-known/oauth-protected-resource
```

### 4. Install the Alexa AI CLI and sign in

Follow [Set up your development environment](https://developer.amazon.com/docs/alexaplus/add-ons/set-up-your-development-environment.html). It covers AWS profiles and the CodeArtifact registry, which have to be set up before the install below works.

```bash
npm install -g @alexa-ai/cli
alexa-ai configure          # Login with Amazon in the browser
```

### 5. Scaffold the add-on and fill in Hearth's details

```bash
cd alexa
alexa-ai new mcp --name "Hearth Family Care" --locale en-US \
  --mcp-server-url "https://<random-words>.trycloudflare.com/mcp"
#   → answer Y to account linking
cd ..
node alexa/configure-addon.ts alexa/<generated-dir>/addon-package/addon.json https://<random-words>.trycloudflare.com
```

`configure-addon.ts` fills in the endpoint, listing text (`alexa/listing.json`), privacy and terms URLs, the six icon sizes and the carousel image. Anything it can't find in the scaffold is printed so you can paste it in.

### 6. Deploy and configure account linking

```bash
cd alexa/<generated-dir>
alexa-ai deploy                               # prints your Add-on ID
alexa-ai configure-account-linking --addon-id <ADDON_ID> --stage development \
  --client-id <HEARTH_OAUTH_CLIENT_ID from .env>
#   paste HEARTH_OAUTH_CLIENT_SECRET at the masked prompt (or export ALEXA_CLIENT_SECRET first)
alexa-ai deploy --yes                         # redeploy so Alexa picks up the auth metadata
```

Hearth accepts whatever `https` redirect URI Alexa sends and binds the code to it, so you don't need to copy redirect URIs into Hearth.

### 7. Link your household

1. Ask the Echo Dot something that needs Hearth, for example *"Alexa, did I take my pills this morning?"*. Hearth answers `401`, so Alexa+ sends a linking prompt to the **Alexa app** on your phone. (The add-on detail page in the Alexa app also has a link button.)
2. The Hearth page opens: *"Link Hearth to Alexa"*. Enter the **household PIN** from step 2.
3. Ask again. Alexa+ now calls Hearth with a user token.

### 8. Test on the Echo Dot

To start, route a web-simulator session to your device, as described in [Test your MCP add-ons](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-test-add-ons.html). Then just talk to it:

| Say to the Echo Dot | Hearth tool |
|---|---|
| "Alexa, did I take my pills this morning?" | `whats_due` |
| "I just took my lisinopril and metformin." | `record_dose` ×2, then a refill warning |
| "I slept badly and my knee hurts, maybe a seven." | `log_checkin` → concern level "watch" |
| "I tripped on the rug and I feel dizzy." | `log_checkin` → urgent → Alexa offers to alert Priya → `notify_family` |
| "How has Mom been doing this week?" | `family_digest` (spoken; shown as a card on an Echo Show) |
| "Mom's knee appointment needs a driver. Raj can take her." | `assign_driver` → Raj gets a push |
| "Tell Raj thanks for the groceries." | `notify_family` (read back and confirmed) |

Watch the Hearth terminal while you talk. Every Alexa+ request shows up there, which makes good B-roll for the demo video.

## Troubleshooting

- **Deploy fails on auth.** Check that `curl $HEARTH_PUBLIC_URL/.well-known/oauth-authorization-server` lists `S256` and `client_credentials`, and that `HEARTH_PUBLIC_URL` exactly matches the tunnel URL.
- **Alexa says the skill isn't responding.** The tunnel URL may have changed. Update `.env`, restart Hearth, and run `alexa-ai deploy` again.
- **Linking page says "Unknown client_id".** The `--client-id` you passed doesn't match `HEARTH_OAUTH_CLIENT_ID`.
- **Too many PIN attempts.** Linking locks for 5 minutes after 5 wrong PINs.
- **You want to see the raw MCP traffic.** Keep using the web simulator (`npm run dev:sim`) alongside the device. It talks to the same Hearth server with `HEARTH_TOKEN`, so the device and the simulator share one household state.
