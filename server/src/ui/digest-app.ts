// MCP App (io.modelcontextprotocol/ui) view for the family_digest tool.
// Self-contained HTML: it performs the ui/initialize handshake with the host
// over postMessage, waits for ui/notifications/tool-result, and renders the
// structuredContent. No network access, no external assets.

export const DIGEST_UI_URI = "ui://hearth/digest";
export const MCP_APP_MIME = "text/html;profile=mcp-app";

export function digestAppHtml(): string {
  return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Family digest</title>
<style>
  :root {
    --bg: #fbf7f2; --card: #ffffff; --ink: #2b2420; --muted: #7a6d64; --line: #ece3da;
    --ember: #d9622b; --sage: #4f8a6b; --sky: #4a78a8; --warn-bg: #fff1e8;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1d1916; --card: #26211d; --ink: #f3ebe3; --muted: #b3a597; --line: #3a322c; --warn-bg: #3a2519; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); }
  .wrap { padding: 18px; display: grid; gap: 14px; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  h1 { font-size: 20px; margin: 0; font-weight: 650; }
  .sub { color: var(--muted); font-size: 13px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
  .kpi { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; }
  .kpi b { display: block; font-size: 26px; font-variant-numeric: tabular-nums; line-height: 1.1; }
  .kpi span { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px; }
  .card h2 { font-size: 13px; margin: 0 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; font-weight: 600; }
  .flags { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .flags li { background: var(--warn-bg); border-left: 3px solid var(--ember); padding: 8px 10px; border-radius: 8px; }
  .ok { color: var(--sage); }
  svg { width: 100%; height: auto; display: block; }
  .legend { display: flex; gap: 14px; font-size: 12px; color: var(--muted); margin-top: 6px; }
  .legend i { display: inline-block; width: 10px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 5px; }
  .row { display: flex; justify-content: space-between; gap: 10px; padding: 6px 0; border-top: 1px solid var(--line); }
  .row:first-of-type { border-top: 0; }
  .pill { font-size: 12px; padding: 2px 8px; border-radius: 99px; background: var(--line); white-space: nowrap; }
  .pill.need { background: var(--ember); color: white; }
  .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
  .empty { color: var(--muted); padding: 30px; text-align: center; }
</style>
</head>
<body>
<div id="root" class="empty">Waiting for Hearth…</div>
<script>
(() => {
  const root = document.getElementById("root");
  let nextId = 1;
  const pending = new Map();
  const post = (msg) => window.parent.postMessage({ jsonrpc: "2.0", ...msg }, "*");
  const request = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); post({ id, method, params }); });

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === "ui/notifications/tool-result") render(m.params && m.params.structuredContent);
  });

  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    clientInfo: { name: "hearth-digest", version: "0.1.0" },
    appCapabilities: {},
  }).then(() => post({ method: "ui/notifications/initialized", params: {} }));

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtDay = (iso) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  function chart(series) {
    const W = 560, H = 170, P = { l: 28, r: 10, t: 10, b: 24 };
    const n = series.length, x = (i) => P.l + (i * (W - P.l - P.r)) / Math.max(1, n - 1);
    const y = (v, max) => H - P.b - (v / max) * (H - P.t - P.b);
    const line = (key, max, color) => {
      let d = "", pen = false;
      series.forEach((r, i) => { const v = r[key]; if (v == null) { pen = false; return; } d += (pen ? "L" : "M") + x(i).toFixed(1) + " " + y(v, max).toFixed(1) + " "; pen = true; });
      const dots = series.map((r, i) => r[key] == null ? "" : '<circle cx="' + x(i) + '" cy="' + y(r[key], max) + '" r="3" fill="' + color + '"><title>' + key + ": " + r[key] + '</title></circle>').join("");
      return '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' + dots;
    };
    const bars = series.map((r, i) => {
      if (!r.dosesScheduled) return "";
      const missed = r.dosesScheduled - r.dosesTaken;
      return missed ? '<rect x="' + (x(i) - 4) + '" y="' + (H - P.b + 4) + '" width="8" height="' + Math.min(14, missed * 5) + '" rx="2" fill="var(--ember)"><title>' + missed + ' missed dose(s)</title></rect>' : "";
    }).join("");
    const grid = [0, 5, 10].map((v) => '<line x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + y(v, 10) + '" y2="' + y(v, 10) + '" stroke="var(--line)"/><text x="4" y="' + (y(v, 10) + 4) + '" font-size="10" fill="var(--muted)">' + v + '</text>').join("");
    const labels = series.map((r, i) => (i % Math.ceil(n / 7) === 0 || i === n - 1) ? '<text x="' + x(i) + '" y="' + (H - 2) + '" font-size="10" text-anchor="middle" fill="var(--muted)">' + new Date(r.day + "T12:00").toLocaleDateString("en-US", { weekday: "short" }) + '</text>' : "").join("");
    return '<svg viewBox="0 0 ' + W + ' ' + (H + 14) + '" role="img" aria-label="Pain, sleep and mood trends">' + grid + line("pain", 10, "var(--ember)") + line("sleep", 10, "var(--sky)") + line("mood", 10, "var(--sage)") + bars + labels + '</svg>';
  }

  function render(d) {
    if (!d) return;
    root.className = "wrap";
    const sched = d.series.reduce((a, r) => a + r.dosesScheduled, 0);
    const missed = sched - d.series.reduce((a, r) => a + r.dosesTaken, 0);
    const last = [...d.series].reverse().find((r) => r.pain != null) || {};
    // Mood is 1-5; plot it on the 0-10 axis by doubling.
    const series = d.series.map((r) => ({ ...r, mood: r.mood == null ? null : r.mood * 2 }));
    root.innerHTML =
      '<header><h1>How ' + esc(d.recipient) + ' is doing</h1><span class="sub">Last ' + d.periodDays + ' days · updated ' + fmtTime(d.generatedAt) + '</span></header>' +
      '<div class="kpis">' +
        '<div class="kpi"><b>' + (d.adherencePercent ?? "–") + '%</b><span>Meds taken</span></div>' +
        '<div class="kpi"><b>' + missed + '</b><span>Missed doses</span></div>' +
        '<div class="kpi"><b>' + (last.pain ?? "–") + '<small>/10</small></b><span>Latest pain</span></div>' +
        '<div class="kpi"><b>' + (last.sleep ?? "–") + '<small>h</small></b><span>Latest sleep</span></div>' +
      '</div>' +
      '<div class="card"><h2>Needs attention</h2>' + (d.flags.length ? '<ul class="flags">' + d.flags.map((f) => '<li>' + esc(f) + '</li>').join("") + '</ul>' : '<div class="ok">Nothing unusual this week.</div>') + '</div>' +
      '<div class="card"><h2>Trends</h2>' + chart(series) +
        '<div class="legend"><span><i style="background:var(--ember)"></i>Pain (0–10)</span><span><i style="background:var(--sky)"></i>Sleep (h)</span><span><i style="background:var(--sage)"></i>Mood (×2)</span><span><i style="background:var(--ember);height:8px;width:6px"></i>Missed doses</span></div></div>' +
      '<div class="grid2">' +
        '<div class="card"><h2>Coming up</h2>' + (d.upcomingAppointments.length ? d.upcomingAppointments.map((a) => '<div class="row"><span>' + esc(a.title) + '<br><span class="sub">' + fmtDay(a.at) + ' · ' + fmtTime(a.at) + '</span></span><span class="pill ' + (a.driver ? "" : "need") + '">' + (a.driver ? "🚗 " + esc(a.driver) : "Needs driver") + '</span></div>').join("") : '<div class="sub">No appointments in the next two weeks.</div>') + '</div>' +
        '<div class="card"><h2>Family notes</h2>' + (d.recentNotes.length ? d.recentNotes.map((n) => '<div class="row"><span>' + esc(n.text) + '</span><span class="sub">' + esc(n.author) + '</span></div>').join("") : '<div class="sub">No notes yet.</div>') + '</div>' +
      '</div>';
    requestAnimationFrame(() => post({ method: "ui/notifications/size-changed", params: { width: document.body.scrollWidth, height: document.body.scrollHeight } }));
  }
})();
</script>
</body>
</html>`;
}
