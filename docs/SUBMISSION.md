# Devpost submission kit

Copy each section into the matching Devpost field. Edit the parts marked ✏️ before submitting.

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

✏️ Add your own. Candidates from the build:
- Getting elicitation to reach the right device meant one `McpServer` per session over a shared store, instead of one global server.
- The MCP Apps spec examples name the handshake both `initialize` and `ui/initialize`. We implemented `ui/initialize` per the lifecycle section.
- Out of the box, the SDK's Streamable HTTP transport does not validate `Origin`, which the spec requires. We added a guard and then built a probe to catch this in any server.

## Product feedback

**Which tools, APIs and SDKs did you use, and for what?**
- *MCP spec 2025-11-25 and `@modelcontextprotocol/sdk` (TypeScript) 1.32.1*: the server and the simulator's client.
- *MCP Apps extension (`io.modelcontextprotocol/ui`)*: the family digest card.
- *MCP Inspector*: manual testing. ✏️ (only if you used it)
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
- **Setup friction:** installing the Alexa AI CLI requires AWS profiles, Git for CodeCommit and a CodeArtifact npm registry whose token expires every 12 hours. A public npm package would remove most of the onboarding time. ✏️ add your own experience deploying and linking.

**How was onboarding (zero to hello world)?**
Fast for MCP: an SDK server over Streamable HTTP was answering `tools/list` in under 15 minutes. ✏️ Add anything specific to Alexa+.

**Would you build with these again?**
Yes. MCP and elicitation let a single server serve a voice-only grandparent and a screen-first adult child, with the right interaction for each. ✏️

**AWS services:** not used.

## Open Source mini-challenge

- **Contribution URL:** https://github.com/Chinmay-92/mcp-http-probe
- **Project repository URL:** https://github.com/Chinmay-92/hearth
- **GitHub username:** Chinmay-92
- **What it is:** `mcp-http-probe` is a dependency-free CLI and library that black-box tests any MCP server against the Streamable HTTP transport rules of spec 2025-11-25. It runs 23 checks covering Accept negotiation, Origin/DNS-rebinding 403, the initialize result, the session-ID charset, 202 for notifications, ping, -32601, the `MCP-Protocol-Version` 400, session 400/404, tool naming and schemas, GET SSE or 405, and DELETE teardown. Each failure links to the relevant spec section.
- **How it works:** it speaks raw HTTP with `fetch`, parses JSON or SSE responses, drives a real session through its lifecycle, and finishes by tearing the session down. The exit code works as a CI gate. Its tests run it against a compliant SDK server, an SDK server without Origin validation (correctly flagged), and a deliberately sloppy hand-rolled server (seven distinct violations caught).
- **Why it matters:** SDK tests verify the SDK, not your deployment. Real servers break in the glue: session maps, auth middleware, proxies, and default security settings. Because it uses only HTTP, the probe works for MCP servers in any language. Its first run found that a server built from the standard TypeScript SDK example skips a MUST-level Origin check.
