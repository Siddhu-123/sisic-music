import { useEffect, useRef, useState } from 'react';

export function ProgressSlider({ player, progress = player.progress }) {
  const [preview, setPreview] = useState(null);
  const inputRef = useRef(null);
  const dragRef = useRef(null);
  const committedRef = useRef(null);
  const { duration, isPlaying, buffered, seek, audioRef, currentSongKey } = player;
  const displayed = preview ?? progress;

  useEffect(() => {
    let frame;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const draw = () => {
      const input = inputRef.current;
      const audio = audioRef.current;
      if (input && dragRef.current == null && audio?.duration && !audio.paused) {
        const value = Math.min(100, audio.currentTime / audio.duration * 100);
        input.value = value;
        input.style.setProperty('--progress', `${value}%`);
      }
      if (isPlaying && !document.hidden && !reduced.matches) frame = requestAnimationFrame(draw);
    };
    const restart = () => { cancelAnimationFrame(frame); if (isPlaying && !document.hidden && !reduced.matches) draw(); };
    restart();
    document.addEventListener('visibilitychange', restart);
    reduced.addEventListener('change', restart);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', restart); reduced.removeEventListener('change', restart); };
  }, [audioRef, currentSongKey, isPlaying, duration]);

  const cancel = () => { dragRef.current = null; setPreview(null); };
  return <input ref={inputRef} type="range" className="progress-bar playback-progress" min={0} max={100} step={0.1}
    value={displayed} disabled={!duration} aria-label="Playback position"
    aria-valuetext={`${Math.floor(displayed / 100 * duration)} of ${Math.floor(duration)} seconds`}
    style={{ '--progress': `${displayed}%`, '--buffered': `${Math.max(buffered || 0, displayed)}%` }}
    onPointerDown={event => { committedRef.current = null; dragRef.current = Number(event.currentTarget.value); event.currentTarget.setPointerCapture?.(event.pointerId); }}
    onChange={event => {
      const value = Number(event.currentTarget.value);
      if (committedRef.current === value) return;
      if (dragRef.current != null) { dragRef.current = value; setPreview(value); }
      else seek(value);
    }}
    onKeyDown={() => { committedRef.current = null; }}
    onPointerUp={() => { const value = dragRef.current; committedRef.current = value; cancel(); if (value != null) seek(value); }}
    onPointerCancel={cancel} onLostPointerCapture={cancel} onBlur={cancel}
  />;
}
