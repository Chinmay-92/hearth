# Devpost submission kit

Copy each section into the matching Devpost field. Before submitting, answer the ✏️ prompts: one or two sentences each, from your own experience.

## Links

- **Website:** ✏️ paste the Vercel URL once it's deployed
- **Demo video (YouTube or Vimeo, public, under 3:00):** ✏️ paste the URL
- **Code repository:** https://github.com/Chinmay-92/hearth (public, MIT license shown in the About panel)
- **Open-source contribution:** https://github.com/Chinmay-92/mcp-http-probe · [npm](https://www.npmjs.com/package/mcp-http-probe) · [GitHub Marketplace](https://github.com/marketplace/actions/mcp-http-probe)

## Tracks

- **Primary track:** Alexa+
- **Mini-challenge:** Open Source

## Tagline

An Alexa+ caregiving co-pilot: one shared memory for an aging parent and the family looking after her, built as a self-hosted MCP server.

## Description

**Hearth** is a self-hosted MCP server (spec 2025-11-25, Streamable HTTP) that turns Alexa+ into a shared memory and early-warning system for families caring for an older relative.

The care recipient just talks: "Did I take my pills?", "I took my metformin", "My knee hurts on the stairs, maybe a 7." Hearth logs each statement, compares it with her recent baseline, and decides whether it matters. Family members ask their own Alexa "How's Mom doing this week?" and get a short spoken answer plus an **MCP App** card on screen devices. The card shows adherence, pain, sleep and mood trends, missed doses, refills running out, and appointments that still need a driver.

It acts as an agent, not just a Q&A bot:
- **Escalation with consent.** When a check-in mentions a fall, chest pain or confusion, the tool uses **elicitation** in the middle of the call to ask "Should I alert Priya right away?" and sends a push notification on a yes.
- **Ride coordination.** Scheduling an appointment asks who will drive (a titled-enum elicitation), records the answer, and notifies that person.
- **State across sessions and people.** Every device and family member shares one household store, so what Mom logs at 8am is in her daughter's 9pm digest.
- **Confirmation fallback.** Clients without elicitation get a read-back-and-confirm flow, so nothing is ever sent without a yes.

**It runs on a real Echo Dot.** Hearth is deployed as an Alexa+ MCP add-on through the Alexa+ MCP Toolkit. It implements what the toolkit requires: OAuth 2.1 service tokens via `client_credentials`, account linking with PKCE where a family member approves in the Alexa app with a household PIN, RFC 9728 Protected Resource Metadata, a bare 401 to trigger linking, and tool round trips under 500 ms.

The repo also includes a **simulated Alexa+ Echo Show**: voice in and out, an ambient home screen, an MCP Apps host, elicitation answered by tap or by voice, and a live MCP trace. Its agent loop is Claude calling Hearth over a real MCP client session.

## How we built it

- TypeScript on Node 22+, run directly through Node's type stripping (no build step), with the official `@modelcontextprotocol/sdk` 1.32.1 (`LATEST_PROTOCOL_VERSION = 2025-11-25`).
- Streamable HTTP with per-session `McpServer` instances over a shared `node:sqlite` store. It supports GET SSE streams, DELETE teardown, Origin validation (403) against DNS rebinding, CORS for browser MCP clients, and optional bearer auth.
- MCP features used: tools with `structuredContent` and annotations, form-mode elicitation (boolean, string and titled-enum `oneOf` fields), resources, a resource template with completion, prompts, logging notifications, and an MCP App (`ui://hearth/digest`, `text/html;profile=mcp-app`, `_meta.ui.resourceUri`).
- Notifications go through ntfy.sh push or any webhook.
- The simulator is Express plus vanilla JS: the Web Speech API, speechSynthesis, an MCP Apps postMessage host, and Claude (`claude-opus-5-5`, adaptive thinking, low effort) through the Anthropic SDK.
- A built-in OAuth 2.1 authorization server (`server/src/oauth.ts`) shaped to the Alexa+ MCP Toolkit: service and user scopes, PKCE S256, single-use codes, rotating refresh tokens, PIN-gated consent with lockout, and Host-header allow-listing for the tunnel.
- 27 automated tests, including an Alexa+-shaped OAuth contract test and a latency budget check. Also: end-to-end MCP over HTTP with the SDK client, including elicitation accept and decline, plus a conformance probe that runs against three reference servers.

## Challenges

✏️ Keep the ones that were hard for you and add one in your own words, e.g. the first time the Echo Dot reached Hearth through the tunnel. Candidates from the build:
- Getting elicitation to reach the right device meant one `McpServer` per session over a shared store, instead of one global server.
- The MCP Apps spec examples name the handshake both `initialize` and `ui/initialize`. We implemented `ui/initialize` per the lifecycle section.
- Out of the box, the SDK's Streamable HTTP transport does not validate `Origin`, which the spec requires. We added a guard and then built a probe to catch this in any server.
- Alexa+ and the MCP spec disagree on the 401 response (bare 401 vs. `WWW-Authenticate`), so one server serving both needed a deliberate choice.
- Keeping every tool call under Alexa+'s 500 ms budget meant moving alert delivery (ntfy and webhooks) into the background and adding a latency test.

## Built during the hackathon

Hearth and `mcp-http-probe` are new projects, started during the submission window (Aug 31 – Oct 23, 2026). The first commit in the repo is dated 2026-10-12, and `git log` shows the full history.

## Testing instructions for judges

Requires Node.js 22.18+.

```bash
git clone https://github.com/Chinmay-92/hearth.git && cd hearth && npm install
npm run dev:server                       # Hearth MCP server on http://127.0.0.1:8787/mcp, seeded demo household
HEARTH_PLAYBACK=1 npm run dev:sim        # simulator on http://127.0.0.1:5173, no API key needed
```

- **Scripted playback (no API key):** `HEARTH_PLAYBACK=1` replays the demo lines (the suggestion chips) through the **real** Hearth MCP server. The tool calls, elicitation prompts, MCP App digest card and MCP trace are all live. Only the spoken replies are pre-written instead of generated by a model.
- **Live agent:** set `ANTHROPIC_API_KEY` and run `npm run dev:sim` without `HEARTH_PLAYBACK`. Claude then decides which Hearth tools to call, and you can say anything.
- **Conformance:** `npm run probe` (23/23 checks pass). **Tests:** `npm test` (27 tests).
- **Other MCP clients:** in MCP Inspector, choose Streamable HTTP and enter `http://127.0.0.1:8787/mcp`.
- **Real Echo device:** see `alexa/README.md`. It needs your own Alexa developer account and a tunnel.

## Product feedback

**Which tools, APIs and SDKs did you use, and for what?**
- *MCP spec 2025-11-25 and `@modelcontextprotocol/sdk` (TypeScript) 1.32.1*: the server and the simulator's client.
- *MCP Apps extension (`io.modelcontextprotocol/ui`)*: the family digest card.
- *MCP Inspector*: ✏️ keep this line only if you used it, otherwise delete it.
- *Anthropic Claude API*: the agent loop in the simulated Alexa+ experience.
- *Alexa+ MCP Toolkit and Alexa AI CLI (`@alexa-ai/cli`)*: deploying Hearth as an Alexa+ add-on with account linking, tested on an Echo Dot.
- *ntfy.sh*: push notifications to family phones.

**What worked well?**
- The SDK made spec 2025-11-25 the default with no configuration. `registerTool`, zod schemas, `structuredContent` and `elicitInput` are concise.
- Elicitation over Streamable HTTP worked first time: the server-to-client request rides on the POST's SSE stream.
- `isInitializeRequest` and `onsessioninitialized` make the session-map pattern straightforward.

**What needs work?**
- **Security default:** `StreamableHTTPServerTransport` ships with DNS-rebinding protection *off*, and `allowedOrigins` only rejects when an Origin header is present *and* a list is configured. The spec says servers MUST validate Origin. The quick-start example produces a server that fails this rule.
- **CORS:** nothing in the SDK or docs covers browser-based MCP clients. You have to know to expose `Mcp-Session-Id` and allow the `Mcp-Protocol-Version` and `Last-Event-ID` headers.
- **MCP Apps spec:** the handshake method is written as `initialize` in the transport example but `ui/initialize` in the lifecycle section. Also, the flat `ui/resourceUri` key is deprecated in favour of `_meta.ui.resourceUri`, but some hosts still read only the flat key, so we send both.
- **Elicitation discoverability:** it's hard to know which Alexa+ surfaces support form elicitation and MCP Apps today. A capability matrix would help, so builders know whether a fallback such as our `confirmed` flag is needed.
- **Alexa+ MCP Toolkit docs vs. the MCP spec:** the toolkit requires a 401 *without* `WWW-Authenticate`, but MCP 2025-11-25 authorization says servers MUST send it for discovery. A server that serves both Alexa+ and spec-following clients has to choose. A documented flag, or Alexa simply ignoring the header, would avoid that.
- **Toolkit docs inconsistencies we hit:** the client-lifecycle example shows Alexa+ initializing with protocol `2025-03-26`, while the hackathon asks for `2025-11-25`. The token endpoint is described as accepting credentials in "the authorization header or POST body" but the table says HTTP Basic only. The runtime flow says `mcp:resource` where everything else says `mcp:resources`. The PRM path is just "the well-known URI".
- **Missing capability matrix:** there's no list of which MCP client features Alexa+ declares (elicitation, MCP Apps on screenless devices, logging) or the per-call timeout. We designed fallbacks for each: a `confirmed` flag, `assign_driver`, and voice-first text.
- **Setup friction:** installing the Alexa AI CLI requires AWS profiles, Git for CodeCommit and a CodeArtifact npm registry whose token expires every 12 hours. A public npm package would remove most of the onboarding time. ✏️ In one sentence: how long did it take from `npm install -g @alexa-ai/cli` to your first successful `alexa-ai deploy`, and what slowed you down most?

**How was onboarding (zero to hello world)?**
Fast for MCP: an SDK server over Streamable HTTP was answering `tools/list` in under 15 minutes. Slower for Alexa+: the CLI install needs AWS, CodeCommit and CodeArtifact set up first (see friction log entry 5). ✏️ One sentence: how long until the Echo Dot first answered from Hearth, and was account linking smooth?

**Would you build with these again?**
Yes. MCP and elicitation let a single server serve a voice-only grandparent and a screen-first adult child, with the right interaction for each. ✏️ Optional: add one personal reason, such as a family member you'd actually set this up for.

**AWS services:** not used.

## Friction log

Paste from [`docs/FRICTION_LOG.md`](FRICTION_LOG.md). It has eight entries, each with task, steps, expected vs. actual, severity, workaround and suggestion:

1. SDK Streamable HTTP transport ships with Origin validation off (High)
2. No guidance for browser-based MCP clients / CORS (Medium)
3. Alexa+ bare 401 vs. MCP spec `WWW-Authenticate` (High)
4. Toolkit docs inconsistencies: protocol version, token auth method, scope name (Medium)
5. Alexa AI CLI setup: AWS profiles, CodeCommit, CodeArtifact token expiring every 12 hours (Medium)
6. Quick tunnels change URL; Alexa+ caches the URL at deploy time (Low)
7. MCP Apps `initialize` vs `ui/initialize`, two `resourceUri` keys (Medium)
8. No published Alexa+ client capability matrix (Medium)

## Feature requests

Paste the table from [`docs/FRICTION_LOG.md`](FRICTION_LOG.md#feature-requests):

1. Alexa+ client capability matrix (Critical)
2. Spec-compatible 401 handling in Alexa+ (Important)
3. Proactive notifications from an MCP add-on to a linked Echo (Important)
4. Public npm package for `@alexa-ai/cli` (Important)
5. Speaker identity passed to the MCP server (Nice-to-have)
6. Origin validation on by default in the TypeScript SDK, plus a CORS helper (Important)

## Open Source mini-challenge

- **Contribution URL:** https://github.com/Chinmay-92/mcp-http-probe (published on [npm](https://www.npmjs.com/package/mcp-http-probe) and as a [GitHub Marketplace Action](https://github.com/marketplace/actions/mcp-http-probe): `uses: Chinmay-92/mcp-http-probe@v1`)
- **Project repository URL:** https://github.com/Chinmay-92/hearth
- **GitHub username:** Chinmay-92
- **What it is:** `mcp-http-probe` is a dependency-free CLI and library that black-box tests any MCP server against the Streamable HTTP transport rules of spec 2025-11-25. It runs 23 checks covering Accept negotiation, Origin/DNS-rebinding 403, the initialize result, the session-ID charset, 202 for notifications, ping, -32601, the `MCP-Protocol-Version` 400, session 400/404, tool naming and schemas, GET SSE or 405, and DELETE teardown. Each failure links to the relevant spec section.
- **How it works:** it speaks raw HTTP with `fetch`, parses JSON or SSE responses, drives a real session through its lifecycle, and finishes by tearing the session down. The exit code works as a CI gate. Its tests run it against a compliant SDK server, an SDK server without Origin validation (correctly flagged), and a deliberately sloppy hand-rolled server (seven distinct violations caught).
- **Why it matters:** SDK tests verify the SDK, not your deployment. Real servers break in the glue: session maps, auth middleware, proxies, and default security settings. Because it uses only HTTP, the probe works for MCP servers in any language. Its first run found that a server built from the standard TypeScript SDK example skips a MUST-level Origin check.
