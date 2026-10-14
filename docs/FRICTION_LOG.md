# Friction log and feature requests

These are the problems we hit while building Hearth, an MCP server for Alexa+ that also serves the web simulator and any other MCP client. Each entry gives the task, the steps we took, expected versus actual result, a severity, the workaround in the repo and a suggestion. The workarounds are real code you can read in this repo. Lines marked ✏️ need the author's first-hand details.

Severity scale: **Critical** blocks the build, **High** causes a spec violation or a broken flow if missed, **Medium** costs hours, **Low** is a papercut.

---

## 1. The SDK's Streamable HTTP transport ships with Origin validation off

- **Task:** Expose Hearth's `/mcp` endpoint over Streamable HTTP so that both Alexa+ and browser clients can reach it.
- **Steps:** Followed the `@modelcontextprotocol/sdk` 1.32.1 quick-start: `StreamableHTTPServerTransport` behind Express, with sessions keyed by `Mcp-Session-Id`. Then ran our conformance probe against it, sending `Origin: https://mcp-http-probe.invalid`.
- **Expected:** A 403. MCP 2025-11-25 (Transports → Security Warning) says servers **MUST** validate the `Origin` header to prevent DNS rebinding.
- **Actual:** The request succeeded. DNS-rebinding protection is off by default. `allowedOrigins` only rejects when an Origin header is present *and* a list has been configured, so a server built from the quick-start fails a MUST-level rule.
- **Severity:** High (a security default that conflicts with the spec)
- **Workaround:** Our own `originGuard` middleware in `server/src/app.ts` rejects unknown origins with a JSON-RPC 403 and allows localhost and configured origins. We also built [`mcp-http-probe`](https://github.com/Chinmay-92/mcp-http-probe) so this gets caught in CI for any server.
- **Suggestion:** Turn Origin validation on by default in the transport, with an explicit opt-out. Also update the quick-start so its output passes the spec's MUSTs.

## 2. No guidance for browser-based MCP clients (CORS)

- **Task:** Let the Alexa+ web simulator's MCP Apps host and other browser MCP clients talk to Hearth directly.
- **Steps:** Called `/mcp` from a page on another localhost port.
- **Expected:** SDK documentation on which headers a browser client needs.
- **Actual:** Neither the SDK nor its docs cover it. Unless `Mcp-Session-Id` is exposed, the browser can't read the session ID. Preflight fails unless `Mcp-Protocol-Version` and `Last-Event-ID` are allowed.
- **Severity:** Medium
- **Workaround:** `server/src/app.ts` sets `Access-Control-Expose-Headers: Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate` and `Access-Control-Allow-Headers: Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID`, and answers `OPTIONS /mcp`.
- **Suggestion:** Ship an opt-in CORS helper in the SDK, or at least document the header list next to the Streamable HTTP server example.

## 3. Alexa+ MCP Toolkit wants a bare 401, the MCP spec wants `WWW-Authenticate`

- **Task:** Trigger Alexa+ account linking when a service token tries to touch household data.
- **Steps:** Read the Alexa+ MCP Toolkit authorization docs and the MCP 2025-11-25 Authorization section side by side.
- **Expected:** One 401 response shape that works for Alexa+ and for spec-following clients.
- **Actual:** The toolkit says to return `401` **without** `WWW-Authenticate` to start linking. MCP 2025-11-25 says servers **MUST** include `WWW-Authenticate` (pointing at the Protected Resource Metadata) so clients can discover the authorization server. A server serving both kinds of client has to pick one.
- **Severity:** High
- **Workaround:** We chose Alexa+. `mcpAuth()` in `server/src/oauth.ts` always sends a bare 401 with a JSON body and no `WWW-Authenticate`. RFC 9728 metadata is still published at `/.well-known/oauth-protected-resource`, so spec clients that probe the well-known path can still find the authorization server.
- **Suggestion:** Have Alexa+ accept (ignore) `WWW-Authenticate` on 401, or document a flag or header that tells the two cases apart.

## 4. Inconsistencies in the toolkit docs (protocol version, token auth, scope name)

- **Task:** Build the OAuth 2.1 authorization server Alexa+ expects (`client_credentials` service tokens plus PKCE account linking).
- **Steps:** Implemented the toolkit's client lifecycle and runtime flow pages step by step in `server/src/oauth.ts`.
- **Expected:** One consistent contract.
- **Actual:**
  - The client-lifecycle example shows Alexa+ initializing with protocol `2025-03-26`, while the hackathon requires `2025-11-25`.
  - The token endpoint is described as taking client credentials in "the authorization header or POST body", but the table says HTTP Basic only.
  - The runtime flow says `mcp:resource` where every other page says `mcp:resources`.
  - The Protected Resource Metadata path is given only as "the well-known URI".
- **Severity:** Medium
- **Workaround:** We accept both: `token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"]`, protocol negotiation that serves `2025-11-25` and still answers older `2025-03-26` clients, `mcp:resources` as the scope, and PRM at the RFC 9728 path. `server/test/oauth.test.ts` locks this contract down.
- **Suggestion:** Run one pass over the toolkit docs against the 2025-11-25 spec and publish a machine-readable contract (sample requests and responses) for the OAuth exchange.

## 5. Alexa AI CLI setup: AWS profiles, CodeCommit, and a CodeArtifact token that expires every 12 hours

- **Task:** Install `@alexa-ai/cli` to scaffold, deploy and configure account linking for the add-on.
- **Steps:** Followed "Set up your development environment": AWS profiles, Git for CodeCommit, then a CodeArtifact npm registry login, then `npm install -g @alexa-ai/cli`. ✏️ add the step that cost the most time.
- **Expected:** `npm install -g @alexa-ai/cli` from the public registry.
- **Actual:** The install fails until the AWS and CodeArtifact setup is done. The CodeArtifact token expires every 12 hours, so the next day's install or update fails until you log in again. ✏️ add the exact error text if you kept it.
- **Severity:** Medium (it's onboarding time, not a blocker)
- **Workaround:** Followed the setup guide and re-ran the CodeArtifact login each day. `alexa/README.md` step 4 warns readers in advance.
- **Suggestion:** Publish the CLI to public npm, or have the CLI refresh its own registry token.

## 6. Quick tunnels change URL, and Alexa+ caches the URL at deploy time

- **Task:** Test the add-on on a real Echo Dot against Hearth running on a laptop.
- **Steps:** Ran `cloudflared tunnel --url http://localhost:8787`, then `alexa-ai deploy`, then restarted the tunnel later.
- **Expected:** A simple way to point the development add-on at a new URL.
- **Actual:** Each restart gives a new URL. Alexa+ keeps calling the old one until you update `.env`, restart Hearth and run `alexa-ai deploy` again, and the OAuth metadata URLs have to change with it. ✏️ confirm whether you hit this and how often.
- **Severity:** Low
- **Workaround:** `npm run alexa:credentials -- <url>` rewrites `HEARTH_PUBLIC_URL` and the OAuth settings in one step. `alexa/README.md` recommends a named tunnel for demos that run several days.
- **Suggestion:** Add a `--mcp-server-url` override to `alexa-ai deploy` for the development stage, or a toolkit dev mode that tunnels to localhost like other local-dev tools do.

## 7. MCP Apps: `initialize` vs `ui/initialize`, and two `resourceUri` keys

- **Task:** Render the family digest as an MCP App card (`ui://hearth/digest`) in our simulator host and in other hosts.
- **Steps:** Implemented the host side (`simulator/public/app.js`) and the app side (`server/src/ui/digest-app.ts`) from the MCP Apps extension spec.
- **Expected:** One handshake method name and one metadata key.
- **Actual:** The handshake appears as `initialize` in the transport example and as `ui/initialize` in the lifecycle section. The flat `ui/resourceUri` tool metadata key is deprecated in favour of `_meta.ui.resourceUri`, but some hosts still read only the flat key.
- **Severity:** Medium
- **Workaround:** We use `ui/initialize` (per the lifecycle section) and send both keys on `family_digest`: `_meta.ui.resourceUri` and `_meta["ui/resourceUri"]`.
- **Suggestion:** Fix the example and add a conformance test for hosts. Give a date when the flat key stops being read.

## 8. There's no published list of which MCP client features Alexa+ supports

- **Task:** Decide which MCP features Hearth can rely on with Alexa+: form elicitation, MCP Apps on screen and screenless devices, logging notifications, and the per-call timeout.
- **Steps:** Searched the toolkit docs for Alexa+'s `initialize` capabilities and its limits.
- **Expected:** A table of client capabilities per device type.
- **Actual:** We couldn't find one. The 500 ms tool-call budget is documented, but elicitation and MCP Apps support per surface are not. ✏️ note what your Echo Dot actually declared, if you logged its `initialize` request.
- **Severity:** Medium (we had to design every flow twice)
- **Workaround:** A fallback for each feature. `notify_family` has a `confirmed` flag that does a read-back when elicitation isn't available. `schedule_appointment` hands off to `assign_driver`. All tool text is written for voice first. Alerts are sent in the background so tool calls stay under 500 ms; `test/oauth.test.ts` checks this.
- **Suggestion:** Publish the `initialize` capabilities Alexa+ sends per device class, and log them in the developer console.

---

# Feature requests

| # | Request | Why it matters to Hearth | Priority |
|---|---|---|---|
| 1 | **Alexa+ client capability matrix:** the capabilities Alexa+ declares on `initialize` (elicitation form/url, MCP Apps, logging, sampling) per device class, plus timeouts | Hearth's best moments (consent before alerting family, the driver picker, the digest card) depend on elicitation and MCP Apps. Without the matrix we maintain two code paths for every flow. | Critical |
| 2 | **Spec-compatible 401 handling:** Alexa+ starts linking even when `WWW-Authenticate` is present | Lets one Hearth deployment serve Alexa+, Claude, MCP Inspector and other spec clients without a mode switch | Important |
| 3 | **Proactive notifications from an MCP add-on to a linked Echo** (e.g. an announcement or notification ring on Sarah's device) | Urgent alerts and Hearth's overdue-dose reminders currently go out by ntfy push or webhook, plus MCP `notifications/message` to screens that hold an MCP session. An Echo only hears Hearth when someone speaks to it, so a reminder to Mom waits until she next asks. A notification ring on the linked device would keep the whole loop inside Alexa+. | Important |
| 4 | **Public npm package for `@alexa-ai/cli`**, or self-refreshing registry auth | Removes the AWS, CodeCommit and CodeArtifact steps and the 12-hour token expiry from onboarding | Important |
| 5 | **Speaker identity passed to the MCP server** (a recognized voice profile as a claim or header) | Hearth needs to know whether it's Mom or her daughter speaking: who logs a dose and who reads the digest. Our workaround binds a person to each linked device ("Who uses this Alexa?" at account linking, carried in the OAuth token), which breaks down on a shared kitchen Echo. A voice-profile claim would fix that. | Nice-to-have |
| 6 | **Origin validation on by default in `@modelcontextprotocol/sdk` Streamable HTTP**, plus a CORS helper | Secure by default; servers built from the quick-start currently fail a MUST in the spec | Important |
