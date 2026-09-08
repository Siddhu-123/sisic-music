import { SlidersHorizontal, Timer } from 'lucide-react';

export function PlaybackSettings({ player, onToggleQueue }) {
  const timer = player.sleepTimer;
  const sleepLabel = timer?.mode === 'track' ? 'End of track' : timer ? `${Math.ceil(player.sleepRemaining / 60)} min left` : 'Off';
  return <details className="playback-settings">
    <summary className={`icon-btn ${timer ? 'icon-btn--active' : ''}`} aria-label="Playback settings" title="Playback settings">
      {timer ? <Timer size={17} /> : <SlidersHorizontal size={17} />}
    </summary>
    <div className="playback-settings__panel">
      <strong>Playback</strong>
      <button className="panel-action-btn" onClick={event => { event.currentTarget.closest('details').open = false; onToggleQueue?.(); }}>Open queue</button>
      <label htmlFor="crossfade">Crossfade <span>{player.crossfadeSeconds ? `${player.crossfadeSeconds}s` : 'Off'}</span></label>
      <input id="crossfade" aria-label="Crossfade seconds" type="range" min="0" max="12" step="1"
        value={player.crossfadeSeconds} onChange={e => player.setCrossfade(Number(e.target.value))} />
      <p>Blend the end of a track into the next.</p>
      <label htmlFor="sleep-timer">Sleep timer <span>{sleepLabel}</span></label>
      <select id="sleep-timer" aria-label="Sleep timer" value={timer?.mode === 'track' ? 'track' : timer ? 'active' : 'off'} onChange={e => player.setSleepTimer(e.target.value)}>
        <option value="off">Off</option>
        {timer?.mode === 'time' && <option value="active">{sleepLabel}</option>}
        <option value="track">At end of this track</option>
        {[5, 15, 30, 45, 60, 90].map(minutes => <option key={minutes} value={minutes}>{minutes} minutes</option>)}
      </select>
      <small>Space: play / pause · ← →: seek · M: mute</small>
    </div>
  </details>;
}
