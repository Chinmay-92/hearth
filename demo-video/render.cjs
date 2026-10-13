// node render.cjs <scene> <dur> <out.mp4|stills:t1,t2>
const { chromium } = require('playwright');
const { spawn } = require('child_process');
// Uses Playwright's bundled Chromium unless CHROME_PATH points at another build.
const EXE = process.env.CHROME_PATH || undefined;
const [scene, dur, out] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch({ executablePath: EXE });
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  p.on('console', (m) => m.type() === 'error' && console.log('console', m.text()));
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(`file://${__dirname}/scenes.html?s=${scene}&d=${dur}`, { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => window.ready);
  if (out.startsWith('stills:')) {
    for (const t of out.slice(7).split(',')) { await p.evaluate((t) => seek(t), Number(t)); await p.screenshot({ path: `still_${scene}_${t}.jpg`, type: 'jpeg', quality: 80 }); }
  } else {
    const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', '30', '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', '30', out], { stdio: ['pipe', 'inherit', 'inherit'] });
    const n = Math.round(Number(dur) * 30);
    for (let i = 0; i < n; i++) {
      await p.evaluate((t) => seek(t), i / 30);
      ff.stdin.write(await p.screenshot({ type: 'jpeg', quality: 95 }));
    }
    ff.stdin.end(); await new Promise((r) => ff.on('close', r));
  }
  await b.close();
})();
