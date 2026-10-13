// Alexa+ simulator front end: voice in (Web Speech API), voice out
// (speechSynthesis), an Echo Show-style screen that hosts MCP App cards,
// and server-initiated elicitation answered by tap or by voice.
const $ = (id) => document.getElementById(id);
const device = $("device");
const state = { id: null, busy: false, voice: false, pendingElicit: null };

// ------------------------------------------------------------ session

async function connect() {
  try {
    const r = await fetch("/api/session", { method: "POST" });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    state.id = j.id;
    $("conn").textContent = `connected · ${j.hearth}${j.mode === "playback" ? " · scripted playback (no LLM)" : ""}`;
    refreshAmbient();
  } catch (err) {
    $("conn").textContent = `Not connected: ${err.message}. Start the Hearth server (npm run dev:server) and reload.`;
  }
}

// ------------------------------------------------------------ ambient screen

function tickClock() {
  const now = new Date();
  $("clock").textContent = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M/, "");
  $("date").textContent = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}
setInterval(tickClock, 10_000);
tickClock();

async function refreshAmbient() {
  if (!state.id) return;
  const r = await fetch(`/api/ambient?id=${state.id}`);
  if (!r.ok) return;
  const d = await r.json();
  const cards = [];
  const t = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const overdue = (d.items || []).filter((i) => i.state !== "upcoming");
  const next = (d.items || []).find((i) => i.state === "upcoming");
  if (overdue.length) cards.push({ warn: true, k: "Due now", v: overdue.map((i) => `${i.medication} ${i.dose}`).join(", ") });
  if (next) cards.push({ k: `Next · ${t(next.dueAt)}`, v: `${next.medication} ${next.dose}` });
  if (!overdue.length && !next) cards.push({ k: "Medications", v: "All caught up today" });
  if (d.nextAppointment) cards.push({ k: new Date(d.nextAppointment.at).toLocaleDateString("en-US", { weekday: "long" }), v: d.nextAppointment.title });
  for (const r of d.refills || []) cards.push({ warn: true, k: "Refill soon", v: `${r.medication} · ${r.daysLeft} days left` });
  $("ambientCards").innerHTML = cards.map((c) => `<div class="a-card ${c.warn ? "warn" : ""}"><div class="k">${esc(c.k)}</div><div class="v">${esc(c.v)}</div></div>`).join("");
}
setInterval(refreshAmbient, 60_000);

function showAmbient() {
  $("convo").hidden = true;
  $("ambient").hidden = false;
  refreshAmbient();
}
let idleTimer;
function scheduleIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(showAmbient, 45_000);
}

// ------------------------------------------------------------ turns

async function ask(text) {
  text = text.trim();
  if (!text || state.busy || !state.id) return;
  state.busy = true;
  clearTimeout(idleTimer);
  speechSynthesis.cancel();
  const speaker = document.querySelector('input[name="speaker"]:checked').value;
  $("ambient").hidden = true;
  $("convo").hidden = false;
  $("utterance").textContent = text;
  $("reply").textContent = "";
  $("reply").classList.add("thinking");
  $("cardHost").innerHTML = "";
  device.dataset.state = "thinking";
  log("user", `${speaker} said`, text);

  try {
    const res = await fetch("/api/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: state.id, text, speaker }),
    });
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (chunk.startsWith("data: ")) await onEvent(JSON.parse(chunk.slice(6)));
      }
    }
  } catch (err) {
    onEvent({ type: "error", message: err.message });
  } finally {
    state.busy = false;
    $("reply").classList.remove("thinking");
    if (device.dataset.state === "thinking") device.dataset.state = "idle";
    scheduleIdle();
    refreshAmbient();
  }
}

async function onEvent(e) {
  switch (e.type) {
    case "tool_call":
      log("call", `→ tools/call ${e.name}`, JSON.stringify(e.args, null, 2));
      break;
    case "tool_result":
      log(`result ${e.isError ? "err" : ""}`, `← ${e.name}${e.isError ? " (error)" : ""}`, e.text);
      break;
    case "ui":
      log("ui-ev", `▣ MCP App · ui://`, `Rendering ${e.toolName} card`);
      mountApp(e);
      break;
    case "elicit":
      log("elicit-ev", "? elicitation/create", `${e.message}\n${JSON.stringify(e.schema)}`);
      showElicit(e);
      break;
    case "say":
      $("reply").classList.remove("thinking");
      $("reply").textContent = e.text;
      log("say", "Alexa says", e.text);
      speak(e.text);
      break;
    case "error":
      $("reply").classList.remove("thinking");
      $("reply").textContent = "Sorry, something went wrong.";
      log("result err", "error", e.message);
      break;
  }
}

// ------------------------------------------------------------ MCP Apps host

function mountApp({ html, toolInput, toolResult }) {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("title", "Hearth card");
  frame.srcdoc = html;
  $("cardHost").replaceChildren(frame);
  const reply = (id, result) => frame.contentWindow.postMessage({ jsonrpc: "2.0", id, result }, "*");
  const notify = (method, params) => frame.contentWindow.postMessage({ jsonrpc: "2.0", method, params }, "*");
  const onMsg = (ev) => {
    if (ev.source !== frame.contentWindow) return;
    const m = ev.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.method === "ui/initialize") {
      reply(m.id, {
        protocolVersion: "2026-01-26",
        hostInfo: { name: "alexa-plus-simulator", version: "0.1.0" },
        hostCapabilities: {},
        hostContext: { theme: "light", displayMode: "inline", platform: "web" },
      });
    } else if (m.method === "ui/notifications/initialized") {
      notify("ui/notifications/tool-input", { arguments: toolInput });
      notify("ui/notifications/tool-result", toolResult);
    } else if (m.method === "ui/notifications/size-changed") {
      frame.style.height = `${Math.min(m.params.height + 4, 2000)}px`;
    }
  };
  window.addEventListener("message", onMsg);
}

// ------------------------------------------------------------ elicitation

function showElicit({ requestId, message, schema }) {
  const props = Object.entries(schema?.properties || {});
  const form = $("elicitForm");
  const values = {};
  form.innerHTML = "";
  for (const [key, p] of props) {
    if (p.type === "boolean") { values[key] = p.default ?? true; continue; }
    const options = p.oneOf ? p.oneOf.map((o) => ({ v: o.const, t: o.title || o.const })) : p.enum ? p.enum.map((v) => ({ v, t: v })) : null;
    const field = document.createElement("div");
    field.className = "elicit-field";
    field.innerHTML = `<span>${esc(p.title || key)}</span>`;
    if (options) {
      const row = document.createElement("div");
      row.className = "choices";
      for (const o of options) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = o.t;
        b.dataset.value = o.v;
        b.setAttribute("aria-pressed", "false");
        b.onclick = () => { values[key] = o.v; row.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); };
        row.append(b);
      }
      field.append(row);
    } else {
      const input = document.createElement(p.default && p.default.length > 60 ? "textarea" : "input");
      if (input.tagName === "INPUT") input.type = "text";
      input.value = p.default ?? "";
      values[key] = input.value;
      input.oninput = () => (values[key] = input.value);
      field.append(input);
    }
    form.append(field);
  }
  const actions = document.createElement("div");
  actions.className = "elicit-actions";
  actions.innerHTML = `<button type="button" class="yes">Yes</button><button type="button" class="no">No</button>`;
  form.append(actions);

  const answer = async (action) => {
    if (!state.pendingElicit) return;
    state.pendingElicit = null;
    stopListening();
    $("elicit").hidden = true;
    device.dataset.state = "thinking";
    log("elicit-ev", `↩ elicitation ${action}`, action === "accept" ? JSON.stringify(values) : "");
    await fetch("/api/elicit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: state.id, requestId, action, content: action === "accept" ? values : undefined }),
    });
  };
  actions.querySelector(".yes").onclick = () => answer("accept");
  actions.querySelector(".no").onclick = () => answer("decline");

  state.pendingElicit = { values, answer, choices: props.flatMap(([key, p]) => (p.oneOf || []).map((o) => ({ key, v: o.const, t: (o.title || o.const).toLowerCase() }))) };
  $("elicitMsg").textContent = message;
  $("elicit").hidden = false;
  device.dataset.state = "asking";
  speak(message, () => { if (state.voice && state.pendingElicit) listen(); });
}

function handleElicitSpeech(said) {
  const p = state.pendingElicit;
  const s = said.toLowerCase();
  const choice = p.choices.find((c) => s.includes(c.v.toLowerCase()) || s.includes(c.t.split(" ")[0]));
  if (choice) {
    p.values[choice.key] = choice.v;
    return p.answer("accept");
  }
  if (/\b(yes|yeah|yep|sure|ok(ay)?|please|do it|send it|go ahead)\b/.test(s)) return p.answer("accept");
  if (/\b(no|nope|don'?t|cancel|never ?mind|not now)\b/.test(s)) return p.answer("decline");
  speak("Sorry, was that a yes or a no?", () => listen());
}

// ------------------------------------------------------------ speech

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;

function listen() {
  if (!Recognition) {
    $("text").placeholder = "Voice input needs Chrome or Edge. Type instead.";
    return;
  }
  stopListening();
  recognizer = new Recognition();
  recognizer.lang = "en-US";
  recognizer.interimResults = true;
  recognizer.onresult = (ev) => {
    const r = ev.results[ev.results.length - 1];
    const said = r[0].transcript.replace(/^\s*alexa[,\s]*/i, "");
    $("text").value = said;
    if (r.isFinal) {
      stopListening();
      $("text").value = "";
      if (state.pendingElicit) handleElicitSpeech(said);
      else ask(said);
    }
  };
  recognizer.onend = () => {
    $("mic").classList.remove("on");
    if (device.dataset.state === "listening") device.dataset.state = state.pendingElicit ? "asking" : "idle";
  };
  recognizer.start();
  $("mic").classList.add("on");
  device.dataset.state = "listening";
}

function stopListening() {
  if (recognizer) { recognizer.onend?.(); recognizer.abort(); recognizer = null; }
  $("mic").classList.remove("on");
}

function speak(text, then) {
  if (!$("tts").checked || !("speechSynthesis" in window)) return then?.();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  u.voice = voices.find((v) => /Samantha|Google US English|Jenny|Aria/i.test(v.name)) || voices.find((v) => v.lang === "en-US") || null;
  u.rate = 1.03;
  const prev = device.dataset.state;
  u.onstart = () => { if (!state.pendingElicit) device.dataset.state = "speaking"; };
  u.onend = () => {
    if (device.dataset.state === "speaking") device.dataset.state = state.busy ? "thinking" : "idle";
    then?.();
  };
  u.onerror = () => { device.dataset.state = prev; then?.(); };
  speechSynthesis.speak(u);
}

// ------------------------------------------------------------ trace log

function log(cls, head, body) {
  const li = document.createElement("li");
  li.className = cls;
  const time = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
  li.innerHTML = `<div class="h"><span>${esc(head)}</span><small>${time}</small></div>${body ? `<pre>${esc(body)}</pre>` : ""}`;
  $("log").append(li);
  li.scrollIntoView({ block: "end", behavior: "smooth" });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ------------------------------------------------------------ wiring

const DEMO = [
  ["Margaret", "Did I take my pills this morning?"],
  ["Margaret", "I just took my lisinopril and metformin"],
  ["Margaret", "I slept badly and my knee really hurts on the stairs, maybe a 7"],
  ["Margaret", "I tripped on the rug and I'm a bit dizzy"],
  ["Sarah", "How has Mom been doing this week?"],
  ["Sarah", "Mom's knee appointment needs a driver"],
  ["Sarah", "Book Mom's eye exam next Tuesday at 2, she'll need a ride"],
  ["Margaret", "Tell David thank you for the groceries"],
];
$("chips").innerHTML = DEMO.map(([who, t], i) => `<button type="button" data-i="${i}" title="as ${who}">${esc(t)}</button>`).join("");
$("chips").onclick = (ev) => {
  const b = ev.target.closest("button");
  if (!b) return;
  const [who, t] = DEMO[Number(b.dataset.i)];
  document.querySelector(`input[name="speaker"][value="${who}"]`).checked = true;
  state.voice = false;
  ask(t);
};
$("askForm").onsubmit = (ev) => {
  ev.preventDefault();
  state.voice = false;
  const t = $("text").value;
  $("text").value = "";
  if (state.pendingElicit) handleElicitSpeech(t);
  else ask(t);
};
$("mic").onclick = () => {
  state.voice = true;
  if (recognizer) stopListening();
  else listen();
};
$("reset").onclick = async () => {
  if (state.id) await fetch("/api/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: state.id }) });
  $("log").innerHTML = "";
  showAmbient();
};
speechSynthesis?.getVoices();
connect();

// Exposed for debugging and UI tests.
window.__hearth = { mountApp, showElicit, onEvent };
