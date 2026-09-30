import { useRef, useState } from 'react';
import { formatTime } from './componentUtils.jsx';

/**
 * Playback scrubber that previews while dragging and seeks once on release,
 * so a drag doesn't reschedule audio (and log a seek event) on every tick.
 */
export function SeekBar({ progress = 0, duration = 0, onSeek, onPreview, className = 'progress-row' }) {
  const [preview, setPreview] = useState(null);
  const previewRef = useRef(null);
  const shown = preview ?? progress;

  const update = value => {
    previewRef.current = value;
    setPreview(value);
    onPreview?.(value);
  };
  const commit = () => {
    const value = previewRef.current;
    if (value == null) return;
    previewRef.current = null;
    setPreview(null);
    onPreview?.(null);
    onSeek?.(value);
  };

  return (
    <div className={className}>
      <span className="time-label">{formatTime((shown / 100) * duration)}</span>
      <input
        type="range"
        className="progress-bar"
        min={0}
        max={100}
        step={0.1}
        value={shown}
        onChange={event => update(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        aria-label="Playback position"
        aria-valuetext={`${formatTime((shown / 100) * duration)} of ${formatTime(duration)}`}
        disabled={!duration}
      />
      <span className="time-label">{formatTime(duration)}</span>
    </div>
  );
}
