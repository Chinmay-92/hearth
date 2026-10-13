// YouTube video ID for the demo (the part after v=). Leave empty to show the poster,
// or drop a file at assets/demo.mp4 to play it locally.
const DEMO_VIDEO_ID = "";

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ------------------------------------------------------------ demo video
(async function mountVideo() {
  const host = $("#video");
  if (DEMO_VIDEO_ID) {
    host.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(DEMO_VIDEO_ID)}?rel=0" title="Hearth demo video" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen loading="lazy"></iframe>`;
    return;
  }
  try {
    const r = await fetch("assets/demo.mp4", { method: "HEAD" });
    const type = r.headers.get("content-type") || "";
    if (r.ok && type.startsWith("video/")) {
      host.innerHTML = `<video controls preload="metadata" playsinline poster="assets/demo-poster.jpg"><source src="assets/demo.mp4" type="video/mp4" />Your browser can't play this video.</video>`;
    }
  } catch { /* keep the poster */ }
})();

// ------------------------------------------------------------ copy buttons
for (const b of $$(".copy")) {
  b.addEventListener("click", async () => {
    const text = $("#" + b.dataset.copy).innerText;
    try {
      await navigator.clipboard.writeText(text);
      b.textContent = "Copied";
    } catch {
      b.textContent = "Select and copy";
    }
    setTimeout(() => (b.textContent = "Copy"), 1600);
  });
}

// ------------------------------------------------------------ terminal
const PROBE = [
  ["SHOULD", "Rejects POST whose Accept omits text/event-stream"],
  ["MUST", "Rejects a foreign Origin (https://mcp-http-probe.invalid) with 403"],
  ["MUST", "initialize succeeds over POST"],
  ["MUST", "Response is application/json or text/event-stream"],
  ["SHOULD", "Negotiates protocol 2025-11-25"],
  ["MUST", "serverInfo has name and version"],
  ["MUST", "Result includes a capabilities object"],
  ["MUST", "Mcp-Session-Id uses only visible ASCII (0x21-0x7E)"],
  ["MUST", "Accepted notification returns 202 with no body"],
  ["MUST", "ping returns an empty result"],
  ["SHOULD", "Unknown method returns JSON-RPC -32601"],
  ["MUST", "Unsupported MCP-Protocol-Version header returns 400"],
  ["SHOULD", "Request without Mcp-Session-Id returns 400"],
  ["MUST", "Unknown Mcp-Session-Id returns 404"],
  ["MUST", "tools/list returns a tools array"],
  ["SHOULD", "Tool names are 1-128 chars of [A-Za-z0-9_.-]"],
  ["MUST", "Every tool has an inputSchema of type object"],
  ["MUST", "Tool names are unique"],
  ["SHOULD", "Every tool has a description"],
  ["INFO", "Server exposes 8 tool(s)"],
  ["MUST", "GET returns an SSE stream or 405"],
  ["SHOULD", "DELETE terminates the session"],
  ["MUST", "Requests on a terminated session return 404"],
];
const CMD = "npx mcp-http-probe http://127.0.0.1:8787/mcp";
const termLines = [
  `mcp-http-probe http://127.0.0.1:8787/mcp  (spec 2025-11-25)\n`,
  ...PROBE.map(([lvl, t]) => `<span class="ok">✔</span> <span class="lvl">${lvl.padEnd(6)}</span> ${t.replace(/</g, "&lt;")}`),
  ``,
  `<span class="sum">23 passed, 0 failed, 0 warnings</span>`,
];
function termFinal() {
  $("#termCmd").textContent = CMD;
  $("#termOut").innerHTML = termLines.join("\n");
}
function termPlay() {
  const cmd = $("#termCmd"), out = $("#termOut");
  cmd.textContent = ""; out.innerHTML = "";
  let i = 0;
  const type = () => {
    cmd.textContent = CMD.slice(0, ++i);
    if (i < CMD.length) return setTimeout(type, 28 + Math.random() * 40);
    let n = 0;
    const next = () => {
      out.innerHTML = termLines.slice(0, ++n).join("\n");
      if (n < termLines.length) setTimeout(next, n === 1 ? 380 : 55);
    };
    setTimeout(next, 420);
  };
  type();
}

// ------------------------------------------------------------ motion
function start() {
  if (reduce || !window.gsap || !window.ScrollTrigger) {
    termFinal();
    $$(".bubble").forEach((b) => (b.style.opacity = 1));
    return;
  }
  gsap.registerPlugin(ScrollTrigger);
  if (window.MotionPathPlugin) gsap.registerPlugin(MotionPathPlugin);

  heroLoop();
  ScrollTrigger.create({ trigger: ".term", start: "top 75%", once: true, onEnter: termPlay });
  archPackets();

  const mm = gsap.matchMedia();
  mm.add("(min-width: 901px)", () => {
    document.documentElement.classList.add("motion");
    const tl = storyTimeline();
    return () => {
      tl.scrollTrigger?.kill();
      tl.kill();
      document.documentElement.classList.remove("motion");
      gsap.set(".steps li, .stage *", { clearProps: "all" });
    };
  });
}

// The one orchestrated moment above the fold: a short exchange with the speaker, on loop.
function heroLoop() {
  const b = $$(".bubble");
  gsap.set(b, { autoAlpha: 0, y: 14 });
  const ring = $(".ring"), glow = $(".ring-glow");
  gsap.set([ring, glow], { opacity: 0.25 });
  const listen = (tl, at) => tl.to([ring, glow], { opacity: 1, duration: 0.35, yoyo: true, repeat: 3, ease: "sine.inOut" }, at);
  const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2, delay: 0.4 });
  tl.to(b[0], { autoAlpha: 1, y: 0, duration: 0.5, ease: "power3.out" });
  listen(tl, "+=0.1");
  tl.to(b[1], { autoAlpha: 1, y: 0, duration: 0.5, ease: "power3.out" }, "-=0.2")
    .to(b[2], { autoAlpha: 1, y: 0, duration: 0.5, ease: "power3.out" }, "+=1.4");
  listen(tl, "+=0.1");
  tl.to(b[3], { autoAlpha: 1, y: 0, duration: 0.5, ease: "power3.out" }, "-=0.2")
    .to([ring, glow], { opacity: 0.25, duration: 0.4 }, "<")
    .to(b, { autoAlpha: 0, y: -10, duration: 0.5, stagger: 0.05, ease: "power2.in" }, "+=2.6");
}

function storyTimeline() {
  const step = (n) => $$(`[data-step="${n}"]`, $(".stage"));
  const text = (n) => $(`.steps li[data-step="${n}"]`);
  const times = { 1: ["8:02", "am", "Asha's kitchen"], 2: ["8:05", "am", "Asha's kitchen"], 3: ["11:40", "am", "Asha's kitchen"], 4: ["11:40", "am", "Asha's kitchen"], 5: ["11:41", "am", "Priya's phone"], 6: ["9:14", "pm", "Priya's home"] };
  const setClock = (n) => {
    const [t, ap, place] = times[n];
    $("#clockTime").textContent = t; $("#clockAmpm").textContent = ap; $("#clockPlace").textContent = place;
  };

  gsap.set(".stage [data-step]", { autoAlpha: 0, y: 16 });
  gsap.set(".steps li", { autoAlpha: 0, y: 24 });
  gsap.set(text(1), { autoAlpha: 1, y: 0 });
  gsap.set(".d-ring-fill", { strokeDasharray: "0 100" });
  gsap.set(".spark", { strokeDasharray: "0 100" });

  const tl = gsap.timeline({
    defaults: { ease: "power2.out", duration: 0.6 },
    scrollTrigger: {
      trigger: ".story-pin", start: () => `top ${$(".top").offsetHeight}px`, end: "+=420%", pin: true, scrub: 0.6,
      snap: { snapTo: (v) => { const h = Object.entries(tl.labels).filter(([k]) => k[0] === "h").map(([, t]) => t / tl.duration()); return h.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a)); }, duration: { min: 0.2, max: 0.6 }, delay: 0.15, ease: "power1.inOut", inertia: false },
      onUpdate: (self) => {
        const t = self.animation.time();
        let n = 1;
        for (let i = 2; i <= 6; i++) if (t >= self.animation.labels["s" + i]) n = i;
        setClock(n);
      },
    },
  });

  const swapText = (from, to, at) => tl.to(text(from), { autoAlpha: 0, y: -24 }, at).to(text(to), { autoAlpha: 1, y: 0 }, "<0.2");

  tl.addLabel("s1")
    .to(step(1), { autoAlpha: 1, y: 0, stagger: 0.15 })
    .to(".mini-ring", { opacity: 1, duration: 0.3, yoyo: true, repeat: 1 }, "<")
    .addLabel("h1", "+=0.25")
    .addLabel("s2", "+=0.5")
    .to(step(1), { autoAlpha: 0, y: -16 }, "s2");
  swapText(1, 2, "s2");
  tl.to(step(2), { autoAlpha: 1, y: 0, stagger: 0.15 }, "s2+=0.2")
    .addLabel("h2", "+=0.25")
    .addLabel("s3", "+=0.5")
    .to(step(2), { autoAlpha: 0, y: -16 }, "s3");
  swapText(2, 3, "s3");
  tl.to(step(3), { autoAlpha: 1, y: 0, stagger: 0.15 }, "s3+=0.2")
    .to(".mini-ring", { stroke: "#ff9a62", opacity: 1 }, "<")
    .addLabel("h3", "+=0.25")
    .addLabel("s4", "+=0.5");
  swapText(3, 4, "s4");
  tl.to(step(3), { autoAlpha: 0.15 }, "s4")
    .fromTo(step(4), { autoAlpha: 0, y: 0, scale: 0.92 }, { autoAlpha: 1, scale: 1, duration: 0.5, ease: "back.out(1.6)" }, "s4+=0.1")
    .addLabel("h4", "+=0.1")
    .to(".elicit .yes", { scale: 0.94, duration: 0.15, yoyo: true, repeat: 1 }, "+=0.2")
    .addLabel("s5", "+=0.4");
  swapText(4, 5, "s5");
  tl.to(step(4), { autoAlpha: 0, scale: 0.96 }, "s5")
    .to(step(3), { autoAlpha: 0 }, "s5")
    .to(".mini-ring", { stroke: "#3fd0ff", opacity: 0.25 }, "s5")
    .fromTo(step(5), { autoAlpha: 0, x: 80, y: 0 }, { autoAlpha: 1, x: 0, duration: 0.6 }, "s5+=0.1")
    .fromTo(".push", { y: -60, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.5, ease: "back.out(1.4)" }, ">-0.1")
    .to(".phone", { rotation: 2, duration: 0.06, yoyo: true, repeat: 5, ease: "none" }, ">")
    .addLabel("h5", "+=0.1")
    .addLabel("s6", "+=0.4");
  swapText(5, 6, "s6");
  tl.to(step(5), { autoAlpha: 0, x: 80 }, "s6")
    .to(step(6), { autoAlpha: 1, y: 0, stagger: 0.12 }, "s6+=0.1")
    .to(".d-ring-fill", { strokeDasharray: "88 100", duration: 0.8 }, "s6+=0.4")
    .to(".spark", { strokeDasharray: "100 100", duration: 0.8 }, "<")
    .from(".d-flags li", { autoAlpha: 0, x: 20, stagger: 0.12 }, "<0.2")
    .to({}, { duration: 0.4 })
    .addLabel("end")
    .addLabel("h6");
  return tl;
}

// Packets travelling between clients, Hearth and its outputs.
function archPackets() {
  if (!window.MotionPathPlugin) return;
  const g = $(".packets");
  const NS = "http://www.w3.org/2000/svg";
  const run = (pathId, cls, delay) => {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("r", "6");
    if (cls) c.setAttribute("class", cls);
    g.appendChild(c);
    return gsap.timeline({ repeat: -1, delay, repeatDelay: 1.8 })
      .fromTo(c, { opacity: 0 }, { opacity: 1, duration: 0.15 })
      .to(c, { duration: 1.4, ease: "power1.inOut", motionPath: { path: `#${pathId}`, align: `#${pathId}`, alignOrigin: [0.5, 0.5] } }, 0)
      .to(c, { opacity: 0, duration: 0.2 }, 1.25);
  };
  const tls = [
    run("p1", "in", 0), run("p2", "in", 0.9), run("p3", "in", 1.6), run("p4", "in", 2.3),
    run("p5", "", 1.2), run("p6", "", 2.0), run("p7", "", 0.5),
  ];
  tls.forEach((t) => t.pause());
  ScrollTrigger.create({
    trigger: ".arch", start: "top 85%", end: "bottom 10%",
    onToggle: (self) => tls.forEach((t) => (self.isActive ? t.play() : t.pause())),
  });
}

if (document.readyState === "complete") start();
else window.addEventListener("load", start);
