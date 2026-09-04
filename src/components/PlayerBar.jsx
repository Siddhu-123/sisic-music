import { useState } from 'react';
import { Play, Pause, SkipForward, SkipBack, Volume2, Shuffle, ListMusic, Cloud, Info } from 'lucide-react';
import { formatTime } from './componentUtils.jsx';
import { AsyncArtworkImage } from './AsyncArtworkImage.jsx';
import { ExpandedPlayer } from './ExpandedPlayer.jsx';

export function PlayerBar({
  player,
  onToggleQueue,
  onOpenSongInfo,
  onAddToPlaylist,
  onDelete,
  onReview,
  onPrepare,
  onPlayNext,
  onAddToQueue,
  onOpenEqualizer,
  onMoreLikeThis,
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const hue = player.currentSong ? player.currentSong.track.charCodeAt(0) % 360 : 0;

  const {
    currentSong,
    isPlaying,
    progress,
    duration,
    volume,
    shuffleMode,
    togglePlay,
    seek,
    changeVolume,
    playNext,
    playPrev,
    toggleShuffle,
  } = player;

  return (
    <div className="player-bar">
      <div className="player-song-info">
        {currentSong ? (
          <>
            <button
              type="button"
              className="player-song-info__open"
              onClick={() => setIsExpanded(true)}
              aria-label={`Open player for ${currentSong.track} by ${currentSong.artist}`}
            >
              <AsyncArtworkImage song={currentSong} className="player-thumb" fallbackSize={16} size={96} sizes="64px" priority />
              <span className="player-meta">
                <span className="player-track">{currentSong.track}</span>
                <span className="player-artist">{currentSong.artist}</span>
              </span>
            </button>
            <Cloud size={16} color="var(--text-muted)" style={{ marginLeft: 'auto' }} />
            <button className="icon-btn player-info-btn" onClick={event => { event.stopPropagation(); onOpenSongInfo?.(currentSong); }} aria-label="Song info" title="Song info">
              <Info size={16} />
            </button>
          </>
        ) : (
          <span className="player-artist">Nothing playing</span>
        )}
      </div>

      <div className="player-controls">
        <div className="player-buttons">
          <button
            className={`icon-btn ${shuffleMode !== 'off' ? 'icon-btn--active' : ''}`}
            onClick={toggleShuffle}
            aria-label={`Shuffle: ${shuffleMode}`}
            title={`Shuffle: ${shuffleMode}`}
          >
            <Shuffle size={16} />
          </button>
          <button className="icon-btn" onClick={() => playPrev({ reason: 'user-prev' })} aria-label="Previous">
            <SkipBack size={20} />
          </button>
          <button className="play-btn" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
            {isPlaying ? <Pause size={22} fill="black" /> : <Play size={22} fill="black" />}
          </button>
          <button className="icon-btn" onClick={() => playNext({ reason: 'user-next' })} aria-label="Next">
            <SkipForward size={20} />
          </button>
          <button className="icon-btn" onClick={onToggleQueue} aria-label="Queue" title="Queue">
            <ListMusic size={16} />
          </button>
        </div>
        <div className="progress-row">
          <span className="time-label">{formatTime((progress / 100) * duration)}</span>
          <input
            type="range"
            className="progress-bar"
            min={0}
            max={100}
            step={0.1}
            value={progress}
            onChange={event => seek(Number(event.target.value))}
            aria-label="Playback position"
          />
          <span className="time-label">{formatTime(duration)}</span>
        </div>
      </div>

      <div className="player-volume">
        <Volume2 size={18} color="var(--text-muted)" />
        <input
          type="range"
          className="volume-bar"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={event => changeVolume(Number(event.target.value))}
          aria-label="Volume"
        />
      </div>
      {isExpanded && (
        <ExpandedPlayer
          key={currentSong?.songKey || 'expanded-player'}
          player={player}
          onClose={() => setIsExpanded(false)}
          hue={hue}
          onToggleQueue={onToggleQueue}
          onOpenSongInfo={onOpenSongInfo}
          onAddToPlaylist={onAddToPlaylist}
          onDelete={onDelete}
          onReview={onReview}
          onPrepare={onPrepare}
          onPlayNext={onPlayNext}
          onAddToQueue={onAddToQueue}
          onOpenEqualizer={onOpenEqualizer}
          onMoreLikeThis={onMoreLikeThis}
        />
      )}
    </div>
  );
}
