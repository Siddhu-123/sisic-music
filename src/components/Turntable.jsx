import React, { useEffect, useRef, useState } from 'react';
import {
  TONEARM_LIFTED_ANGLE,
  TONEARM_END_ANGLE,
  TONEARM_START_ANGLE,
  clamp,
  createTonearmGeometry,
  physicalRpm,
  stepPlatterVelocity,
  tonearmAngleFromProgress,
  tonearmProgressFromAngle,
  wrappedAngleDelta,
} from '../vinylPhysics.js';

const LONG_PRESS_MS = 420;
const INERTIA_TIME_CONSTANT_MS = 190;
// Direct-drive feel: quick motor start, slightly longer electronic brake.
const SPIN_UP_SECONDS = 0.22;
const SPIN_DOWN_SECONDS = 0.34;
// A finger resting on the record stops it; no pointer movement for this long means "held still".
const SCRATCH_HOLD_MS = 60;
const RAD_TO_DEG = 180 / Math.PI;
const FALLBACK_ARM = {
  startAngle: TONEARM_START_ANGLE,
  endAngle: TONEARM_END_ANGLE,
  liftedAngle: TONEARM_LIFTED_ANGLE,
  angleForProgress: tonearmAngleFromProgress,
  progressForAngle: tonearmProgressFromAngle,
};

function pointerAngle(event, centerX, centerY) {
  return Math.atan2(event.clientY - centerY, event.clientX - centerX) * (180 / Math.PI);
}

function cssLengthToPixels(value, reference) {
  const normalized = String(value || '').trim();
  if (!normalized) return 0;
  const number = Number.parseFloat(normalized);
  if (!Number.isFinite(number)) return 0;
  return normalized.endsWith('%') ? (number / 100) * reference : number;
}

function formatTime(seconds) {
  if (!seconds || Number.isNaN(seconds)) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainder}`;
}

function inertiaVelocity(initial, target, elapsed) {
  return target + ((initial - target) * Math.exp(-Math.max(0, elapsed) / INERTIA_TIME_CONSTANT_MS));
}

export function Turntable({
  currentSong,
  artwork,
  isPlaying,
  isBraking = false,
  progress,
  duration,
  rpm,
  pitchModifier,
  pitchRange,
  queue = [],
  queueIndex = 0,
  onTogglePlay,
  onSeek,
  onScratchStart,
  onScratchVelocity,
  onScratchEnd,
  onNeedleLift,
  onEject,
  onLoadSong,
  onProgressPreview,
  onPitchChange,
  onPitchRangeChange,
  onRpmChange,
}) {
  const deckRef = useRef(null);
  const vinylRef = useRef(null);
  const tonearmRef = useRef(null);
  const interactionRef = useRef(null);
  const longPressRef = useRef(null);
  const inertiaFrameRef = useRef(null);
  const releasedTonearmResetRef = useRef(null);
  const previewProgressRef = useRef(null);
  const recordSwapIndexRef = useRef(null);
  const scratchHoldRef = useRef(null);
  // Platter state lives in refs and is written straight to the DOM each frame,
  // so spinning never re-renders React.
  const platterRef = useRef({ angle: 0, velocity: 0, target: 0, timeConstant: SPIN_UP_SECONDS, mode: null });
  const [dragMode, setDragMode] = useState(null);
  const [previewProgress, setPreviewProgress] = useState(null);
  const [armGeometry, setArmGeometry] = useState(null);
  const arm = armGeometry || FALLBACK_ARM;
  const [tonearmDragAngle, setTonearmDragAngle] = useState(null);
  const [releasedTonearmProgress, setReleasedTonearmProgress] = useState(null);
  const [needleLifted, setNeedleLifted] = useState(false);
  const [ejectReady, setEjectReady] = useState(false);
  const [recordSwapIndex, setRecordSwapIndex] = useState(null);
  const [recordOffset, setRecordOffset] = useState({ x: 0, y: 0 });

  const displayedProgress = clamp(previewProgress ?? progress, 0, 100);
  const completed = duration > 0 && displayedProgress >= 99.8 && !dragMode;
  const tonearmLifted = needleLifted || dragMode === 'tonearm' || dragMode === 'lifted' || completed;
  const tonearmAngle = dragMode === 'tonearm'
    ? (tonearmDragAngle ?? arm.angleForProgress(displayedProgress))
    : tonearmLifted
      ? arm.liftedAngle
      : arm.angleForProgress(releasedTonearmProgress ?? displayedProgress);
  const pitchPercent = ((pitchModifier - 1) * 100).toFixed(1);
  const platterRpm = physicalRpm(rpm);
  const rpmLabel = platterRpm < 40 ? '33⅓' : '45';
  const motorDegreesPerSecond = (platterRpm * pitchModifier * 360) / 60;
  // The platter keeps turning while the needle is lifted; only a hand on the record stops it.
  const handOnRecord = dragMode === 'record' || dragMode === 'lifted';
  const motorIsRunning = Boolean(isPlaying && !isBraking && !handOnRecord);

  useEffect(() => {
    const platter = platterRef.current;
    platter.mode = dragMode;
    platter.target = motorIsRunning ? motorDegreesPerSecond : 0;
    platter.timeConstant = platter.target > Math.abs(platter.velocity) ? SPIN_UP_SECONDS : SPIN_DOWN_SECONDS;
  }, [dragMode, motorIsRunning, motorDegreesPerSecond]);

  useEffect(() => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let last = performance.now();
    const tick = now => {
      const platter = platterRef.current;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      // 'record' is positioned by the pointer; 'inertia' velocity is fed by the scratch settle loop.
      if (platter.mode !== 'record') {
        if (platter.mode !== 'inertia') {
          const target = reduceMotion?.matches ? 0 : platter.target;
          platter.velocity = stepPlatterVelocity(platter.velocity, target, dt, platter.timeConstant);
          if (Math.abs(platter.velocity) < 0.05 && target === 0) platter.velocity = 0;
        }
        platter.angle = (platter.angle + (platter.velocity * dt)) % 360;
      }
      vinylRef.current?.style.setProperty('--record-angle', `${platter.angle.toFixed(2)}deg`);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const updatePreviewProgress = nextProgress => {
    const boundedProgress = nextProgress == null ? null : clamp(nextProgress, 0, 100);
    previewProgressRef.current = boundedProgress;
    setPreviewProgress(boundedProgress);
    onProgressPreview?.(boundedProgress);
  };

  const clearRecordDragPreview = () => {
    recordSwapIndexRef.current = null;
    setRecordSwapIndex(null);
    setRecordOffset({ x: 0, y: 0 });
  };

  const clearReleasedTonearm = () => {
    if (releasedTonearmResetRef.current) window.clearTimeout(releasedTonearmResetRef.current);
    releasedTonearmResetRef.current = null;
    setReleasedTonearmProgress(null);
  };

  const holdReleasedTonearm = target => {
    if (releasedTonearmResetRef.current) window.clearTimeout(releasedTonearmResetRef.current);
    setReleasedTonearmProgress(target);
    releasedTonearmResetRef.current = window.setTimeout(() => {
      setReleasedTonearmProgress(current => current === target ? null : current);
      releasedTonearmResetRef.current = null;
    }, 700);
  };

  const clearLongPress = () => {
    if (longPressRef.current) window.clearTimeout(longPressRef.current);
    longPressRef.current = null;
  };

  const cancelInertia = () => {
    if (inertiaFrameRef.current) window.cancelAnimationFrame(inertiaFrameRef.current);
    inertiaFrameRef.current = null;
  };

  const beginInertia = (initialVelocity, resumeMotor) => {
    cancelInertia();
    const startTime = performance.now();
    // Audio velocities are unpitched (the engine applies pitch); a paused record settles to rest.
    const targetVelocity = resumeMotor ? (platterRpm * 2 * Math.PI) / 60 : 0;
    const tick = now => {
      const velocity = inertiaVelocity(initialVelocity, targetVelocity, now - startTime);
      onScratchVelocity?.(velocity);
      platterRef.current.velocity = velocity * pitchModifier * RAD_TO_DEG;
      if (Math.abs(velocity - targetVelocity) < 0.025 || now - startTime > 1100) {
        onScratchVelocity?.(targetVelocity);
        onScratchEnd?.();
        inertiaFrameRef.current = null;
        setDragMode(null);
        return;
      }
      inertiaFrameRef.current = window.requestAnimationFrame(tick);
    };
    inertiaFrameRef.current = window.requestAnimationFrame(tick);
  };

  const setLifted = lifted => {
    setNeedleLifted(lifted);
    onNeedleLift?.(lifted);
  };

  const beginRecordPointer = event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!duration) return;
    cancelInertia();
    const rect = vinylRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const centerX = rect.left + (rect.width / 2);
    const centerY = rect.top + (rect.height / 2);
    interactionRef.current = {
      mode: 'record',
      pointerId: event.pointerId,
      centerX,
      centerY,
      startX: event.clientX,
      startY: event.clientY,
      startProgress: progress,
      wasPlaying: isPlaying,
      lastPointerAngle: pointerAngle(event, centerX, centerY),
      lastMoveAt: performance.now(),
      accumulatedDegrees: 0,
      lastVelocity: 0,
      moved: false,
      startedScratch: false,
      longPressed: false,
    };
    updatePreviewProgress(progress);
    clearReleasedTonearm();
    recordSwapIndexRef.current = null;
    setRecordSwapIndex(null);
    clearLongPress();
    longPressRef.current = window.setTimeout(() => {
      const interaction = interactionRef.current;
      if (!interaction || interaction.pointerId !== event.pointerId || interaction.moved) return;
      interaction.longPressed = true;
      setRecordOffset({ x: 0, y: 0 });
      setLifted(true);
      setDragMode('lifted');
    }, LONG_PRESS_MS);
  };

  const moveRecordPointer = event => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId || interaction.mode !== 'record') return;
    event.preventDefault();
    if (interaction.longPressed) {
      setRecordOffset({ x: event.clientX - interaction.startX, y: event.clientY - interaction.startY });
      const horizontalDistance = event.clientX - interaction.startX;
      const candidateIndex = Math.abs(horizontalDistance) >= 120
        ? queueIndex + (horizontalDistance < 0 ? -1 : 1)
        : null;
      const replacementSong = Number.isInteger(candidateIndex) ? queue[candidateIndex] : null;
      recordSwapIndexRef.current = replacementSong ? candidateIndex : null;
      setRecordSwapIndex(recordSwapIndexRef.current);
      const rect = deckRef.current?.getBoundingClientRect();
      const inside = rect
        && event.clientX >= rect.left
        && event.clientX <= rect.right
        && event.clientY >= rect.top
        && event.clientY <= rect.bottom;
      setEjectReady(!inside || Boolean(replacementSong));
      return;
    }

    const distance = Math.hypot(event.clientX - (interaction.centerX), event.clientY - (interaction.centerY));
    if (!interaction.moved && distance < 8) return;
    if (!interaction.moved) {
      interaction.moved = true;
      clearLongPress();
      interaction.startedScratch = true;
      onScratchStart?.(isPlaying);
      setDragMode('record');
    }
    const nextPointerAngle = pointerAngle(event, interaction.centerX, interaction.centerY);
    const deltaDegrees = wrappedAngleDelta(interaction.lastPointerAngle, nextPointerAngle);
    const now = performance.now();
    const deltaSeconds = Math.max(0.001, (now - interaction.lastMoveAt) / 1000);
    const angularVelocity = (deltaDegrees * Math.PI) / (180 * deltaSeconds);
    interaction.accumulatedDegrees += deltaDegrees;
    interaction.lastPointerAngle = nextPointerAngle;
    interaction.lastMoveAt = now;
    interaction.lastVelocity = angularVelocity;
    const platter = platterRef.current;
    platter.angle += deltaDegrees;
    platter.velocity = angularVelocity * RAD_TO_DEG;
    const secondsMoved = (interaction.accumulatedDegrees / 360) * (60 / platterRpm);
    updatePreviewProgress(interaction.startProgress + ((secondsMoved / duration) * 100));
    onScratchVelocity?.(angularVelocity);
    window.clearTimeout(scratchHoldRef.current);
    scratchHoldRef.current = window.setTimeout(() => {
      if (interactionRef.current !== interaction) return;
      interaction.lastVelocity = 0;
      platter.velocity = 0;
      onScratchVelocity?.(0);
    }, SCRATCH_HOLD_MS);
  };

  const finishRecordPointer = event => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    event.preventDefault();
    clearLongPress();
    window.clearTimeout(scratchHoldRef.current);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);

    if (interaction.longPressed) {
      const shouldEject = ejectReady;
      const replacementIndex = recordSwapIndexRef.current;
      const replacementSong = Number.isInteger(replacementIndex) ? queue[replacementIndex] : null;
      interactionRef.current = null;
      setEjectReady(false);
      updatePreviewProgress(null);
      clearRecordDragPreview();
      setDragMode(null);
      setLifted(false);
      if (replacementSong) onLoadSong?.(replacementSong);
      else if (shouldEject) onEject?.();
      return;
    }

    const target = clamp(previewProgressRef.current ?? progress, 0, 100);
    interactionRef.current = null;
    updatePreviewProgress(null);
    clearRecordDragPreview();
    if (interaction.startedScratch) {
      onSeek?.(target);
      setDragMode('inertia');
      platterRef.current.mode = 'inertia';
      beginInertia(interaction.lastVelocity, interaction.wasPlaying);
    } else {
      setDragMode(null);
      onTogglePlay?.();
    }
  };

  const tonearmPivot = () => {
    const deck = deckRef.current;
    const rect = deck?.getBoundingClientRect();
    if (!rect) return null;
    const deckStyle = window.getComputedStyle(deck);
    const tonearmTop = cssLengthToPixels(deckStyle.getPropertyValue('--tonearm-top'), rect.height) || (rect.height * 0.13);
    const tonearmRight = cssLengthToPixels(deckStyle.getPropertyValue('--tonearm-right'), rect.width) || (rect.width * 0.02);
    const pivotOffset = cssLengthToPixels(deckStyle.getPropertyValue('--tonearm-pivot-offset'), rect.width) || 16;
    const tonearmHeight = tonearmRef.current?.offsetHeight || 32;
    const pivotX = rect.right - tonearmRight - pivotOffset;
    const pivotY = rect.top + tonearmTop + (tonearmHeight / 2);
    return { x: pivotX, y: pivotY };
  };

  const tonearmAngleFromPointer = event => {
    const pivot = tonearmPivot();
    if (!pivot) return arm.startAngle;
    const rawAngle = pointerAngle(event, pivot.x, pivot.y);
    let angle = 180 - rawAngle;
    if (angle > 180) angle -= 360;
    if (angle < -180) angle += 360;
    return angle;
  };

  const beginTonearmPointer = event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!duration) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    interactionRef.current = {
      mode: 'tonearm',
      pointerId: event.pointerId,
      wasPlaying: isPlaying,
      pointerAngleOffset: arm.angleForProgress(progress) - tonearmAngleFromPointer(event),
    };
    setTonearmDragAngle(arm.angleForProgress(progress));
    clearReleasedTonearm();
    setLifted(true);
    updatePreviewProgress(progress);
    setDragMode('tonearm');
  };

  const moveTonearmPointer = event => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId || interaction.mode !== 'tonearm') return;
    event.preventDefault();
    const nextAngle = clamp(
      tonearmAngleFromPointer(event) + interaction.pointerAngleOffset,
      Math.min(arm.startAngle, arm.endAngle),
      Math.max(arm.startAngle, arm.endAngle),
    );
    setTonearmDragAngle(nextAngle);
    updatePreviewProgress(arm.progressForAngle(nextAngle));
  };

  const finishTonearmPointer = event => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId || interaction.mode !== 'tonearm') return;
    event.preventDefault();
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const target = clamp(previewProgressRef.current ?? progress, 0, 100);
    interactionRef.current = null;
    updatePreviewProgress(null);
    clearRecordDragPreview();
    holdReleasedTonearm(target);
    setTonearmDragAngle(null);
    setDragMode(null);
    setLifted(false);
    onSeek?.(target);
    // Lifting only mutes the needle, so playback normally continues; resume only if it actually stopped.
    if (interaction.wasPlaying && !isPlaying && target < 99.8) window.requestAnimationFrame(() => onTogglePlay?.());
  };

  const handleDrop = event => {
    event.preventDefault();
    const key = event.dataTransfer?.getData('application/x-sisic-song') || event.dataTransfer?.getData('text/plain');
    const song = queue.find(item => (item.songKey || item.id) === key);
    if (song) onLoadSong?.(song);
  };

  const handleVinylKeyDown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || !duration) return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : -1;
    onSeek?.(clamp(progress + (direction * Math.max(1, Math.min(5, duration / 100)) / duration * 100), 0, 100));
    platterRef.current.angle += direction * 30;
  };

  const handleTonearmKeyDown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || !duration) return;
    event.preventDefault();
    const target = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? 100
        : clamp(progress + ((event.key === 'ArrowRight' || event.key === 'ArrowUp') ? 1 : -1), 0, 100);
    onSeek?.(target);
  };

  // Solve the arm's sweep from the rendered deck so the stylus tracks the
  // grooves at every breakpoint (layouts change arm length and pivot).
  const hasSong = Boolean(currentSong);
  useEffect(() => {
    const deck = deckRef.current;
    if (!deck) return undefined;
    const measure = () => {
      const vinyl = vinylRef.current;
      const label = deck.querySelector('.turntable__label');
      const stylus = deck.querySelector('.turntable__stylus');
      const pivot = tonearmPivot();
      if (!vinyl || !label || !stylus || !pivot || interactionRef.current) return;
      const vinylRect = vinyl.getBoundingClientRect();
      const stylusRect = stylus.getBoundingClientRect();
      const centerX = vinylRect.left + (vinylRect.width / 2);
      const centerY = vinylRect.top + (vinylRect.height / 2);
      const recordRadius = vinyl.offsetWidth / 2;
      const labelRadius = label.offsetWidth / 2;
      setArmGeometry(createTonearmGeometry({
        pivotToCenter: Math.hypot(pivot.x - centerX, pivot.y - centerY),
        armLength: Math.hypot(pivot.x - (stylusRect.left + (stylusRect.width / 2)), pivot.y - (stylusRect.top + (stylusRect.height / 2))),
        centerBearing: Math.atan2(centerY - pivot.y, pivot.x - centerX) * RAD_TO_DEG,
        outerRadius: recordRadius * 0.93,
        innerRadius: labelRadius + ((recordRadius - labelRadius) * 0.08),
      }));
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(deck);
    return () => observer?.disconnect();
  }, [hasSong]);

  useEffect(() => () => {
    clearLongPress();
    cancelInertia();
    window.clearTimeout(scratchHoldRef.current);
    if (releasedTonearmResetRef.current) window.clearTimeout(releasedTonearmResetRef.current);
  }, []);

  if (!currentSong) return null;

  const crateSongs = queue.filter((song, index) => index !== queueIndex).slice(0, 5);
  const swapSong = recordSwapIndex == null ? null : queue[recordSwapIndex];
  const status = dragMode === 'record'
    ? `Scratching · ${formatTime((displayedProgress / 100) * duration)}`
    : dragMode === 'inertia'
      ? 'Platter settling · motor lock engaged'
      : dragMode === 'lifted'
        ? (swapSong
          ? `Release to load ${swapSong.track}`
          : (ejectReady ? 'Release outside the deck to eject' : 'Record lifted · drag left or right to change'))
        : completed
          ? 'Playback complete · tonearm lifted'
          : `${rpmLabel} RPM · ${pitchPercent}% pitch${isPlaying ? '' : ' · paused'}`;

  return (
    <div className="turntable-shell">
      <div
        ref={deckRef}
        className={`turntable ${dragMode ? `turntable--${dragMode}` : ''} ${ejectReady ? 'turntable--eject-ready' : ''}`}
        onDragOver={event => event.preventDefault()}
        onDrop={handleDrop}
      >
        <div className="turntable__deck-label"><span>SISIC / DIRECT DRIVE</span><strong>VINYL MK.II</strong></div>
        <div className="turntable__platter-bed">
          <div className="turntable__platter-rim" aria-hidden="true" />
          <div
            ref={vinylRef}
            className="turntable__vinyl"
            style={{
              '--eject-x': `${recordOffset.x}px`,
              '--eject-y': `${recordOffset.y}px`,
            }}
            role="slider"
            tabIndex={0}
            aria-label="Vinyl record scrubber"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(displayedProgress)}
            aria-valuetext={formatTime((displayedProgress / 100) * duration)}
            onPointerDown={beginRecordPointer}
            onPointerMove={moveRecordPointer}
            onPointerUp={finishRecordPointer}
            onPointerCancel={finishRecordPointer}
            onKeyDown={handleVinylKeyDown}
          >
            <div className="turntable__vinyl-surface" aria-hidden="true">
              <div className="turntable__label">{artwork}<span className="turntable__spindle" /></div>
            </div>
          </div>
        </div>

        <button
          type="button"
          ref={tonearmRef}
          className={`turntable__tonearm ${tonearmLifted ? 'turntable__tonearm--lifted' : ''} ${dragMode === 'tonearm' ? 'turntable__tonearm--dragging' : ''}`}
          style={{ '--tonearm-angle': `${tonearmAngle}deg` }}
          role="slider"
          aria-label="Tonearm song position"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(displayedProgress)}
          aria-valuetext={formatTime((displayedProgress / 100) * duration)}
          onPointerDown={beginTonearmPointer}
          onPointerMove={moveTonearmPointer}
          onPointerUp={finishTonearmPointer}
          onPointerCancel={finishTonearmPointer}
          onKeyDown={handleTonearmKeyDown}
        >
          <span className="turntable__gimbal" />
          <span className="turntable__shaft" />
          <span className="turntable__headshell"><span className="turntable__stylus" /></span>
        </button>

        <div className="turntable__readout" aria-live="polite">{status}</div>
      </div>

      <div className="turntable__controls" role="group" aria-label="Turntable controls">
        <div className="turntable__rpm-control" role="group" aria-label="Turntable speed">
          <span>RPM</span>
          <button type="button" className={platterRpm < 40 ? 'is-active' : ''} aria-pressed={platterRpm < 40} onClick={() => onRpmChange?.(33)}>33⅓</button>
          <button type="button" className={platterRpm >= 40 ? 'is-active' : ''} aria-pressed={platterRpm >= 40} onClick={() => onRpmChange?.(45)}>45</button>
        </div>
        <label className="turntable__pitch-control">
          <span>Pitch {pitchPercent}%</span>
          <input
            type="range"
            min={1 - pitchRange}
            max={1 + pitchRange}
            step="0.001"
            value={pitchModifier}
            onChange={event => onPitchChange?.(Number(event.target.value))}
            aria-label="Pitch fader"
          />
          <button type="button" onClick={() => onPitchRangeChange?.(pitchRange >= 0.16 ? 0.08 : 0.16)} aria-label="Toggle pitch range">
            ±{Math.round(pitchRange * 100)}%
          </button>
        </label>
      </div>

      <aside className="turntable__crate" aria-label="Vinyl crate">
        <div className="turntable__crate-heading"><span>CRATE</span><small>click a record to load · drag the disc to switch</small></div>
        <div className="turntable__crate-list">
          {crateSongs.map(song => {
            const key = song.songKey || song.id;
            return (
              <button
                type="button"
                className="turntable__jacket"
                key={key}
                onClick={() => onLoadSong?.(song)}
              >
                <span className="turntable__jacket-art">{song.track?.charAt(0) || '♪'}</span>
                <span><strong>{song.track}</strong><small>{song.artist}</small></span>
              </button>
            );
          })}
          {!crateSongs.length && <p className="turntable__crate-empty">Queue another record to fill the crate.</p>}
        </div>
      </aside>
    </div>
  );
}
