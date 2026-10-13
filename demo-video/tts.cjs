// Usage: require('./tts.cjs').tts(id, voice, text) -> { file, dur }
// Uses ElevenLabs when ELEVENLABS_API_KEY is set (clips cached in audio/cache by
// voice + text, so re-runs cost nothing), otherwise falls back to macOS `say`.
const { execFileSync } = require('child_process');
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const ELEVEN = {
  narrator: 'nPczCjzI2devNBz1zQrb', // Brian: deep, resonant, comforting
  alexa: 'XrExE9yKIg1WjnnlVkGX', // Matilda: knowledgeable, professional
  Margaret: '5u41aNhyCU6hXOcjPPv0', // Carol: relatable grandma (Voice Library)
  Sarah: 'EXAVITQu4vr4xnSDxMaL', // Sarah: mature, reassuring
};
const SAY = { narrator: ['Daniel', 185], alexa: ['Samantha', 195], Margaret: ['Grandma (English (US))', 165], Sarah: ['Tara', 160] };
const AUDIO = path.join(__dirname, 'audio');

function speakable(text, eleven) {
  let s = text.replace(/Alexa\+/g, 'Alexa plus').replace(/(\d)\/(\d)/g, '$1 out of $2');
  return eleven
    ? s.replace(/mcp-http-probe/g, 'MCP, HTTP probe').replace(/\bnpm\b/g, 'N-P-M').replace(/\bPKCE\b/g, 'pixie')
    : s.replace(/mcp-http-probe/g, 'M C P H T T P probe').replace(/\bMCP\b/g, 'M C P').replace(/\bnpm\b/g, 'N P M').replace(/\bOAuth\b/g, 'O-Auth');
}

function tts(id, who, text) {
  fs.mkdirSync(path.join(AUDIO, 'cache'), { recursive: true });
  const wav = path.join(AUDIO, id + '.wav');
  const key = process.env.ELEVENLABS_API_KEY;
  let src;
  if (key) {
    const spoken = speakable(text, true);
    src = path.join(AUDIO, 'cache', crypto.createHash('sha1').update(ELEVEN[who] + '|' + spoken).digest('hex').slice(0, 16) + '.mp3');
    if (!fs.existsSync(src)) {
      const body = JSON.stringify({ text: spoken, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true } });
      execFileSync('curl', ['-sfS', '-X', 'POST', `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN[who]}?output_format=mp3_44100_128`,
        '-H', `xi-api-key: ${key}`, '-H', 'Content-Type: application/json', '-d', body, '-o', src]);
    }
  } else {
    const [voice, rate] = SAY[who];
    src = path.join(AUDIO, id + '.aiff');
    execFileSync('say', ['-v', voice, '-r', String(rate), '-o', src, speakable(text, false)]);
  }
  // Trim leading/trailing silence so clips sit tightly on the timeline.
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src, '-af', 'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse', '-ar', '48000', '-ac', '2', wav]);
  if (!key) fs.unlinkSync(src);
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav]).toString());
  return { file: wav, dur, text, who };
}
module.exports = { tts };
