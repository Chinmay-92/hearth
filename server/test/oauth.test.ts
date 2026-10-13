// Exercises the Alexa+ MCP Toolkit auth contract end to end over HTTP:
// metadata discovery, client_credentials service tokens, account linking with
// PKCE, refresh rotation, scope enforcement on /mcp, and the 500 ms budget.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { createApp } from "../src/app.ts";
import { OAuthServer } from "../src/oauth.ts";
import { seedDemo } from "../src/seed.ts";
import { CareStore } from "../src/store.ts";

process.env.HEARTH_DRY_RUN = "1";
const CLIENT_ID = "alexa-test";
const CLIENT_SECRET = "s3cret-value";
const PIN = "246810";
const REDIRECT = "https://alexa.amazon.com/api/skill/link/TESTVENDOR";

describe("Alexa+ OAuth", () => {
  let base: string;
  let resource: string;
  let close: () => Promise<void>;
  let http: ReturnType<ReturnType<typeof createApp>["app"]["listen"]>;

  before(async () => {
    const store = new CareStore(":memory:", () => new Date(2026, 9, 12, 9, 0));
    seedDemo(store);
    const oauth = new OAuthServer(store.db, { publicUrl: "http://pending", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, linkPin: PIN, household: () => "Margaret's home" });
    const created = createApp(store, { oauth, token: "static-dev-token", publicHosts: ["hearth-demo.example.com"] });
    close = created.close;
    http = created.app.listen(0, "127.0.0.1");
    await new Promise((r) => http.once("listening", r));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    oauth.setPublicUrl(base); // the resource URI must match the real port
    resource = `${base}/mcp`;
  });
  after(async () => {
    await close();
    http.close();
  });

  const basic = (id = CLIENT_ID, secret = CLIENT_SECRET) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
  const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
  const token = (body: Record<string, string>, auth = basic()) =>
    fetch(`${base}/oauth/token`, { method: "POST", headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" }, body: form(body) });
  const mcp = (bearer: string | null, body: unknown, sid?: string) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(sid ? { "mcp-session-id": sid, "mcp-protocol-version": "2025-11-25" } : {}),
      },
      body: JSON.stringify(body),
    });
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: { roots: { listChanged: true } }, clientInfo: { name: "Alexa+ MCP Client", version: "1.0.0" } } };

  async function openSession(bearer: string) {
    const r = await mcp(bearer, initialize);
    assert.equal(r.status, 200);
    await r.text();
    const sid = r.headers.get("mcp-session-id")!;
    assert.equal((await mcp(bearer, { jsonrpc: "2.0", method: "notifications/initialized" }, sid)).status, 202);
    return sid;
  }

  async function linkAccount() {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = { client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", scope: "mcp:tools mcp:resources", state: "xyz", code_challenge: challenge, code_challenge_method: "S256", resource };
    const page = await fetch(`${base}/oauth/authorize?${form(params)}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Margaret&#39;s home|Margaret's home/);
    const approved = await fetch(`${base}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ ...params, pin: PIN }) });
    assert.equal(approved.status, 302);
    const loc = new URL(approved.headers.get("location")!);
    assert.equal(loc.origin + loc.pathname, REDIRECT);
    assert.equal(loc.searchParams.get("state"), "xyz");
    const code = loc.searchParams.get("code")!;
    const r = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT_ID, code_verifier: verifier, resource });
    assert.equal(r.status, 200);
    return { ...(await r.json()), code, verifier } as { access_token: string; refresh_token: string; scope: string; expires_in: number; code: string; verifier: string };
  }

  test("publishes protected-resource and authorization-server metadata", async () => {
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    assert.equal(prm.resource, resource);
    assert.deepEqual(prm.authorization_servers, [base]);
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.ok(as.grant_types_supported.includes("client_credentials"));
    assert.ok(as.code_challenge_methods_supported.includes("S256"));
    assert.ok(as.scopes_supported.includes("mcp:service"));
  });

  test("unauthenticated /mcp gets 401 without WWW-Authenticate", async () => {
    const r = await mcp(null, initialize);
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("www-authenticate"), null);
    assert.equal((await r.json()).error, "unauthorized");
  });

  test("client_credentials: service token can initialize + list tools, but tools/call returns 401 to trigger linking", async () => {
    assert.equal((await token({ grant_type: "client_credentials", scope: "mcp:service", resource }, basic(CLIENT_ID, "wrong"))).status, 401);
    assert.equal((await token({ grant_type: "client_credentials", scope: "mcp:tools", resource })).status, 400);
    const r = await token({ grant_type: "client_credentials", scope: "mcp:service", resource });
    assert.equal(r.status, 200);
    const t = await r.json();
    assert.equal(t.scope, "mcp:service");
    assert.equal(t.refresh_token, undefined);
    assert.ok(t.expires_in <= 3600);

    const sid = await openSession(t.access_token);
    const list = await mcp(t.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
    assert.equal(list.status, 200);
    assert.match(await list.text(), /whats_due/);
    const call = await mcp(t.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "whats_due", arguments: {} } }, sid);
    assert.equal(call.status, 401);
    assert.equal(call.headers.get("www-authenticate"), null);
  });

  test("account linking: PKCE code flow yields a user token that can call tools within 500 ms", async () => {
    const t = await linkAccount();
    assert.equal(t.scope, "mcp:tools mcp:resources");
    assert.ok(t.refresh_token);
    const sid = await openSession(t.access_token);
    const started = performance.now();
    const call = await mcp(t.access_token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "family_digest", arguments: { days: 7 } } }, sid);
    const body = await call.text();
    const ms = performance.now() - started;
    assert.equal(call.status, 200);
    assert.match(body, /adherence/);
    assert.ok(ms < 500, `family_digest took ${ms.toFixed(0)} ms`);
  });

  test("authorization codes are single-use and PKCE-bound; wrong PIN is rejected", async () => {
    const t = await linkAccount();
    const replay = await token({ grant_type: "authorization_code", code: t.code, redirect_uri: REDIRECT, client_id: CLIENT_ID, code_verifier: t.verifier, resource });
    assert.equal(replay.status, 400);
    const verifier = randomBytes(32).toString("base64url");
    const params = { client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" };
    const bad = await fetch(`${base}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ ...params, pin: "000000" }) });
    assert.equal(bad.status, 401);
    const plain = await fetch(`${base}/oauth/authorize?${form({ ...params, code_challenge_method: "plain" })}`);
    assert.equal(plain.status, 400);
  });

  test("refresh tokens rotate (Alexa sends no resource on refresh)", async () => {
    const t = await linkAccount();
    const r1 = await token({ grant_type: "refresh_token", refresh_token: t.refresh_token });
    assert.equal(r1.status, 200);
    const n1 = await r1.json();
    assert.ok(n1.access_token && n1.refresh_token && n1.refresh_token !== t.refresh_token);
    assert.equal((await token({ grant_type: "refresh_token", refresh_token: t.refresh_token })).status, 400);
  });

  test("the static dev token still works alongside OAuth", async () => {
    const sid = await openSession("static-dev-token");
    const call = await mcp("static-dev-token", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whats_due", arguments: {} } }, sid);
    assert.equal(call.status, 200);
  });

  test("accepts the tunnel's Host header but still rejects unknown hosts", async () => {
    const { request } = await import("node:http");
    const status = (host: string) =>
      new Promise<number>((resolve) => {
        const req = request(`${base}/.well-known/oauth-protected-resource`, { headers: { host } }, (res) => (res.resume(), resolve(res.statusCode!)));
        req.end();
      });
    assert.equal(await status("hearth-demo.example.com"), 200);
    assert.equal(await status("evil.example"), 403);
  });

  test("listing pages and art are public", async () => {
    for (const path of ["/privacy", "/terms", "/assets/icon-72.png", "/assets/carousel.png"]) {
      assert.equal((await fetch(base + path)).status, 200, path);
    }
  });
});
