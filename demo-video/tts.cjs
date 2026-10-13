// Usage: require('./tts.cjs').tts(id, voice, text, rate?) -> { file, dur }
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const VOICES = { narrator: ['Daniel', 185], alexa: ['Samantha', 195], Asha: ['Grandma (English (US))', 165], Priya: ['Tara', 160] };
function tts(id, who, text) {
  const [voice, rate] = VOICES[who];
  const aiff = path.join(__dirname, 'audio', id + '.aiff'), wav = path.join(__dirname, 'audio', id + '.wav');
  const spoken = text.replace(/Alexa\+/g, 'Alexa plus').replace(/\bMCP\b/g, 'M C P').replace(/mcp-http-probe/g, 'M C P H T T P probe').replace(/\bnpm\b/g, 'N P M').replace(/\bOAuth\b/g, 'O-Auth').replace(/(\d)\/(\d)/g, '$1 out of $2');
  execFileSync('say', ['-v', voice, '-r', String(rate), '-o', aiff, spoken]);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', aiff, '-ar', '48000', '-ac', '2', wav]);
  fs.unlinkSync(aiff);
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav]).toString());
  return { file: wav, dur, text, who };
}
module.exports = { tts };
