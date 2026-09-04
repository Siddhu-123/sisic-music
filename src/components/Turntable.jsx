import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  TONEARM_LIFTED_ANGLE,
  TONEARM_END_ANGLE,
  TONEARM_START_ANGLE,
  clamp,
  tonearmAngleFromProgress,
  tonearmProgressFromAngle,
  vinylSecondsPerTurn,
  wrappedAngleDelta,
} from '../vinylPhysics.js';

const LONG_PRESS_MS = 420;
const INERTIA_TIME_CONSTANT_MS = 190;
const MOTOR_ACCEL_TIME_CONSTANT_MS = 180;
const MOTOR_BRAKE_TIME_CONSTANT_MS = 150;
const RADIANS_TO_DEGREES = 180 / Math.PI;

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

function inertiaVelocity(initial, target, elapsed, timeConstantMs = INERTIA_TIME_CONSTANT_MS) {
  return target + ((initial - target) * Math.exp(-Math.max(0, elapsed) / timeConstantMs));
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
  const releasedTonearmResetRef = useRef(null);
  const previewProgressRef = useRef(null);
  const recordSwapIndexRef = useRef(null);
  const recordRotationRef = useRef(0);
  const motorVelocityRef = useRef(0);
  const motorFrameRef = useRef(null);
  const motorLastAtRef = useRef(0);
  const motorInertiaRef = useRef(null);
  const reducedMotionRef = useRef(false);
  const motorStateRef = useRef({
    currentSong: false,
    isPlaying: false,
    isBraking: false,
    dragMode: null,
    rpm,
    pitchModifier,
  });
  const motorCallbacksRef = useRef({ onScratchVelocity, onScratchEnd });
  const [dragMode, setDragMode] = useState(null);
  const [previewProgress, setPreviewProgress] = useState(null);
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
    ? (tonearmDragAngle ?? tonearmAngleFromProgress(displayedProgress))
    : tonearmLifted
      ? TONEARM_LIFTED_ANGLE
      : tonearmAngleFromProgress(releasedTonearmProgress ?? displayedProgress);
  const pitchPercent = ((pitchModifier - 1) * 100).toFixed(1);

  const writeRecordRotation = useCallback(angle => {
    recordRotationRef.current = angle;
    vinylRef.current?.style.setProperty('--record-rotation', `${angle}deg`);
  }, []);

  const cancelMotorFrame = useCallback(() => {
    if (motorFrameRef.current == null) return;
    window.cancelAnimationFrame(motorFrameRef.current);
    motorFrameRef.current = null;
  }, []);

  const startMotorFrame = useCallback(() => {
    if (motorFrameRef.current != null) return;

    motorLastAtRef.current = performance.now();
    const tick = now => {
      motorFrameRef.current = null;
      const elapsedMs = Math.min(80, Math.max(0, now - motorLastAtRef.current));
      motorLastAtRef.current = now;
      const state = motorStateRef.current;
      const inertia = motorInertiaRef.current;

      if (state.dragMode === 'record') {
        motorVelocityRef.current = 0;
      } else if (state.dragMode === 'inertia' && inertia) {
        const inertiaElapsed = now - inertia.startedAt;
        const velocity = inertiaVelocity(inertia.initial, inertia.target, inertiaElapsed);
        motorVelocityRef.current = velocity * RADIANS_TO_DEGREES;
        motorCallbacksRef.current.onScratchVelocity?.(velocity);
        if (Math.abs(velocity - inertia.target) < 0.025 || inertiaElapsed > 1100) {
          motorVelocityRef.current = inertia.target * RADIANS_TO_DEGREES;
          motorCallbacksRef.current.onScratchVelocity?.(inertia.target);
          motorInertiaRef.current = null;
          motorCallbacksRef.current.onScratchEnd?.();
          setDragMode(null);
        }
      } else {
        const motorRunning = state.currentSong
          && state.isPlaying
          && !state.isBraking
          && state.dragMode !== 'record';
        const targetVelocity = motorRunning
          ? (360 / vinylSecondsPerTurn(state.rpm, state.pitchModifier))
          : 0;
        const timeConstant = targetVelocity
          ? MOTOR_ACCEL_TIME_CONSTANT_MS
          : (state.isBraking ? MOTOR_BRAKE_TIME_CONSTANT_MS : 110);
        motorVelocityRef.current = inertiaVelocity(
          motorVelocityRef.current,
          targetVelocity,
          elapsedMs,
          timeConstant,
        );
      }

      if (!reducedMotionRef.current && state.dragMode !== 'record' && Math.abs(motorVelocityRef.current) > 0.001) {
        writeRecordRotation(recordRotationRef.current + (motorVelocityRef.current * elapsedMs / 1000));
      }

      const needsFrame = state.currentSong
        && state.dragMode !== 'record'
        && (state.isPlaying
          || state.isBraking
          || (state.dragMode === 'inertia' && motorInertiaRef.current)
          || Math.abs(motorVelocityRef.current) > 0.1);
      if (needsFrame) motorFrameRef.current = window.requestAnimationFrame(tick);
    };

    motorFrameRef.current = window.requestAnimationFrame(tick);
  }, [writeRecordRotation]);

  const beginInertia = initialVelocity => {
    cancelMotorFrame();
    motorVelocityRef.current = initialVelocity * RADIANS_TO_DEGREES;
    motorInertiaRef.current = {
      initial: initialVelocity,
      target: (2 * Math.PI) / vinylSecondsPerTurn(rpm, pitchModifier),
      startedAt: performance.now(),
    };
    setDragMode('inertia');
    startMotorFrame();
  };

  const motorIsRunning = Boolean(isPlaying && dragMode !== 'record' && dragMode !== 'inertia' && !isBraking);
  const hasCurrentSong = Boolean(currentSong);
  const activeSongId = currentSong?.songKey || currentSong?.id || '';

  useEffect(() => {
    motorCallbacksRef.current = { onScratchVelocity, onScratchEnd };
  }, [onScratchEnd, onScratchVelocity]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => { reducedMotionRef.current = mediaQuery.matches; };
    updatePreference();
    mediaQuery.addEventListener?.('change', updatePreference);
    return () => mediaQuery.removeEventListener?.('change', updatePreference);
  }, []);

  useEffect(() => {
    motorStateRef.current = {
      currentSong: hasCurrentSong,
      isPlaying,
      isBraking,
      dragMode,
      rpm,
      pitchModifier,
    };

    if (!hasCurrentSong) {
      motorInertiaRef.current = null;
      motorVelocityRef.current = 0;
      writeRecordRotation(0);
      cancelMotorFrame();
      return;
    }

    const needsFrame = hasCurrentSong
      && dragMode !== 'record'
      && (isPlaying || isBraking || (dragMode === 'inertia' && motorInertiaRef.current) || Math.abs(motorVelocityRef.current) > 0.1);
    if (needsFrame) startMotorFrame();
    else cancelMotorFrame();
  }, [cancelMotorFrame, dragMode, hasCurrentSong, isBraking, isPlaying, pitchModifier, rpm, startMotorFrame, writeRecordRotation]);

  useEffect(() => {
    if (activeSongId) writeRecordRotation(0);
  }, [activeSongId, writeRecordRotation]);

  useEffect(() => () => cancelMotorFrame(), [cancelMotorFrame]);

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
    motorInertiaRef.current = null;
    if (dragMode === 'inertia') setDragMode(null);
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
      startRecordAngle: recordRotationRef.current,
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
    writeRecordRotation(interaction.startRecordAngle + interaction.accumulatedDegrees);
    motorVelocityRef.current = angularVelocity * RADIANS_TO_DEGREES;
    const secondsMoved = (interaction.accumulatedDegrees / 360) * (60 / rpm);
    updatePreviewProgress(interaction.startProgress + ((secondsMoved / duration) * 100));
    onScratchVelocity?.(angularVelocity);
  };

  const finishRecordPointer = event => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    event.preventDefault();
    clearLongPress();
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
    writeRecordRotation(((recordRotationRef.current % 360) + 360) % 360);
    if (interaction.startedScratch) {
      onSeek?.(target);
      setDragMode('inertia');
      beginInertia(interaction.lastVelocity);
    } else {
      setDragMode(null);
      onTogglePlay?.();
    }
  };

  const tonearmAngleFromPointer = event => {
    const deck = deckRef.current;
    const rect = deck?.getBoundingClientRect();
    if (!rect) return TONEARM_START_ANGLE;
    const deckStyle = window.getComputedStyle(deck);
    const tonearmTop = cssLengthToPixels(deckStyle.getPropertyValue('--tonearm-top'), rect.height) || (rect.height * 0.13);
    const tonearmRight = cssLengthToPixels(deckStyle.getPropertyValue('--tonearm-right'), rect.width) || (rect.width * 0.02);
    const pivotOffset = cssLengthToPixels(deckStyle.getPropertyValue('--tonearm-pivot-offset'), rect.width) || 16;
    const tonearmHeight = tonearmRef.current?.offsetHeight || 32;
    const pivotX = rect.right - tonearmRight - pivotOffset;
    const pivotY = rect.top + tonearmTop + (tonearmHeight / 2);
    const rawAngle = pointerAngle(event, pivotX, pivotY);
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
      pointerAngleOffset: tonearmAngleFromProgress(progress) - tonearmAngleFromPointer(event),
    };
    setTonearmDragAngle(tonearmAngleFromProgress(progress));
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
      Math.min(TONEARM_START_ANGLE, TONEARM_END_ANGLE),
      Math.max(TONEARM_START_ANGLE, TONEARM_END_ANGLE),
    );
    setTonearmDragAngle(nextAngle);
    updatePreviewProgress(tonearmProgressFromAngle(nextAngle));
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
    if (interaction.wasPlaying && target < 99.8) window.requestAnimationFrame(() => onTogglePlay?.());
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
    writeRecordRotation(recordRotationRef.current + (direction * 30));
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

  useEffect(() => () => {
    clearLongPress();
    motorInertiaRef.current = null;
    if (releasedTonearmResetRef.current) window.clearTimeout(releasedTonearmResetRef.current);
  }, []);

  if (!currentSong) return null;

  const crateSongs = queue.filter((song, index) => index !== queueIndex).slice(0, 5);
  const swapSong = recordSwapIndex == null ? null : queue[recordSwapIndex];
  const status = dragMode === 'record'
    ? `Scratching · ${formatTime((displayedProgress / 100) * duration)}`
    : dragMode === 'inertia'
      ? ' platter settling · motor lock engaged'
      : dragMode === 'lifted'
        ? (swapSong
          ? `Release to load ${swapSong.track}`
          : (ejectReady ? 'Release outside the deck to eject' : 'Record lifted · drag left or right to change'))
        : completed
          ? 'Playback complete · tonearm lifted'
          : `${rpm} RPM · ${pitchPercent}% pitch · vinyl noise online`;

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
            className={`turntable__vinyl turntable__vinyl--motor ${isBraking ? 'turntable__vinyl--braking' : ''} ${!motorIsRunning ? 'turntable__vinyl--paused' : ''}`}
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
          <button type="button" className={rpm === 33 ? 'is-active' : ''} onClick={() => onRpmChange?.(33)}>33⅓</button>
          <button type="button" className={rpm === 45 ? 'is-active' : ''} onClick={() => onRpmChange?.(45)}>45</button>
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
