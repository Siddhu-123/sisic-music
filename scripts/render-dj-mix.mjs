import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import { planSet } from '../src/services/djSetPlanner.js';
import { camelotOf, transitionPairScore } from '../src/services/djSetDirector.js';
import { scoreDjTransition, planDjMix, rememberDjTransition } from '../src/services/djModeService.js';
import { incomingStartPosition, hasBeatGrid } from '../src/services/djBeatMath.js';
import { biquadCoefficients } from '../src/services/eqMath.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webAppRoot = path.resolve(__dirname, '..');
const projectParent = path.resolve(webAppRoot, '..');

const COMPARE_DIR = path.resolve(projectParent, 'compare');
const SONGS_DIR = path.resolve(COMPARE_DIR, 'songs');
const OUTPUT_WAV = path.resolve(COMPARE_DIR, 'ours.wav');
const METADATA_CACHE = path.resolve(COMPARE_DIR, 'dj-metadata.json');
const PYTHON_BIN = path.resolve(projectParent, 'mac-app', '.venv', 'bin', 'python');

const SAMPLE_RATE = 44100;

function ensureSongsCopied() {
  if (!fs.existsSync(SONGS_DIR)) {
    fs.mkdirSync(SONGS_DIR, { recursive: true });
  }

  const macAppDir = path.resolve(projectParent, 'mac-app');
  const sourceFiles = [];

  if (fs.existsSync(macAppDir)) {
    for (const name of fs.readdirSync(macAppDir)) {
      if (name.endsWith('.mp3')) {
        sourceFiles.push(path.join(macAppDir, name));
      }
    }
  }

  for (const name of fs.readdirSync(projectParent)) {
    if (name.startsWith('Rex Orange County - Pluto Projector') && name.endsWith('.mp3')) {
      sourceFiles.push(path.join(projectParent, name));
    }
  }

  for (const src of sourceFiles) {
    const dest = path.join(SONGS_DIR, path.basename(src));
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
    }
  }
}

function decodeMp3(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-v', 'error',
      '-i', filePath,
      '-f', 'f32le',
      '-ar', String(SAMPLE_RATE),
      '-ac', '2',
      'pipe:1',
    ]);

    const chunks = [];
    proc.stdout.on('data', chunk => chunks.push(chunk));
    proc.stderr.on('data', () => {});
    proc.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`FFmpeg failed to decode ${filePath} (code ${code})`));
      }
      const buffer = Buffer.concat(chunks);
      const floatCount = buffer.length / 4;
      const samples = new Float32Array(buffer.buffer, buffer.byteOffset, floatCount);
      const numFrames = floatCount / 2;
      const left = new Float32Array(numFrames);
      const right = new Float32Array(numFrames);
      for (let i = 0; i < numFrames; i++) {
        left[i] = samples[i * 2];
        right[i] = samples[i * 2 + 1];
      }
      resolve({ left, right, numFrames, sampleRate: SAMPLE_RATE, duration: numFrames / SAMPLE_RATE });
    });
    proc.on('error', reject);
  });
}

function analyzeAudioFiles(filePaths) {
  if (fs.existsSync(METADATA_CACHE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(METADATA_CACHE, 'utf8'));
      const cachedMap = new Map(cached.map(item => [item.filename, item]));
      const allPresent = filePaths.every(fp => cachedMap.has(path.basename(fp)));
      if (allPresent) {
        return Promise.resolve(filePaths.map(fp => cachedMap.get(path.basename(fp))));
      }
    } catch {
      // re-analyze if cache is invalid
    }
  }

  return new Promise((resolve, reject) => {
    const pythonScript = `
import sys, json
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import worker

paths = [Path(p) for p in sys.argv[2:]]
results = []
for p in paths:
    meta = worker.analyze_dj_metadata(p)
    meta["path"] = str(p)
    meta["filename"] = p.name
    results.append(meta)
print(json.dumps(results))
`;
    const macAppDir = path.resolve(projectParent, 'mac-app');
    const proc = spawn(PYTHON_BIN, ['-c', pythonScript, macAppDir, ...filePaths]);
    const chunks = [];
    proc.stdout.on('data', chunk => chunks.push(chunk));
    proc.stderr.on('data', () => {});
    proc.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`Beat analysis python worker exited with code ${code}`));
      }
      try {
        const stdout = Buffer.concat(chunks).toString('utf8').trim();
        const jsonLine = stdout.split('\\n').filter(line => line.startsWith('[')).pop();
        const parsed = JSON.parse(jsonLine);
        fs.writeFileSync(METADATA_CACHE, JSON.stringify(parsed, null, 2));
        resolve(parsed);
      } catch (err) {
        reject(err);
      }
    });
    proc.on('error', reject);
  });
}

function lowpassCoeffs(freq, sampleRate = SAMPLE_RATE, q = Math.SQRT1_2) {
  const f = Math.max(20, Math.min(sampleRate / 2 - 100, freq));
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cos) / (2 * a0),
    b1: (1 - cos) / a0,
    b2: (1 - cos) / (2 * a0),
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function highpassCoeffs(freq, sampleRate = SAMPLE_RATE, q = Math.SQRT1_2) {
  const f = Math.max(10, Math.min(sampleRate / 2 - 100, freq));
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cos) / (2 * a0),
    b1: (-(1 + cos)) / a0,
    b2: (1 + cos) / (2 * a0),
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

class BiquadFilter {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0;
    this.a1 = 0; this.a2 = 0;
    this.z1L = 0; this.z2L = 0;
    this.z1R = 0; this.z2R = 0;
  }

  setCoeffs(c) {
    this.b0 = c.b0; this.b1 = c.b1; this.b2 = c.b2;
    this.a1 = c.a1; this.a2 = c.a2;
  }

  reset() {
    this.z1L = 0; this.z2L = 0;
    this.z1R = 0; this.z2R = 0;
  }

  process(inL, inR) {
    const outL = this.b0 * inL + this.z1L;
    this.z1L = this.b1 * inL - this.a1 * outL + this.z2L;
    this.z2L = this.b2 * inL - this.a2 * outL;

    const outR = this.b0 * inR + this.z1R;
    this.z1R = this.b1 * inR - this.a1 * outR + this.z2R;
    this.z2R = this.b2 * inR - this.a2 * outR;

    return [outL, outR];
  }
}

function softLimit(x, threshold = 0.891) {
  const magnitude = Math.abs(x);
  if (magnitude <= threshold) return x;
  const room = 1 - threshold;
  const shaped = threshold + (room * Math.tanh((magnitude - threshold) / room));
  return Math.sign(x) * shaped;
}

function writeWavHeader(fd, numFrames, sampleRate = SAMPLE_RATE) {
  const numChannels = 2;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = numFrames * blockAlign;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  fs.writeSync(fd, header, 0, 44, 0);
}

async function main() {
  ensureSongsCopied();

  const mp3Files = fs.readdirSync(SONGS_DIR)
    .filter(name => name.endsWith('.mp3'))
    .sort()
    .map(name => path.join(SONGS_DIR, name));

  const audioDataMap = new Map();
  for (const filePath of mp3Files) {
    const audio = await decodeMp3(filePath);
    audioDataMap.set(path.basename(filePath), audio);
  }

  const analysisResults = await analyzeAudioFiles(mp3Files);
  const metaMap = new Map(analysisResults.map(item => [item.filename, item]));

  const failedBeatGridSongs = [];
  for (const meta of analysisResults) {
    if (!hasBeatGrid(meta.djRhythm)) {
      failedBeatGridSongs.push(meta.filename);
    }
  }

  const plannerSongs = analysisResults.map((m, idx) => ({
    id: m.filename,
    artist: `Artist ${idx}`,
    tempo: m.bpm,
    camelot: camelotOf(m.musicalKey),
    energy: m.energy,
    taste: 0.5,
    djRhythm: m.djRhythm,
    musicalKey: m.musicalKey,
    duration: m.djRhythm?.duration || 200,
    raw: m,
  }));

  let bestStart = plannerSongs[0];
  let bestPlan = null;
  let bestScore = -Infinity;

  for (let i = 0; i < plannerSongs.length; i++) {
    const start = plannerSongs[i];
    const candidates = plannerSongs.filter((_, idx) => idx !== i);
    const plan = planSet({
      start,
      candidates,
      count: candidates.length,
      pairScore: (a, b) => transitionPairScore(a, b, scoreDjTransition),
    });
    if (plan && plan.score > bestScore) {
      bestScore = plan.score;
      bestPlan = plan;
      bestStart = start;
    }
  }

  const sequence = [bestStart.id, ...bestPlan.items.map(it => it.id)];

  const transitions = [];
  const segments = [];
  let currentMixStart = 0;
  let inStartSongTime = 0;
  let inRate = 1.0;
  let prevCrossfade = 0;
  let history = {};

  let sumSongLengths = 0;
  let sumOverlaps = 0;

  for (let i = 0; i < sequence.length; i++) {
    const songMeta = metaMap.get(sequence[i]);
    const audio = audioDataMap.get(sequence[i]);
    const dur = audio.duration;
    sumSongLengths += dur;

    if (i < sequence.length - 1) {
      const nextMeta = metaMap.get(sequence[i + 1]);
      const nextAudio = audioDataMap.get(sequence[i + 1]);
      const source = {
        id: songMeta.filename,
        songKey: songMeta.filename,
        musicalKey: songMeta.musicalKey,
        bpm: songMeta.bpm,
        duration: dur,
        djRhythm: songMeta.djRhythm,
      };
      const cand = {
        id: nextMeta.filename,
        songKey: nextMeta.filename,
        musicalKey: nextMeta.musicalKey,
        bpm: nextMeta.bpm,
        duration: nextAudio.duration,
        djRhythm: nextMeta.djRhythm,
      };

      const outro = source.djRhythm.outroStart ?? (dur - 20);
      const pos = Math.max(0, outro - 10);
      const transition = scoreDjTransition(source, cand, pos);
      const plan = planDjMix({
        source,
        candidate: cand,
        positionSeconds: pos,
        duration: dur,
        prediction: { positionSeconds: pos, predictedSkipAtSeconds: Infinity },
        transition,
        history,
      });

      sumOverlaps += plan.crossfadeSeconds;

      const r = inRate;
      const Wprev = prevCrossfade;
      const transSongTime = plan.transitionAtSeconds;
      const transRelMixTime = i === 0
        ? transSongTime
        : (transSongTime - inStartSongTime + (1 - r) * Wprev + 3 * (1 - r));
      const transMixTime = currentMixStart + transRelMixTime;
      const endMixTime = transMixTime + plan.crossfadeSeconds;

      const startPos = incomingStartPosition(source.djRhythm, plan.transitionAtSeconds, cand.djRhythm, plan.tempoOctave || 0);
      const nextInStart = (startPos && Number.isFinite(startPos.position)) ? startPos.position : (cand.djRhythm.firstDownbeat || 0);

      const stretchPct = Math.abs((plan.tempoRatio ?? 1) - 1) * 100;
      transitions.push({
        from: songMeta.filename,
        to: nextMeta.filename,
        style: plan.style,
        bars: plan.mixBars ?? 0,
        stretchPct,
      });

      segments.push({
        songIndex: i,
        filename: songMeta.filename,
        audio,
        startMixTime: currentMixStart,
        transMixTime,
        endMixTime,
        startSongTime: inStartSongTime,
        inRate,
        prevCrossfade: Wprev,
        plan,
      });

      currentMixStart = transMixTime;
      inStartSongTime = nextInStart;
      inRate = plan.tempoRatio || 1.0;
      prevCrossfade = plan.crossfadeSeconds;
      history = rememberDjTransition(history, cand.id, plan.transitionAtSeconds, plan.mixBars, plan.style);
    } else {
      const r = inRate;
      const Wprev = prevCrossfade;
      const endRelMixTime = dur - inStartSongTime + (1 - r) * Wprev + 3 * (1 - r);
      const endMixTime = currentMixStart + endRelMixTime;

      segments.push({
        songIndex: i,
        filename: songMeta.filename,
        audio,
        startMixTime: currentMixStart,
        transMixTime: endMixTime,
        endMixTime,
        startSongTime: inStartSongTime,
        inRate,
        prevCrossfade: Wprev,
        plan: null,
      });
    }
  }

  const totalMixSeconds = segments[segments.length - 1].endMixTime;
  const totalFrames = Math.ceil(totalMixSeconds * SAMPLE_RATE);

  const fd = fs.openSync(OUTPUT_WAV, 'w');
  writeWavHeader(fd, totalFrames, SAMPLE_RATE);

  const BLOCK_SIZE = 16384;
  const pcmBuffer = Buffer.alloc(BLOCK_SIZE * 4);

  const filterMap = new Map();
  for (let i = 0; i < segments.length; i++) {
    filterMap.set(i, new BiquadFilter());
  }

  // Echo delay lines for echo-out
  const echoBuffers = new Map();
  for (let i = 0; i < segments.length; i++) {
    const delaySamples = Math.floor(0.5 * SAMPLE_RATE);
    echoBuffers.set(i, {
      bufL: new Float32Array(delaySamples),
      bufR: new Float32Array(delaySamples),
      ptr: 0,
      feedback: 0.5,
    });
  }

  function getSongTime(seg, relMixTime) {
    const Wprev = seg.prevCrossfade;
    const r = seg.inRate;
    if (relMixTime <= Wprev) {
      return seg.startSongTime + r * relMixTime;
    }
    const tau = relMixTime - Wprev;
    if (tau <= 6.0) {
      const intEased = (tau ** 3) / 36 - (tau ** 4) / 432;
      return seg.startSongTime + r * Wprev + r * tau + (1 - r) * intEased;
    }
    return seg.startSongTime + r * Wprev + 3 * (1 + r) + (tau - 6.0);
  }

  let activeIndex = 0;
  let writtenBytes = 44;

  for (let frameOffset = 0; frameOffset < totalFrames; frameOffset += BLOCK_SIZE) {
    const currentBlockFrames = Math.min(BLOCK_SIZE, totalFrames - frameOffset);

    for (let f = 0; f < currentBlockFrames; f++) {
      const mixFrame = frameOffset + f;
      const t = mixFrame / SAMPLE_RATE;

      while (activeIndex < segments.length - 1 && t >= segments[activeIndex].endMixTime) {
        activeIndex++;
      }

      let mixL = 0;
      let mixR = 0;

      for (let s = activeIndex; s <= Math.min(segments.length - 1, activeIndex + 1); s++) {
        const seg = segments[s];
        if (t < seg.startMixTime || t >= seg.endMixTime) continue;

        const relMixTime = t - seg.startMixTime;
        const songTime = getSongTime(seg, relMixTime);
        const songSamplePos = songTime * SAMPLE_RATE;
        const sampleIdx = Math.floor(songSamplePos);
        const frac = songSamplePos - sampleIdx;

        let sampL = 0;
        let sampR = 0;
        if (sampleIdx >= 0 && sampleIdx < seg.audio.numFrames - 1) {
          sampL = (1 - frac) * seg.audio.left[sampleIdx] + frac * seg.audio.left[sampleIdx + 1];
          sampR = (1 - frac) * seg.audio.right[sampleIdx] + frac * seg.audio.right[sampleIdx + 1];
        } else if (sampleIdx >= 0 && sampleIdx < seg.audio.numFrames) {
          sampL = seg.audio.left[sampleIdx];
          sampR = seg.audio.right[sampleIdx];
        }

        let gain = 1.0;
        const filter = filterMap.get(s);

        // Check if outgoing in a transition
        if (seg.plan && t >= seg.transMixTime) {
          const transTime = t - seg.transMixTime;
          const W = seg.plan.crossfadeSeconds;
          const x = Math.max(0, Math.min(1, transTime / W));

          if (seg.plan.style === 'beat-blend') {
            gain = Math.cos(x * Math.PI / 2);
            if (x >= 0.5) {
              const bassCoeffs = biquadCoefficients('lowshelf', 200, -30, 1, SAMPLE_RATE);
              filter.setCoeffs(bassCoeffs);
              [sampL, sampR] = filter.process(sampL, sampR);
            }
          } else if (seg.plan.style === 'filter-blend') {
            gain = Math.cos(x * Math.PI / 2);
            const lpFreq = 20000 - x * (20000 - 250);
            filter.setCoeffs(lowpassCoeffs(lpFreq, SAMPLE_RATE));
            [sampL, sampR] = filter.process(sampL, sampR);
          } else if (seg.plan.style === 'echo-out') {
            gain = Math.cos(x * Math.PI / 2);
            const echo = echoBuffers.get(s);
            const delayedL = echo.bufL[echo.ptr];
            const delayedR = echo.bufR[echo.ptr];
            echo.bufL[echo.ptr] = sampL + delayedL * echo.feedback;
            echo.bufR[echo.ptr] = sampR + delayedR * echo.feedback;
            echo.ptr = (echo.ptr + 1) % echo.bufL.length;
            sampL += delayedL * 0.5;
            sampR += delayedR * 0.5;
          } else if (seg.plan.style === 'cut') {
            gain = Math.max(0, 1 - x);
          }
        } else if (s > 0 && t < seg.startMixTime + seg.prevCrossfade) {
          // Incoming in a transition
          const transTime = t - seg.startMixTime;
          const W = seg.prevCrossfade;
          const prevPlan = segments[s - 1].plan;
          const x = Math.max(0, Math.min(1, transTime / W));

          if (prevPlan?.style === 'beat-blend') {
            gain = Math.sin(x * Math.PI / 2);
            if (x < 0.5) {
              const bassCoeffs = biquadCoefficients('lowshelf', 200, -30, 1, SAMPLE_RATE);
              filter.setCoeffs(bassCoeffs);
              [sampL, sampR] = filter.process(sampL, sampR);
            }
          } else if (prevPlan?.style === 'filter-blend') {
            gain = Math.sin(x * Math.PI / 2);
            if (x < 0.5) {
              const hpFreq = 400 * (1 - x / 0.5) + 10;
              filter.setCoeffs(highpassCoeffs(hpFreq, SAMPLE_RATE));
              [sampL, sampR] = filter.process(sampL, sampR);
            }
          } else if (prevPlan?.style === 'echo-out' || prevPlan?.style === 'cut') {
            gain = 1.0;
          }
        }

        mixL += sampL * gain;
        mixR += sampR * gain;
      }

      mixL = softLimit(mixL);
      mixR = softLimit(mixR);

      const intL = Math.max(-32768, Math.min(32767, Math.round(mixL * 32767)));
      const intR = Math.max(-32768, Math.min(32767, Math.round(mixR * 32767)));

      pcmBuffer.writeInt16LE(intL, f * 4);
      pcmBuffer.writeInt16LE(intR, f * 4 + 2);
    }

    const bytesToWrite = currentBlockFrames * 4;
    fs.writeSync(fd, pcmBuffer, 0, bytesToWrite, writtenBytes);
    writtenBytes += bytesToWrite;
  }

  fs.closeSync(fd);

  // Print transition lines
  for (const tr of transitions) {
    const fromName = path.basename(tr.from, '.mp3');
    const toName = path.basename(tr.to, '.mp3');
    console.log(`${fromName} -> ${toName}: ${tr.style}, ${tr.bars} bars, ${tr.stretchPct.toFixed(2)}%`);
  }

  for (const failed of failedBeatGridSongs) {
    console.log(`Beat grid failed: ${failed}`);
  }

  // Acceptance check
  const targetDuration = sumSongLengths - sumOverlaps;
  if (!fs.existsSync(OUTPUT_WAV)) {
    process.exit(1);
  }
  if (totalMixSeconds < targetDuration * 0.95) {
    process.exit(1);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
