# Demo video pipeline

Renders `hearth-demo.mp4` (about 2:56, 1920×1080) with no screen-recording software and no manual editing:

- **Motion scenes:** `scenes.html` has seven GSAP scenes: title, problem, solution, demo intro, architecture, probe, outro. `render.cjs` seeks each timeline frame by frame and pipes the frames to ffmpeg, so the motion is smooth and deterministic.
- **Live demo:** `record.cjs` drives the real Alexa+ simulator, in scripted playback mode, against a real Hearth server. It captures the page with the Chrome DevTools screencast and adds captions, scene labels, a tap cursor and the push notification as page overlays.
- **Voices:** ElevenLabs (`eleven_multilingual_v2`) when `ELEVENLABS_API_KEY` is set: narrator Brian, Alexa Matilda, Margaret "Carol" (a Voice Library grandma voice, which must be added to your account), Sarah "Sarah". Clips are cached in `audio/cache`, so re-runs are free. Without a key it falls back to macOS `say`.
- **Assembly:** `assemble.cjs` joins the segments, places every voice clip at its timestamp, and normalises loudness. It also writes `hearth-demo.srt` (captions for YouTube) and `voice-script.txt` (every line with its start time).

## Run it

macOS with ffmpeg and Node 22.18 or later:

```bash
cd demo-video && npm install && npx playwright install chromium
npm run narration                          # narrator clips → narration-clips.json

# Terminal 1 and 2: a fresh Hearth whose clock starts at 9:12 AM, plus the simulator in playback mode
(cd ../server && HEARTH_DEMO_TIME=09:12 HEARTH_DB=:memory: HEARTH_DRY_RUN=1 PORT=8790 node src/index.ts)
(cd ../simulator && HEARTH_PLAYBACK=1 HEARTH_MCP_URL=http://127.0.0.1:8790/mcp PORT=5180 node src/server.ts)

# Terminal 3
node record.cjs http://127.0.0.1:5180       # → frames/, frames.txt, sim-audio.json
ffmpeg -f concat -safe 0 -i frames.txt -vf "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p" -c:v libx264 -crf 17 sim.mp4
node -e "const N=require('./narration-clips.json');const o=[['title',null,4.5],['problem','problem'],['solution','solution'],['intro','intro'],['SIM'],['arch','arch'],['probe','probe'],['outro','outro']];require('fs').writeFileSync('plan.json',JSON.stringify(o.map(([s,k,d])=>s==='SIM'?{s}:{s,k,d:d??+(0.5+N[k].dur+0.9).toFixed(2)})))"
for s in $(node -e "require('./plan.json').filter(p=>p.d).forEach(p=>console.log(p.s+'@'+p.d))"); do node render.cjs ${s%@*} ${s#*@} scene_${s%@*}.mp4; done
node assemble.cjs                           # → hearth-demo.mp4, hearth-demo.srt, voice-script.txt
NO_NARRATOR=1 node assemble.cjs             # → hearth-demo-no-narrator.mp4 (record your own narration over it)
```

## Use your own voice

`hearth-demo-no-narrator.mp4` has only the in-demo voices: Margaret, Sarah and Alexa. Record the narrator lines from `voice-script.txt` at the listed start times (eight lines, about 75 seconds in total), save them as `my-narration.wav`, then mix:

```bash
ffmpeg -i hearth-demo-no-narrator.mp4 -i my-narration.wav -filter_complex "[0:a][1:a]amix=inputs=2:normalize=0[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k hearth-demo-myvoice.mp4
```
