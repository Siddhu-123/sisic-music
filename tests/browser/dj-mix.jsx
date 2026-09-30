// Local browser regression fixture. Vite's production entry does not include this file.
import React, { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PlaybackController } from '../../src/services/PlaybackController.js';
import { VinylAudioEngine } from '../../src/services/VinylAudioEngine.js';
import { phaseErrorSeconds } from '../../src/services/djBeatMath.js';
import '../../src/index.css';

if (!import.meta.env.DEV) throw new Error('The fixture only runs in the development server.');

// Keep fixture entirely local, no network fetches
const localFetch = window.fetch.bind(window);
window.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (url.origin !== location.origin && url.protocol !== 'blob:' && url.protocol !== 'data:') {
    return Promise.resolve(new Response('{}', { status: 503 }));
  }
  return localFetch(input, options);
};

function createSyntheticTrack(bpm, firstDownbeat, durationSeconds = 80, seed = 12345) {
  const sampleRate = 22050;
  const numSamples = sampleRate * durationSeconds;
  const beatSec = 60 / bpm;
  const barBeats = 4;

  let s = seed >>> 0;
  const rng = () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const buffer = new Float32Array(numSamples);
  const minB = Math.ceil(-firstDownbeat / beatSec);
  const maxB = Math.floor((durationSeconds - firstDownbeat) / beatSec);

  for (let b = minB; b <= maxB; b++) {
    const beatTime = firstDownbeat + b * beatSec;
    const isDownbeat = ((b % barBeats) + barBeats) % barBeats === 0;

    // 1. Kick drum: pitch-swept sine (~0.18 s) on every beat
    const kickDuration = 0.18;
    const kickSamples = Math.floor(kickDuration * sampleRate);
    const startSample = Math.floor(beatTime * sampleRate);
    const f0 = 150;
    const f1 = 45;
    for (let i = 0; i < kickSamples; i++) {
      const idx = startSample + i;
      if (idx >= 0 && idx < numSamples) {
        const tau = i / sampleRate;
        const phase = 2 * Math.PI * (f0 * tau + 0.5 * (f1 - f0) * (tau * tau) / kickDuration);
        const env = Math.max(0, 1 - tau / kickDuration);
        buffer[idx] += Math.sin(phase) * env * 0.45;
      }
    }

    // 2. Bass note on first beat of each bar
    if (isDownbeat) {
      const bassDuration = 0.35;
      const bassSamples = Math.floor(bassDuration * sampleRate);
      const bassFreq = 65;
      for (let i = 0; i < bassSamples; i++) {
        const idx = startSample + i;
        if (idx >= 0 && idx < numSamples) {
          const tau = i / sampleRate;
          const phase = 2 * Math.PI * bassFreq * tau;
          const env = Math.max(0, 1 - tau / bassDuration);
          buffer[idx] += Math.sin(phase) * env * 0.35;
        }
      }
    }

    // 3. Short noise hat on every off-beat
    const offbeatTime = beatTime + 0.5 * beatSec;
    if (offbeatTime < durationSeconds) {
      const hatDuration = 0.04;
      const hatSamples = Math.floor(hatDuration * sampleRate);
      const hatStart = Math.floor(offbeatTime * sampleRate);
      for (let i = 0; i < hatSamples; i++) {
        const idx = hatStart + i;
        if (idx >= 0 && idx < numSamples) {
          const tau = i / sampleRate;
          const env = Math.max(0, 1 - tau / hatDuration);
          buffer[idx] += (rng() * 2 - 1) * env * 0.18;
        }
      }
    }
  }

  const wavBuffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(wavBuffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.max(-1, Math.min(1, buffer[i]));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
  }
  return URL.createObjectURL(new Blob([wavBuffer], { type: 'audio/wav' }));
}

const sourceRhythm = {
  rhythmStatus: 'ready',
  bpm: 120,
  firstDownbeat: 0.5,
  barBeats: 4,
  gridCoverage: 0.95,
  downbeatAgreement: 0.9,
};

const candidateRhythm = {
  rhythmStatus: 'ready',
  bpm: 126,
  firstDownbeat: 0.3,
  barBeats: 4,
  gridCoverage: 0.95,
  downbeatAgreement: 0.9,
};

const songA = {
  songKey: 'mix-a',
  track: 'Track A (120 bpm)',
  artist: 'Synthetic',
  driveFileId: 'mix-a',
  durationSeconds: 80,
  djRhythm: sourceRhythm,
};

const songB = {
  songKey: 'mix-b',
  track: 'Track B (126 bpm)',
  artist: 'Synthetic',
  driveFileId: 'mix-b',
  durationSeconds: 80,
  djRhythm: candidateRhythm,
};

const urls = new Map([
  ['mix-a', createSyntheticTrack(120, 0.5, 80, 1001)],
  ['mix-b', createSyntheticTrack(126, 0.3, 80, 2002)],
]);
window.addEventListener('pagehide', () => urls.forEach(url => URL.revokeObjectURL(url)));

window.__mix = { samples: [], result: null, controller: null };

export function DjMixApp() {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('Idle. Click "Run mix" to start test.');
  const [result, setResult] = useState(null);

  const runMix = async () => {
    if (running) return;
    setRunning(true);
    setStatus('Initializing controller and starting Track A...');
    setResult(null);

    if (window.__mix?.controller) {
      window.__mix.controller.dispose();
    }

    const controller = new PlaybackController({
      resolveUrl: async song => urls.get(song?.driveFileId || song?.songKey),
      createAudio: () => new VinylAudioEngine(),
    });
    controller.activate();
    controller.configurePlayback({ enabled: true });

    const samples = [];
    let mixResult = null;
    let mixStartedAt = null;
    let caughtError = null;

    window.__mix = { samples, result: null, controller };

    const t0 = performance.now();
    let engineA = null;
    let engineB = null;
    let intervalId = null;

    const finishMix = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }

      const phaseSamples = samples.filter(s => s.phaseErrMs != null);
      const settledSamples = samples.filter(s => s.phaseErrMs != null && mixStartedAt != null && s.t >= mixStartedAt + 300);

      const maxAbsPhaseErrMsAfter300ms = settledSamples.length > 0
        ? Math.max(...settledSamples.map(s => Math.abs(s.phaseErrMs)))
        : null;

      const meanAbsPhaseErrMs = phaseSamples.length > 0
        ? Number((phaseSamples.reduce((sum, s) => sum + Math.abs(s.phaseErrMs), 0) / phaseSamples.length).toFixed(2))
        : null;

      const inRatesDuringMix = phaseSamples.map(s => s.inRate).filter(r => r != null);
      const incomingRateDuringMix = inRatesDuringMix.length > 0
        ? inRatesDuringMix[Math.floor(inRatesDuringMix.length / 2)]
        : null;

      const expectedRate = (120 / 126) * (controller.state.pitchModifier || 1);

      const midpointTarget = mixStartedAt != null ? mixStartedAt + 4000 : null;
      let bestMidpointSample = null;
      if (midpointTarget != null) {
        let minDiff = Infinity;
        for (const s of samples) {
          if (s.outFade != null && s.inFade != null) {
            const diff = Math.abs(s.t - midpointTarget);
            if (diff < minDiff) {
              minDiff = diff;
              bestMidpointSample = s;
            }
          }
        }
      }
      const fadeMidpoint = bestMidpointSample
        ? Number((Math.pow(bestMidpointSample.outFade, 2) + Math.pow(bestMidpointSample.inFade, 2)).toFixed(4))
        : null;

      let earlyInCut = false;
      let earlyOutFlat = false;
      let lateInFlat = false;
      let lateOutCut = false;
      if (mixStartedAt != null) {
        for (const s of samples) {
          if (s.inBass != null && s.outBass != null) {
            if (s.t >= mixStartedAt + 500 && s.t <= mixStartedAt + 3500) {
              if (s.inBass <= -20) earlyInCut = true;
              if (s.outBass >= -5) earlyOutFlat = true;
            }
            if (s.t >= mixStartedAt + 4500 && s.t <= mixStartedAt + 7500) {
              if (s.inBass >= -5) lateInFlat = true;
              if (s.outBass <= -20) lateOutCut = true;
            }
          }
        }
      }
      const bassSwapObserved = earlyInCut && earlyOutFlat && lateInFlat && lateOutCut;

      const postFadeSamples = mixStartedAt != null
        ? samples.filter(s => s.t >= mixStartedAt + 9000 && s.inRate != null)
        : [];
      const pitchRestoredAfterMix = postFadeSamples.length > 0 &&
        postFadeSamples.every(s => Math.abs(s.inRate - 1) <= 0.005);

      const error = controller.state.error || caughtError?.message || null;

      mixResult = {
        mixStartedAt,
        maxAbsPhaseErrMsAfter300ms,
        meanAbsPhaseErrMs,
        incomingRateDuringMix,
        expectedRate,
        fadeMidpoint,
        bassSwapObserved,
        pitchRestoredAfterMix,
        error,
      };

      window.__mix = { samples, result: mixResult, controller };
      setResult(mixResult);
      setStatus('Complete');
      setRunning(false);
    };

    const sampleTick = () => {
      const t = Math.round(performance.now() - t0);
      if (!engineA) engineA = controller.audio;
      if (!engineB && controller.standby) engineB = controller.standby;

      if (controller.retiring && engineA !== controller.retiring) {
        engineA = controller.retiring;
      }
      if (controller.retiring && engineB !== controller.audio) {
        engineB = controller.audio;
      }

      const outFade = engineA?.graph?.fadeGainNode?.gain?.value ?? null;
      const inFade = engineB?.graph?.fadeGainNode?.gain?.value ?? null;
      const outBass = engineA?.graph?.bassNode?.gain?.value ?? null;
      const inBass = engineB?.graph?.bassNode?.gain?.value ?? null;
      const outRate = engineA?.element ? engineA.element.playbackRate : null;
      const inRate = engineB?.element ? engineB.element.playbackRate : null;
      const outTime = engineA ? engineA.currentTime : 0;
      const inTime = engineB ? engineB.currentTime : 0;

      const bothAudible = Boolean(
        controller.retiring &&
        engineA && !engineA.paused &&
        engineB && !engineB.paused &&
        outFade != null && outFade > 0.001 &&
        inFade != null && inFade > 0.001
      );

      let phaseErrMs = null;
      if (bothAudible) {
        const errSec = phaseErrorSeconds(sourceRhythm, outTime, candidateRhythm, inTime, 0);
        if (Number.isFinite(errSec)) phaseErrMs = Number((errSec * 1000).toFixed(2));
      }

      if (mixStartedAt === null && (controller.retiring || (engineB && !engineB.paused && inTime > 0))) {
        mixStartedAt = t;
        setStatus(`Mix running (started at ${t} ms)...`);
      }

      samples.push({
        t,
        outTime: Number(outTime.toFixed(3)),
        inTime: Number(inTime.toFixed(3)),
        outRate: outRate != null ? Number(outRate.toFixed(4)) : null,
        inRate: inRate != null ? Number(inRate.toFixed(4)) : null,
        phaseErrMs,
        outFade: outFade != null ? Number(outFade.toFixed(4)) : null,
        inFade: inFade != null ? Number(inFade.toFixed(4)) : null,
        outBass: outBass != null ? Number(outBass.toFixed(2)) : null,
        inBass: inBass != null ? Number(inBass.toFixed(2)) : null,
        currentSongKey: controller.state.currentSongKey,
      });

      if ((mixStartedAt !== null && t >= mixStartedAt + 12000) || t >= 32000) {
        finishMix();
      }
    };

    intervalId = setInterval(sampleTick, 50);

    try {
      controller.setDjModeEnabled(true);
      controller.setQueueAndPlay([songA, songB]);
      await controller.play();

      await new Promise(resolve => {
        if (controller.state.isPlaying && !controller.loading && controller.audio?.duration) {
          resolve();
          return;
        }
        const unsub = controller.subscribe(() => {
          if (controller.state.isPlaying && !controller.loading && controller.audio?.duration) {
            unsub();
            resolve();
          }
        });
      });

      controller.audio.seek(14);
      setStatus('Playing Track A at 14s, transition planned for 20.5s...');

      const planned = controller.planDjTransition({
        candidate: songB,
        sourceSongKey: 'mix-a',
        transitionAtSeconds: 20.5,
        crossfadeSeconds: 8,
        beatSync: true,
        mixBars: 4,
        tempoRatio: 120 / 126,
        tempoOctave: 0,
        sourceRhythm,
        candidateRhythm,
      });

      if (!planned) {
        throw new Error('controller.planDjTransition returned false');
      }
    } catch (err) {
      caughtError = err;
      setStatus(`Error: ${err.message}`);
      finishMix();
    }
  };

  return (
    <div style={{ padding: '24px', fontFamily: 'system-ui, sans-serif', maxWidth: '800px', margin: '0 auto' }}>
      <h1>DJ Mix Browser Test</h1>
      <p style={{ color: '#666' }}>
        Plays synthetic 120 bpm and 126 bpm tracks, executes beat-synced transition, and records timing metrics.
      </p>
      <div style={{ margin: '20px 0' }}>
        <button
          id="run-mix"
          onClick={runMix}
          disabled={running}
          style={{
            fontSize: '18px',
            padding: '12px 32px',
            backgroundColor: running ? '#888' : '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            cursor: running ? 'not-allowed' : 'pointer',
            fontWeight: 600,
          }}
        >
          {running ? 'Running mix...' : 'Run mix'}
        </button>
        <span style={{ marginLeft: '16px', color: '#555' }}>{status}</span>
      </div>
      <h2>Result</h2>
      <pre
        id="out"
        style={{
          background: '#18181b',
          color: '#f4f4f5',
          padding: '16px',
          borderRadius: '8px',
          overflow: 'auto',
          fontSize: '13px',
          lineHeight: '1.4',
          minHeight: '100px',
        }}
      >
        {result ? JSON.stringify(result, null, 2) : status}
      </pre>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<StrictMode><DjMixApp /></StrictMode>);
