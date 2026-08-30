import { useState } from 'react';
import { Play, Pause, SkipForward, SkipBack, Download, Shuffle, Repeat, ListMusic, Plus, Trash2, ChevronDown, Info, RefreshCw, Sliders, Sparkles } from 'lucide-react';
import { Turntable } from './Turntable.jsx';
import { formatTime } from './componentUtils.jsx';
import { AsyncArtworkImage } from './AsyncArtworkImage.jsx';
import { useDialogFocus } from '../hooks/useDialogFocus.js';

export function ExpandedPlayer({
  player,
  onClose,
  hue,
  onToggleQueue,
  onOpenSongInfo,
  onAddToPlaylist,
  onDelete,
  onReview,
  onDownload,
  onPlayNext,
  onAddToQueue,
  onOpenEqualizer,
  onMoreLikeThis,
}) {
  const {
    currentSong,
    isPlaying,
    isSpinningDown,
    progress,
    duration,
    shuffleMode,
    togglePlay,
    seek,
    playNext,
    playPrev,
    toggleShuffle,
    repeatMode,
    toggleRepeat,
    rpm,
    setRpm,
    pitchModifier,
    pitchRange,
    setPitchModifier,
    setPitchRange,
    beginScratch,
    setScratchAngularVelocity,
    endScratch,
    setNeedleLifted,
    queue,
    queueIndex,
    playQueueItem,
    stop,
  } = player;

  const [progressPreview, setProgressPreview] = useState(null);
  const displayedProgress = progressPreview ?? progress;
  const dialogRef = useDialogFocus(Boolean(currentSong), onClose);

  if (!currentSong) return null;

  return (
    <div
      ref={dialogRef}
      className="expanded-player"
      role="dialog"
      aria-modal="true"
      aria-labelledby="expanded-player-title"
      tabIndex={-1}
    >
      <div
        className="expanded-player__bg"
        style={{
          '--expanded-player-hue': hue,
          '--expanded-player-hue-secondary': (hue + 40) % 360,
        }}
      />
      <div className="expanded-player__header">
        <div className="expanded-player__header-actions">
          {onOpenEqualizer && (
            <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onOpenEqualizer(); }} aria-label="Equalizer" title="Equalizer">
              <Sliders size={20} />
            </button>
          )}
          {onMoreLikeThis && (
            <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onMoreLikeThis(currentSong); }} aria-label="More Like This" title="More Like This">
              <Sparkles size={20} />
            </button>
          )}
        </div>
        <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onClose(); }} aria-label="Minimize player">
          <ChevronDown size={24} />
        </button>
      </div>

      <div className="expanded-player__content">
        <div className="expanded-player__layout">
          <div className="expanded-player__art-container">
            <Turntable
              currentSong={currentSong}
              artwork={<AsyncArtworkImage song={currentSong} alt={`${currentSong.track} cover`} className="turntable__art" fallbackSize={28} size={400} priority />}
              isPlaying={isPlaying}
              isBraking={isSpinningDown}
              progress={displayedProgress}
              duration={duration}
              rpm={rpm}
              pitchModifier={pitchModifier}
              pitchRange={pitchRange}
              queue={queue}
              queueIndex={queueIndex}
              onTogglePlay={togglePlay}
              onSeek={seek}
              onScratchStart={beginScratch}
              onScratchVelocity={setScratchAngularVelocity}
              onScratchEnd={endScratch}
              onNeedleLift={setNeedleLifted}
              onEject={stop}
              onProgressPreview={setProgressPreview}
              onLoadSong={song => {
                const nextIndex = queue.findIndex(item => (item.songKey || item.id) === (song.songKey || song.id));
                if (nextIndex >= 0) playQueueItem(nextIndex);
              }}
              onPitchChange={setPitchModifier}
              onPitchRangeChange={setPitchRange}
              onRpmChange={setRpm}
            />
          </div>

          <div className="expanded-player__details-column">
            <div className="expanded-player__info">
              <h2 id="expanded-player-title" className="expanded-player__title">{currentSong.track}</h2>
              <p className="expanded-player__artist">{currentSong.artist}</p>
            </div>

            <div className="expanded-player__metadata">
              <section className="expanded-player__text-panel">
                <h3>Lyrics</h3>
                <p>{currentSong.lyrics || 'Lyrics will appear here when song metadata is available.'}</p>
              </section>
              <section className="expanded-player__text-panel">
                <h3>Description</h3>
                <p>{currentSong.description || 'Song description and credits will appear here when available.'}</p>
              </section>
            </div>

            <div className="expanded-player__controls-area">
            <div className="expanded-progress">
            <span className="time-label">{formatTime((displayedProgress / 100) * duration)}</span>
            <input
              type="range"
              className="progress-bar"
              min={0}
              max={100}
              step={0.1}
              value={displayedProgress}
              onChange={event => {
                setProgressPreview(null);
                seek(Number(event.target.value));
              }}
              aria-label="Playback position"
            />
            <span className="time-label">{formatTime(duration)}</span>
          </div>

          <div className="expanded-controls">
            <button
              className={`icon-btn ${shuffleMode !== 'off' ? 'icon-btn--active' : ''}`}
              onClick={toggleShuffle}
              aria-label={`Shuffle: ${shuffleMode}`}
            >
              <Shuffle size={20} />
            </button>
            <button className={`icon-btn ${repeatMode !== 'off' ? 'icon-btn--active' : ''}`} onClick={toggleRepeat} aria-label={`Repeat: ${repeatMode}`}>
              <Repeat size={20} />
            </button>
            <button className="icon-btn" onClick={() => playPrev({ reason: 'user-prev' })} aria-label="Previous">
              <SkipBack size={26} />
            </button>
            <button className="play-btn play-btn--large" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
              {isPlaying ? <Pause size={26} fill="currentColor" /> : <Play size={26} fill="currentColor" />}
            </button>
            <button className="icon-btn" onClick={() => playNext({ reason: 'user-next' })} aria-label="Next">
              <SkipForward size={26} />
            </button>
            <button className="icon-btn" onClick={onToggleQueue} aria-label="Queue" title="Queue">
              <ListMusic size={20} />
            </button>
          </div>
              <div className="expanded-player__actions" role="group" aria-label="Song actions">
                <button className="panel-action-btn" onClick={() => onOpenSongInfo?.(currentSong)}><Info size={16} /> Info</button>
                <button className="panel-action-btn" onClick={() => onAddToPlaylist?.(currentSong)}><Plus size={16} /> Playlist</button>
                <button className="panel-action-btn" onClick={() => onPlayNext?.(currentSong)}><SkipForward size={16} /> Play next</button>
                <button className="panel-action-btn" onClick={() => onAddToQueue?.(currentSong)}><ListMusic size={16} /> Queue</button>
                <button className="panel-action-btn" onClick={() => onDownload?.(currentSong)}><Download size={16} /> Offline</button>
                <button className="panel-action-btn" onClick={() => onReview?.(currentSong)}><RefreshCw size={16} /> Review</button>
                <button className="panel-action-btn panel-action-btn--danger" onClick={() => onDelete?.(currentSong)}><Trash2 size={16} /> Delete</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
