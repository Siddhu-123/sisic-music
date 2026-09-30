import { ProgressSlider } from './ProgressSlider.jsx';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Play, Pause, SkipForward, SkipBack, Download, Shuffle, Repeat, Repeat1, ListMusic, Plus, Trash2, ChevronDown, Info, RefreshCw, Sliders, Sparkles, LoaderCircle, MoreHorizontal, FileText, Music2, Search } from 'lucide-react';
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
  onPrepare,
  onPlayNext,
  onAddToQueue,
  onOpenEqualizer,
  onMoreLikeThis,
  onSearchLibrary,
}) {
  const {
    currentSong,
    isPlaying,
    isSpinningDown,
    isBuffering,
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
  const [libraryQuery, setLibraryQuery] = useState('');
  const displayedProgress = progressPreview ?? progress;
  const isOpen = Boolean(currentSong);
  useEffect(() => {
    if (!isOpen) return undefined;
    // The player is portalled so sibling dialogs can open above it. Only the
    // background surfaces become inert; the app's dialog layers stay usable.
    const surfaces = [...document.querySelectorAll('.sidebar, .main-view, .player-bar, .mobile-nav')];
    const previous = surfaces.map(element => element.inert);
    surfaces.forEach(element => { element.inert = true; });
    return () => surfaces.forEach((element, index) => { element.inert = previous[index]; });
  }, [isOpen]);
  const dialogRef = useDialogFocus(isOpen, onClose);

  if (!currentSong) return null;

  const crateSongs = (queue || []).filter((song, index) => index !== queueIndex).slice(0, 10);

  return createPortal(
    <div
      ref={dialogRef}
      className="expanded-player expanded-player--reference"
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
        <div className="expanded-player__header-tools">
          <div className="expanded-now-playing-badge" aria-hidden="true">
            <Music2 size={13} className="expanded-now-playing-icon" />
            <span>NOW PLAYING</span>
          </div>
          <div className="expanded-player__header-actions">
            {onOpenEqualizer && (
              <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onOpenEqualizer(); }} aria-label="Equalizer" title="Equalizer">
                <Sliders size={18} />
              </button>
            )}
            {onMoreLikeThis && (
              <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onMoreLikeThis(currentSong); }} aria-label="More Like This" title="More Like This">
                <Sparkles size={18} />
              </button>
            )}
          </div>
        </div>

        {onSearchLibrary && (
          <form className="expanded-player__search-bar" onSubmit={event => {
            event.preventDefault();
            onSearchLibrary(libraryQuery.trim());
            onClose();
          }}>
            <Search size={16} className="expanded-search-icon" />
            <input
              type="search"
              placeholder="Search your library…"
              aria-label="Search library by song or artist"
              value={libraryQuery}
              onChange={event => setLibraryQuery(event.target.value)}
            />
            <button type="submit" aria-label="Show library search results">Search</button>
          </form>
        )}

        <button className="icon-btn icon-btn--close" onClick={(e) => { e.stopPropagation(); onClose(); }} aria-label="Minimize player" title="Minimize player">
          <ChevronDown size={22} />
        </button>
      </div>

      <div className="expanded-player__content">
        <div className="expanded-player__layout">
          <div className="expanded-player__art-container">
            <Turntable
              showCrate={false}
              currentSong={currentSong}
              artwork={<AsyncArtworkImage song={currentSong} alt={`${currentSong.track} cover`} className="turntable__art" fallbackSize={28} size={400} priority />}
              isPlaying={isPlaying}
              isBraking={isSpinningDown}
              isBuffering={isBuffering}
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
              <div className="expanded-now-playing-header">
                <div className="expanded-now-playing-badge" aria-hidden="true">
                  <Music2 size={13} className="expanded-now-playing-icon" />
                  <span>NOW PLAYING</span>
                </div>
                <div className="expanded-details-header-actions">
                  <button
                    className="icon-btn"
                    onClick={(e) => { e.stopPropagation(); onOpenSongInfo?.(currentSong); }}
                    aria-label="Song details"
                    title="Song details"
                  >
                    <MoreHorizontal size={19} />
                  </button>
                </div>
              </div>
              <h2 id="expanded-player-title" className="expanded-player__title">{currentSong.track}</h2>
              <p className="expanded-player__artist">{currentSong.artist}</p>
              {(() => {
                const parts = [];
                if (currentSong.album) parts.push(`From the album ${currentSong.album}`);
                if (currentSong.year) parts.push(currentSong.year);
                if (currentSong.genre) parts.push(currentSong.genre);
                return parts.length > 0 ? (
                  <p className="expanded-player__subtitle">{parts.join(' · ')}</p>
                ) : null;
              })()}
            </div>

            <div className="expanded-player__controls-area">
              <div className="expanded-progress">
                <span className="time-label">{formatTime((displayedProgress / 100) * duration)}</span>
                <ProgressSlider key={currentSong.songKey || currentSong.id} player={player} progress={displayedProgress} />
                <span className="time-label">{formatTime(duration)}</span>
              </div>

              <div className="expanded-controls">
                <button className= "key">
                  
                </button>
                <button
                  className={`icon-btn ${shuffleMode !== 'off' ? 'icon-btn--active' : ''}`}
                  onClick={toggleShuffle}
                  aria-label={`Shuffle: ${shuffleMode}`}
                >
                  <Shuffle size={20} />
                </button>
                <button className="icon-btn" onClick={() => playPrev({ reason: 'user-prev' })} aria-label="Previous">
                  <SkipBack size={26} />
                </button>
                <button className="play-btn play-btn--large" onClick={togglePlay} aria-label={player.isPlayRequested ? 'Pause' : 'Play'}>
                  {player.isBuffering && player.isPlayRequested ? (
                    <LoaderCircle className="spin" size={26} />
                  ) : isPlaying ? (
                    <Pause size={26} fill="currentColor" />
                  ) : (
                    <Play size={26} fill="currentColor" />
                  )}
                </button>
                <button className="icon-btn" onClick={() => playNext({ reason: 'user-next' })} aria-label="Next">
                  <SkipForward size={26} />
                </button>
                <button className={`icon-btn ${repeatMode !== 'off' ? 'icon-btn--active' : ''}`} onClick={toggleRepeat} aria-label={`Repeat: ${repeatMode}`}>
                  {repeatMode === 'one' ? <Repeat1 size={20} /> : <Repeat size={20} />}
                </button>
                <button className="icon-btn" onClick={onToggleQueue} aria-label="Queue" title="Queue">
                  <ListMusic size={20} />
                </button>
              </div>

              <div className="expanded-player__actions" role="group" aria-label="Song actions">
                <button className="panel-action-btn" onClick={() => onAddToPlaylist?.(currentSong)}><Plus size={15} /> Add to playlist</button>
                <button className="panel-action-btn" onClick={() => onAddToQueue?.(currentSong)}><ListMusic size={15} /> Add to queue</button>
                <button className="panel-action-btn" onClick={() => onPrepare?.(currentSong)}><Download size={15} /> Prepare on Drive</button>
                <button className="panel-action-btn" onClick={() => onPlayNext?.(currentSong)}><SkipForward size={15} /> Play next</button>
                <button className="panel-action-btn" onClick={() => onOpenSongInfo?.(currentSong)}><Info size={15} /> Info</button>
                <button className="panel-action-btn" onClick={() => onReview?.(currentSong)}><RefreshCw size={15} /> Review</button>
                <button className="panel-action-btn panel-action-btn--danger" onClick={() => onDelete?.(currentSong)}><Trash2 size={15} /> Delete</button>
              </div>
            </div>

            <div className="expanded-player__metadata">
              <section className="expanded-player__text-panel">
                <div className="expanded-card-header">
                  <div className="expanded-card-title-row">
                    <FileText size={15} />
                    <h3>LYRICS</h3>
                  </div>
                  {onOpenSongInfo && (
                    <button type="button" className="expanded-card-link" onClick={() => onOpenSongInfo(currentSong)}>
                      Song info &rarr;
                    </button>
                  )}
                </div>
                <div className="expanded-lyrics-box" tabIndex={currentSong.lyrics ? 0 : undefined} aria-label="Lyrics">
                  <p>{currentSong.lyrics || 'No lyrics available for this track.'}</p>
                </div>
              </section>

              <section className="expanded-player__text-panel">
                <div className="expanded-card-header">
                  <div className="expanded-card-title-row">
                    <Info size={15} />
                    <h3>DESCRIPTION</h3>
                  </div>
                </div>
                <div className="expanded-desc-box">
                  <p className="expanded-desc-text" tabIndex={currentSong.description ? 0 : undefined} aria-label="Track description">
                    {currentSong.description || 'No description available for this track.'}
                  </p>
                  <div className="expanded-meta-grid">
                    <div className="expanded-meta-row">
                      <span className="meta-k">Artist</span>
                      <strong className="meta-v">{currentSong.artist || '—'}</strong>
                    </div>
                    <div className="expanded-meta-row">
                      <span className="meta-k">Album</span>
                      <strong className="meta-v">{currentSong.album || '—'}</strong>
                    </div>
                    <div className="expanded-meta-row">
                      <span className="meta-k">Genre</span>
                      <strong className="meta-v">{currentSong.genre || '—'}</strong>
                    </div>
                    <div className="expanded-meta-row">
                      <span className="meta-k">Year</span>
                      <strong className="meta-v">{currentSong.year || '—'}</strong>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>

        {crateSongs.length > 0 && (
          <section className="expanded-crate-section" aria-label="From your crate">
            <div className="expanded-crate-header">
              <div className="expanded-crate-title">
                <Music2 size={18} className="crate-title-icon" />
                <div>
                  <h3>FROM YOUR CRATE</h3>
                  <span>From your queue</span>
                </div>
              </div>
              {onToggleQueue && (
                <button type="button" className="crate-view-all-btn" onClick={onToggleQueue}>
                  View queue &rarr;
                </button>
              )}
            </div>

            <div className="expanded-crate-row">
              {crateSongs.map(song => {
                const key = song.songKey || song.id;
                return (
                  <button
                    type="button"
                    key={key}
                    className="crate-card"
                    onClick={() => {
                      const nextIndex = queue.findIndex(item => (item.songKey || item.id) === (song.songKey || song.id));
                      if (nextIndex >= 0) playQueueItem(nextIndex);
                    }}
                  >
                    <div className="crate-card__art-wrap">
                      <AsyncArtworkImage song={song} alt={`${song.track} cover`} className="crate-card__art" fallbackSize={22} size={260} />
                      <span className="crate-card__play-badge" aria-hidden="true">
                        <Play size={16} fill="currentColor" />
                      </span>
                    </div>
                    <div className="crate-card__meta">
                      <strong className="crate-card__track">{song.track}</strong>
                      <span className="crate-card__artist">{song.artist}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>,
    document.body,
  );
}
