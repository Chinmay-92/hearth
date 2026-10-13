const { execFileSync } = require('child_process');
// NO_NARRATOR=1 leaves out the narrator lines (for re-voicing) and writes *-no-narrator files.
const NO_NARR = process.env.NO_NARRATOR === '1';
const out = (f) => (NO_NARR ? f.replace(/(\.\w+)$/, '-no-narrator$1') : f);
const fs = require('fs');
const N = require('./narration-clips.json'), plan = require('./plan.json'), SIM = require('./sim-audio.json');
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
let t = 0; const clips = [], vids = [];
for (const seg of plan) {
  const file = seg.s === 'SIM' ? 'sim.mp4' : `scene_${seg.s}.mp4`;
  const d = dur(file);
  if (seg.k && !NO_NARR) clips.push({ ...N[seg.k], at: t + 0.5 });
  if (seg.s === 'SIM') for (const c of SIM.clips) clips.push({ ...c, dur: dur(c.file), at: t + c.at });
  vids.push(file); t += d;
}
console.log('total', t.toFixed(2), 's,', clips.length, 'clips');
// SRT
const ts = (s) => { const ms = Math.round(s * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
const who = { narrator: '', alexa: 'Alexa: ', Margaret: 'Margaret: ', Sarah: 'Sarah: ' };
if (!NO_NARR) fs.writeFileSync('hearth-demo.srt', clips.sort((a, b) => a.at - b.at).map((c, i) => `${i + 1}\n${ts(c.at)} --> ${ts(c.at + c.dur)}\n${who[c.who] ?? ''}${c.text}\n`).join('\n'));
if (!NO_NARR) fs.writeFileSync('voice-script.txt', clips.map((c) => `[${ts(c.at)}] ${c.who.toUpperCase()}: ${c.text}`).join('\n'));
// video: concat
const vargs = ['-y', '-v', 'error'];
vids.forEach((v) => vargs.push('-i', v));
vargs.push('-filter_complex', vids.map((_, i) => `[${i}:v]fps=30,scale=1920:1080,setsar=1,format=yuv420p[v${i}]`).join(';') + ';' + vids.map((_, i) => `[v${i}]`).join('') + `concat=n=${vids.length}:v=1:a=0[v]`, '-map', '[v]', '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-pix_fmt', 'yuv420p', 'video-only.mp4');
if (!fs.existsSync('video-only.mp4') || !NO_NARR) execFileSync('ffmpeg', vargs, { stdio: 'inherit' });
// audio: delayed clips mixed
const aargs = ['-y', '-v', 'error'];
clips.forEach((c) => aargs.push('-i', c.file));
const f = clips.map((c, i) => `[${i}:a]adelay=${Math.round(c.at * 1000)}|${Math.round(c.at * 1000)}${c.who === 'alexa' ? ',highpass=f=120,volume=0.95' : ''}[a${i}]`).join(';');
aargs.push('-filter_complex', `${f};${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0,apad,atrim=0:${t.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11[a]`, '-map', '[a]', '-ar', '48000', '-c:a', 'pcm_s16le', out('voice.wav'));
execFileSync('ffmpeg', aargs, { stdio: 'inherit' });
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', 'video-only.mp4', '-i', out('voice.wav'), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out('hearth-demo.mp4')], { stdio: 'inherit' });
console.log('final', dur(out('hearth-demo.mp4')).toFixed(2));
