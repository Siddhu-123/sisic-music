// Local browser regression fixture. Vite's production entry does not include this file.
import React, { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PlaybackController } from '../../src/services/PlaybackController.js';
import { VinylAudioEngine } from '../../src/services/VinylAudioEngine.js';
import '../../src/index.css';

if (!import.meta.env.DEV) throw new Error('The fixture only runs in the development server.');

// Keep fixture local to server and origin
const localFetch = window.fetch.bind(window);
window.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (url.origin !== location.origin && url.origin !== 'http://127.0.0.1:5199' && url.protocol !== 'blob:' && url.protocol !== 'data:') {
    return Promise.resolve(new Response('{}', { status: 503 }));
  }
  return localFetch(input, options);
};

const audioBlobUrls = new Map();
async function resolveAudioUrl(song) {
  const id = song?.driveFileId || song?.songKey;
  if (!id) throw new Error('Missing song id for audio resolution');
  if (audioBlobUrls.has(id)) {
    return audioBlobUrls.get(id);
  }
  const res = await fetch(`http://127.0.0.1:5199/audio/${id}.mp3`);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching audio for ${id}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  audioBlobUrls.set(id, url);
  return url;
}
window.addEventListener('pagehide', () => audioBlobUrls.forEach(url => URL.revokeObjectURL(url)));

const [features, plans] = await Promise.all([
  fetch('http://127.0.0.1:5199/features.json').then(r => r.json()),
  fetch('http://127.0.0.1:5199/plans.json').then(r => r.json()),
]);
const featuresMap = new Map(features.map(f => [f.id, f]));

window.__real = { samples: [], result: null, plans, features, controller: null };

function findNearestBeat(beats, target) {
  if (!beats || beats.length === 0) return null;
  let low = 0;
  let high = beats.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (beats[mid] < target) {
      low = mid + 1;
    } else if (beats[mid] > target) {
      high = mid - 1;
    } else {
      return { beat: beats[mid], index: mid };
    }
  }
  let bestIdx = -1;
  let minDiff = Infinity;
  for (const idx of [high, low]) {
    if (idx >= 0 && idx < beats.length) {
      const diff = Math.abs(beats[idx] - target);
      if (diff < minDiff) {
        minDiff = diff;
        bestIdx = idx;
      }
    }
  }
  return bestIdx >= 0 ? { beat: beats[bestIdx], index: bestIdx } : null;
}

function wrap(val, period) {
  if (!period || period <= 0) return val;
  const half = period / 2;
  let rem = (val + half) % period;
  if (rem < 0) rem += period;
  return rem - half;
}

function getLocalBeatPeriod(beats, nearestIdx, fallbackRhythm) {
  if (!beats || beats.length < 2) {
    return fallbackRhythm?.bpm ? 60 / fallbackRhythm.bpm : 0.5;
  }
  const minIdx = Math.max(0, nearestIdx - 10);
  const maxIdx = Math.min(beats.length - 1, nearestIdx + 10);
  const gaps = [];
  for (let i = minIdx; i < maxIdx; i++) {
    const gap = beats[i + 1] - beats[i];
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) {
    return fallbackRhythm?.bpm ? 60 / fallbackRhythm.bpm : 0.5;
  }
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  return gaps.length % 2 === 1
    ? gaps[mid]
    : (gaps[mid - 1] + gaps[mid]) / 2;
}

function percentile(sorted, q) {
  if (!sorted || sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const p = q * (sorted.length - 1);
  const lower = Math.floor(p);
  const upper = Math.ceil(p);
  const weight = p - lower;
  return Number((sorted[lower] * (1 - weight) + sorted[upper] * weight).toFixed(2));
}

function leastSquaresSlopeMsPerSecond(windowSamples) {
  if (!windowSamples || windowSamples.length < 2) return null;
  const n = windowSamples.length;
  let sumT = 0;
  let sumY = 0;
  for (const s of windowSamples) {
    sumT += s.t / 1000;
    sumY += s.beatErrMs;
  }
  const meanT = sumT / n;
  const meanY = sumY / n;
  let num = 0;
  let den = 0;
  for (const s of windowSamples) {
    const dt = (s.t / 1000) - meanT;
    const dy = s.beatErrMs - meanY;
    num += dt * dy;
    den += dt * dt;
  }
  if (den === 0) return 0;
  return Number((num / den).toFixed(3));
}

const shorten = (name, max = 18) => (name && name.length > max ? name.slice(0, max) : (name || ''));

export function DjMixRealApp() {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('Idle. Click a plan button to start mix test.');
  const [result, setResult] = useState(null);

  const runMix = async plan => {
    if (running) return;
    setRunning(true);
    setStatus(`Initializing mix for ${shorten(plan.fromFile || plan.from)} -> ${shorten(plan.toFile || plan.to)}...`);
    setResult(null);

    if (window.__real?.controller) {
      window.__real.controller.dispose();
    }

    const controller = new PlaybackController({
      resolveUrl: resolveAudioUrl,
      createAudio: () => new VinylAudioEngine(),
    });
    controller.activate();
    controller.configurePlayback({ enabled: true });

    const samples = [];
    let mixResult = null;
    let mixStartedAtMs = null;
    let caughtError = null;
    let intervalId = null;

    window.__real = { samples, result: null, plans, features, controller };

    const featFrom = featuresMap.get(plan.from);
    const featTo = featuresMap.get(plan.to);
    const outBeats = featFrom?.beats || [];
    const inBeats = featTo?.beats || [];

    const songFrom = {
      songKey: plan.from,
      track: plan.fromFile || plan.from,
      artist: 'Real',
      driveFileId: plan.from,
      durationSeconds: featFrom?.duration || 0,
      djRhythm: plan.sourceRhythm || featFrom?.dj?.djRhythm,
    };

    const songTo = {
      songKey: plan.to,
      track: plan.toFile || plan.to,
      artist: 'Real',
      driveFileId: plan.to,
      durationSeconds: featTo?.duration || 0,
      djRhythm: plan.candidateRhythm || featTo?.dj?.djRhythm,
    };

    const t0 = performance.now();
    let engineA = null;
    let engineB = null;

    const finishMix = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }

      const windowSamples = [];
      if (mixStartedAtMs != null) {
        let inWindow = false;
        for (const s of samples) {
          if (s.t < mixStartedAtMs + 1000) continue;
          const bothAbove = s.outFade != null && s.inFade != null && s.outFade >= 0.05 && s.inFade >= 0.05;
          if (!inWindow) {
            if (bothAbove) inWindow = true;
          } else if (!bothAbove) {
            break;
          }
          if (inWindow && s.beatErrMs != null) {
            windowSamples.push(s);
          }
        }
      }

      const absErrors = windowSamples.map(s => Math.abs(s.beatErrMs)).sort((a, b) => a - b);
      const medianAbsBeatErrMs = percentile(absErrors, 0.5);
      const p90AbsBeatErrMs = percentile(absErrors, 0.9);
      const maxAbsBeatErrMs = absErrors.length > 0 ? absErrors[absErrors.length - 1] : null;
      const beatErrDriftMsPerSecond = leastSquaresSlopeMsPerSecond(windowSamples);

      const inRates = windowSamples.map(s => s.inRate).filter(r => r != null);
      const inRateDuringMix = inRates.length > 0 ? inRates[Math.floor(inRates.length / 2)] : null;

      mixResult = {
        plan,
        mixStartedAtMs,
        medianAbsBeatErrMs,
        p90AbsBeatErrMs,
        maxAbsBeatErrMs,
        beatErrDriftMsPerSecond,
        inRateDuringMix,
      };

      window.__real = { samples, result: mixResult, plans, features, controller };
      setResult(mixResult);
      setStatus(caughtError ? `Error: ${caughtError.message}` : 'Complete');
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
      const outRate = engineA?.element ? engineA.element.playbackRate : null;
      const inRate = engineB?.element ? engineB.element.playbackRate : null;
      const outTime = engineA ? engineA.currentTime : 0;
      const inTime = engineB ? engineB.currentTime : 0;

      if (mixStartedAtMs === null && controller.retiring) {
        mixStartedAtMs = t;
        setStatus(`Mix running (started at ${t} ms)...`);
      }

      let beatErrMs = null;
      const bothAudible = outFade != null && inFade != null && outFade > 0.05 && inFade > 0.05;
      if (bothAudible && inRate && inRate > 0) {
        const outNearest = findNearestBeat(outBeats, outTime);
        const inNearest = findNearestBeat(inBeats, inTime);
        if (outNearest && inNearest) {
          const dOut = outNearest.beat - outTime;
          const dIn = (inNearest.beat - inTime) / inRate;
          const period = getLocalBeatPeriod(outBeats, outNearest.index, plan.sourceRhythm);
          const wrapped = wrap(dIn - dOut, period);
          beatErrMs = Number((wrapped * 1000).toFixed(2));
        }
      }

      samples.push({
        t,
        outTime: Number(outTime.toFixed(3)),
        inTime: Number(inTime.toFixed(3)),
        outRate: outRate != null ? Number(outRate.toFixed(4)) : null,
        inRate: inRate != null ? Number(inRate.toFixed(4)) : null,
        outFade: outFade != null ? Number(outFade.toFixed(4)) : null,
        inFade: inFade != null ? Number(inFade.toFixed(4)) : null,
        beatErrMs,
      });

      if (mixStartedAtMs !== null && t >= mixStartedAtMs + (plan.mixSongSeconds + 3) * 1000) {
        finishMix();
      } else if (t >= 60000) {
        finishMix();
      }
    };

    intervalId = setInterval(sampleTick, 50);

    try {
      controller.setDjModeEnabled(true);
      controller.setQueueAndPlay([songFrom, songTo]);
      await controller.play();

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Audio load timed out')), 15000);
        if (controller.state.isPlaying && !controller.loading && controller.audio?.duration) {
          clearTimeout(timeout);
          resolve();
          return;
        }
        const unsub = controller.subscribe(() => {
          if (controller.state.isPlaying && !controller.loading && controller.audio?.duration) {
            clearTimeout(timeout);
            unsub();
            resolve();
          }
        });
      });

      controller.audio.seek(plan.transitionAtSeconds - 5);
      setStatus(`Playing ${shorten(plan.fromFile || plan.from)} at ${(plan.transitionAtSeconds - 5).toFixed(1)}s, transition planned for ${plan.transitionAtSeconds.toFixed(1)}s...`);

      const planned = controller.planDjTransition({
        candidate: songTo,
        sourceSongKey: plan.from,
        transitionAtSeconds: plan.transitionAtSeconds,
        crossfadeSeconds: plan.mixSongSeconds,
        beatSync: true,
        mixBars: plan.mixBars,
        tempoRatio: plan.tempoRatio,
        tempoOctave: plan.tempoOctave,
        sourceRhythm: plan.sourceRhythm,
        candidateRhythm: plan.candidateRhythm,
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
    <div style={{ padding: '24px', fontFamily: 'system-ui, sans-serif', maxWidth: '840px', margin: '0 auto' }}>
      <h1>DJ Mix Real Audio Test</h1>
      <p style={{ color: '#666' }}>
        Plays real audio tracks from static server, executes beat-synced transition, and measures beat alignment.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', margin: '20px 0' }}>
        {plans.map((p, idx) => (
          <button
            key={`${p.from}-${p.to}-${idx}`}
            onClick={() => runMix(p)}
            disabled={running}
            style={{
              fontSize: '13px',
              padding: '10px 14px',
              backgroundColor: running ? '#888' : '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: running ? 'not-allowed' : 'pointer',
              fontWeight: 600,
            }}
          >
            {`${shorten(p.fromFile || p.from)} -> ${shorten(p.toFile || p.to)}`}
          </button>
        ))}
      </div>
      <div style={{ margin: '12px 0', color: '#555' }}>
        <strong>Status:</strong> {status}
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

createRoot(document.getElementById('root')).render(<StrictMode><DjMixRealApp /></StrictMode>);
