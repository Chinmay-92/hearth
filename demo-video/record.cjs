// Drives the Alexa+ simulator (scripted playback mode) through the demo and
// captures it with the CDP screencast. Writes frames/ + frames.txt (ffconcat)
// and sim-audio.json (voice clips with start offsets).
// Usage: node record.cjs <simUrl>
const { chromium } = require('playwright');
const fs = require('fs');
const { tts } = require('./tts.cjs');
const N = require('./narration-clips.json');
// Uses Playwright's bundled Chromium unless CHROME_PATH points at another build.
const EXE = process.env.CHROME_PATH || undefined;
const URL_ = process.argv[2];
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

const OVERLAY_CSS = `
#ov-cap{position:fixed;left:50%;bottom:34px;transform:translate(-50%,20px);max-width:1100px;padding:16px 26px;border-radius:16px;
  background:rgba(20,17,15,.88);color:#f6eee6;font:500 22px/1.4 Inter,sans-serif;text-align:center;opacity:0;transition:all .45s cubic-bezier(.2,.8,.2,1);z-index:99;box-shadow:0 12px 40px rgba(0,0,0,.25)}
#ov-cap.on{opacity:1;transform:translate(-50%,0)}
#ov-label{position:fixed;left:600px;top:26px;padding:10px 18px;border-radius:999px;background:#e46a2e;color:#fff;font:600 16px/1 Inter,sans-serif;letter-spacing:.06em;text-transform:uppercase;opacity:0;transform:translateY(-10px);transition:all .4s;z-index:99}
#ov-label.on{opacity:1;transform:none}
#ov-cursor{position:fixed;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;background:rgba(228,106,46,.25);border:3px solid #e46a2e;z-index:100;opacity:0;transition:left .7s cubic-bezier(.3,.7,.2,1),top .7s cubic-bezier(.3,.7,.2,1),opacity .3s,transform .15s;pointer-events:none}
#ov-cursor.tap{transform:scale(.7);background:rgba(228,106,46,.6)}
#ov-phone{position:fixed;right:470px;bottom:250px;width:360px;padding:18px 20px;border-radius:22px;background:#fffdfa;border:1px solid #e2d8cc;box-shadow:0 24px 60px rgba(36,29,24,.28);
  font:400 17px/1.4 Inter,sans-serif;color:#241d18;z-index:99;opacity:0;transform:translateY(40px) scale(.96);transition:all .55s cubic-bezier(.2,.9,.25,1.2)}
#ov-phone.on{opacity:1;transform:none}
#ov-phone .t{display:flex;align-items:center;gap:10px;font:600 15px Inter;color:#7d6f64;margin-bottom:8px}
#ov-phone .t i{width:26px;height:26px;border-radius:7px;background:#e46a2e;display:block}
#ov-phone b{display:block;font-size:18px;margin-bottom:4px}`;

(async () => {
  const b = await chromium.launch({ executablePath: EXE, args: ['--window-size=1600,987', '--force-device-scale-factor=1.2'] });
  const ctx = await b.newContext({ viewport: null });
  const p = await ctx.newPage();
  const t9 = new Date(); t9.setHours(9, 12, 0, 0);
  await p.clock.install({ time: t9 });
  await p.goto(URL_);
  await p.clock.resume();
  await p.waitForFunction(() => /connected/.test(document.getElementById('conn').textContent));
  await p.evaluate((css) => {
    const s = document.createElement('style'); s.textContent = css; document.head.append(s);
    document.body.insertAdjacentHTML('beforeend', '<div id="ov-cap"></div><div id="ov-label"></div><div id="ov-cursor"></div><div id="ov-phone"></div>');
    document.getElementById('tts').checked = false;
    document.querySelector('.chips').style.visibility = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    const trace = document.querySelector('.trace');
    const log = document.getElementById('log');
    Element.prototype.scrollIntoView = function () { setTimeout(() => log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' }), 30); };
    window.scrollTo(0, 0);
  }, OVERLAY_CSS);
  await p.waitForTimeout(1500);

  // screencast
  const cdp = await ctx.newCDPSession(p);
  fs.rmSync('frames', { recursive: true, force: true }); fs.mkdirSync('frames');
  const frames = [];
  cdp.on('Page.screencastFrame', async (f) => {
    const file = `frames/${String(frames.length).padStart(6, '0')}.jpg`;
    fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
    frames.push({ file, ts: f.metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  // A ticking element guarantees frames keep arriving even when the page is still.
  await p.evaluate(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:.01;z-index:101'; document.body.append(d); let k = 0; setInterval(() => (d.style.background = (k ^= 1) ? '#000' : '#fff'), 33); });
  await sleep(0.5);
  const T0 = Date.now() / 1000;
  const now = () => Date.now() / 1000 - T0;
  const audio = [];
  const play = (clip) => { audio.push({ file: clip.file, at: now(), text: clip.text, who: clip.who }); return clip.dur; };
  let n = 0;

  const caption = async (key) => {
    const c = N[key];
    await p.evaluate((t) => { const e = document.getElementById('ov-cap'); e.textContent = t; e.classList.add('on'); }, c.text);
    await sleep(play(c) + 0.3);
    await p.evaluate(() => document.getElementById('ov-cap').classList.remove('on'));
    await sleep(0.4);
  };
  const label = (t) => p.evaluate((t) => { const e = document.getElementById('ov-label'); e.classList.remove('on'); setTimeout(() => { e.textContent = t; e.classList.add('on'); }, t ? 250 : 0); if (!t) e.classList.remove('on'); }, t);
  const tap = async (selector) => {
    const box = await p.locator(selector).first().boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await p.evaluate(([x, y]) => { const c = document.getElementById('ov-cursor'); c.style.opacity = 1; c.style.left = x + 'px'; c.style.top = y + 'px'; }, [x, y]);
    await sleep(0.85);
    await p.evaluate(() => document.getElementById('ov-cursor').classList.add('tap'));
    await p.mouse.click(x, y);
    await sleep(0.2);
    await p.evaluate(() => { const c = document.getElementById('ov-cursor'); c.classList.remove('tap'); setTimeout(() => (c.style.opacity = 0), 500); });
  };
  const alexaSay = async (text) => { await sleep(play(tts(`alexa_${n++}`, 'alexa', text)) + 0.35); };
  const replyText = () => p.evaluate(() => document.getElementById('reply').textContent);
  const turn = async (who, text, { onElicit } = {}) => {
    await p.evaluate((who) => document.querySelector(`input[name="speaker"][value="${who}"]`).click(), who);
    const clip = tts(`user_${n++}`, who, text);
    play(clip);
    const typing = p.locator('#text').pressSequentially(text, { delay: Math.min(45, (clip.dur * 1000 * 0.8) / text.length) });
    await Promise.all([typing, sleep(clip.dur)]);
    await sleep(0.25);
    await p.keyboard.press('Enter');
    if (onElicit) {
      await p.waitForSelector('#elicit:not([hidden])');
      await sleep(0.4);
      await alexaSay(await p.evaluate(() => document.getElementById('elicitMsg').textContent));
      await onElicit();
    }
    await p.waitForFunction(() => { const r = document.getElementById('reply'); return r.textContent && !r.classList.contains('thinking'); });
    await sleep(0.4);
    await alexaSay(await replyText());
  };

  // ---- the story
  await label('Morning · Asha at home');
  await sleep(1.2);
  await turn('Asha', 'Did I take my pills this morning?');
  await turn('Asha', 'I just took my lisinopril and metformin');
  await caption('fall');
  await turn('Asha', "I tripped on the rug and I'm a bit dizzy", {
    onElicit: async () => {
      await caption('elicit');
      await tap('#elicit .yes');
      await sleep(0.8);
      await p.evaluate(() => { const e = document.getElementById('ov-phone'); e.innerHTML = '<div class="t"><i></i>Hearth · now</div><b>Urgent: Asha</b>Asha reported: tripped on the rug and I\'m a bit dizzy. (via Hearth check-in)'; e.classList.add('on'); });
      await sleep(1.2);
    },
  });
  await sleep(0.6);
  await p.evaluate(() => document.getElementById('ov-phone').classList.remove('on'));
  await label('That evening · Priya, three states away');
  await sleep(1.0);
  await turn('Priya', 'How has Mom been doing this week?');
  await caption('card');
  await sleep(1.0);
  await turn('Priya', "Book Mom's eye exam next Tuesday at 2, she'll need a ride", {
    onElicit: async () => {
      await tap('#elicit .choices button[data-value="Raj"]');
      await sleep(0.5);
      await tap('#elicit .yes');
    },
  });
  await sleep(1.2);

  const END = Date.now() / 1000;
  await cdp.send('Page.stopScreencast');
  await sleep(0.3);
  await b.close();

  // ffconcat with per-frame durations, from first frame at/after T0
  const fr = frames.filter((f) => f.ts >= T0 - 0.05);
  let txt = 'ffconcat version 1.0\n';
  fr.forEach((f, i) => {
    const next = i + 1 < fr.length ? fr[i + 1].ts : END;
    txt += `file '${f.file}'\nduration ${Math.max(0.001, next - f.ts).toFixed(4)}\n`;
  });
  txt += `file '${fr.at(-1).file}'\n`;
  fs.writeFileSync('frames.txt', txt);
  const shift = fr[0].ts - T0;
  fs.writeFileSync('sim-audio.json', JSON.stringify({ length: END - fr[0].ts, clips: audio.map((a) => ({ ...a, at: a.at - shift })) }, null, 1));
  console.log('frames', fr.length, 'length', (END - fr[0].ts).toFixed(1), 'clips', audio.length);
})();
