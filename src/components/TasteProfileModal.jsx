import { Download, X, Music, Clock, Users, Shield, Lock, Activity, Info, Sparkles } from 'lucide-react';
import { computeTasteCentroid } from '../services/tasteEmbeddingService.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { AsyncArtworkImage } from './AsyncArtworkImage.jsx';

export function TasteProfileModal({ isOpen, onClose, librarySummary, songs = [] }) {
  const dialogRef = useDialogFocus(isOpen, onClose);

  const metrics = librarySummary?.metrics || {};
  const tasteSignals = (librarySummary?.playbackEvents || [])
    .filter(event => ['playback-start', 'playback-resume'].includes(event.eventType));
  const tasteVector = computeTasteCentroid(songs, tasteSignals);
  const tasteSignalCount = tasteSignals.filter(event => event.songKey).length;

  const topArtists = (() => {
    if (metrics.topArtistsByStarts && metrics.topArtistsByStarts.length > 0) {
      return metrics.topArtistsByStarts.slice(0, 8);
    }
    const artistMap = new Map();
    for (const song of songs) {
      const artist = song.artist || 'Unknown Artist';
      if (!artist || artist === 'Unknown Artist') continue;
      const count = (song.playCount || 0) > 0 ? song.playCount : 1;
      artistMap.set(artist, (artistMap.get(artist) || 0) + count);
    }
    return [...artistMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([artist, plays]) => ({ artist, plays }));
  })();

  const artistSongMap = (() => {
    const map = new Map();
    for (const song of songs) {
      const artist = (song.artist || '').trim();
      if (artist && !map.has(artist.toLowerCase())) {
        map.set(artist.toLowerCase(), song);
      }
    }
    return map;
  })();

  const listeningMinutes = metrics.estimatedListeningMinutes || Math.round(
    songs.reduce((sum, s) => sum + ((s.playCount || 0) * (s.duration || 180)), 0) / 60
  );

  if (!isOpen) return null;

  const handleExportProfile = () => {
    const profile = {
      schemaVersion: 1,
      appName: 'Sisic Music',
      exportedAt: new Date().toISOString(),
      tasteVector: tasteVector ? Array.from(tasteVector) : [],
      libraryMetrics: {
        totalSongs: metrics.totalSongs || songs.length,
        totalArtists: metrics.totalArtists || topArtists.length,
        estimatedListeningMinutes: listeningMinutes,
        topArtists,
      },
    };

    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sisic-taste-profile-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal-content taste-profile-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="taste-profile-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="taste-modal-header">
          <div className="taste-modal-header-left">
            <div className="taste-target-icon" aria-hidden="true">
              <span className="target-ring target-ring--outer" />
              <span className="target-ring target-ring--mid" />
              <span className="target-ring target-ring--inner" />
            </div>
            <div className="taste-modal-titles">
              <h2 id="taste-profile-title" className="taste-modal-title">Personal Taste Profile</h2>
              <p className="taste-modal-subtitle">Client-side derived music taste vector & listening insights</p>
            </div>
          </div>

          <div className="taste-modal-header-right">
            <div className="taste-header-decor" aria-hidden="true">
              <svg className="taste-wave-graphic" viewBox="0 0 160 36" fill="none">
                <path
                  d="M0 18C20 8 35 28 55 18C75 8 90 28 110 18C130 8 145 28 160 18"
                  stroke="url(#tasteWaveGrad)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  opacity="0.8"
                />
                <circle cx="28" cy="13" r="2" fill="#38bdf8" />
                <circle cx="55" cy="18" r="2.5" fill="#6366f1" />
                <circle cx="82" cy="23" r="2" fill="#a855f7" />
                <circle cx="110" cy="18" r="2.5" fill="#f59e0b" />
                <circle cx="138" cy="13" r="2" fill="#38bdf8" />
                <defs>
                  <linearGradient id="tasteWaveGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#38bdf8" />
                    <stop offset="35%" stopColor="#6366f1" />
                    <stop offset="70%" stopColor="#a855f7" />
                    <stop offset="100%" stopColor="#f59e0b" />
                  </linearGradient>
                </defs>
              </svg>
            </div>
            <span className="taste-header-quote">"Music tells a story about who you are."</span>
            <button
              type="button"
              className="taste-close-btn"
              onClick={onClose}
              aria-label="Close taste profile"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="taste-metrics-grid">
          <div className="taste-metric-card">
            <div className="metric-card-left">
              <div className="metric-icon-bubble">
                <Music size={18} />
              </div>
              <div className="metric-text-group">
                <span className="metric-card-label">Library Songs</span>
                <div className="metric-card-val">{metrics.totalSongs || songs.length}</div>
                <span className="metric-card-sub">Your music universe</span>
              </div>
            </div>
            <div className="metric-mini-equalizer" aria-hidden="true">
              <span style={{ height: '55%' }} />
              <span style={{ height: '85%' }} />
              <span style={{ height: '40%' }} />
              <span style={{ height: '95%' }} />
              <span style={{ height: '70%' }} />
              <span style={{ height: '50%' }} />
            </div>
          </div>

          <div className="taste-metric-card">
            <div className="metric-card-left">
              <div className="metric-icon-bubble">
                <Clock size={18} />
              </div>
              <div className="metric-text-group">
                <span className="metric-card-label">Listening Time</span>
                <div className="metric-card-val">{listeningMinutes}m</div>
                <span className="metric-card-sub">Total listening time</span>
              </div>
            </div>
            <div className="metric-mini-wave" aria-hidden="true">
              <span style={{ height: '30%' }} />
              <span style={{ height: '60%' }} />
              <span style={{ height: '90%' }} />
              <span style={{ height: '75%' }} />
              <span style={{ height: '100%' }} />
              <span style={{ height: '80%' }} />
              <span style={{ height: '50%' }} />
              <span style={{ height: '35%' }} />
            </div>
          </div>

          <div className="taste-metric-card">
            <div className="metric-card-left">
              <div className="metric-icon-bubble">
                <Users size={18} />
              </div>
              <div className="metric-text-group">
                <span className="metric-card-label">Core Artists</span>
                <div className="metric-card-val">{topArtists.length}</div>
                <span className="metric-card-sub">Artists you connect with most</span>
              </div>
            </div>
            <div className="metric-avatar-stack" aria-hidden="true">
              {topArtists.slice(0, 4).map((item, idx) => {
                const song = artistSongMap.get(item.artist.toLowerCase());
                return (
                  <div key={item.artist} className="stacked-avatar" style={{ zIndex: 5 - idx }}>
                    {song ? (
                      <AsyncArtworkImage song={song} alt={item.artist} className="stacked-avatar-img" fallbackSize={12} size={36} />
                    ) : (
                      <span className="stacked-avatar-letter">{item.artist.charAt(0)}</span>
                    )}
                  </div>
                );
              })}
              {topArtists.length > 4 && (
                <div className="stacked-avatar stacked-avatar--more" style={{ zIndex: 1 }}>
                  +{topArtists.length - 4}
                </div>
              )}
            </div>
          </div>
        </div>

        <section className="top-artists-section" aria-label="Top artist affinities">
          <div className="affinities-header">
            <div className="affinities-title-row">
              <Activity size={18} className="affinities-icon" />
              <div>
                <h3 className="section-heading">Top Artist Affinities</h3>
                <span className="section-subtitle">Artists you listen to most, based on your unique taste vector</span>
              </div>
            </div>
          </div>

          <div className="artist-cards-grid">
            {topArtists.length === 0 ? (
              <span className="empty-subtext">Play more songs to build your affinity graph.</span>
            ) : (
              topArtists.map((item, idx) => {
                const song = artistSongMap.get(item.artist.toLowerCase());
                return (
                  <div key={item.artist} className="artist-rank-card">
                    <span className="artist-rank-badge">#{idx + 1}</span>
                    <div className="artist-card-art-wrap">
                      {song ? (
                        <AsyncArtworkImage song={song} alt={item.artist} className="artist-card-art" fallbackSize={18} size={64} />
                      ) : (
                        <div className="artist-card-art-fallback">{item.artist.charAt(0)}</div>
                      )}
                    </div>
                    <strong className="artist-card-name" title={item.artist}>{item.artist}</strong>
                    <span className="artist-card-plays">{item.plays} play{item.plays === 1 ? '' : 's'}</span>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="taste-vector-section" aria-label="Taste vector profile">
          <div className="taste-vector-header">
            <div className="taste-vector-title-row">
              <Sparkles size={18} className="taste-vector-icon" />
              <div>
                <h3 className="taste-vector-title">Your Taste Vector</h3>
                <p className="taste-vector-subtitle">
                  A 64-dimensional vector that captures your musical preferences across genres, moods, and audio traits.
                </p>
              </div>
            </div>

            <div className="taste-vector-status-badge">
              <span className="taste-status-pill">
                <span className="taste-profile-status__dot" />
                <span>{tasteVector?.length ? 'Profile ready' : 'Waiting for data'}</span>
              </span>
              <span className="taste-status-divider">|</span>
              <span className="taste-status-info">
                {tasteVector?.length || 64}-dimensional vector · {tasteSignalCount.toLocaleString()} listening signal{tasteSignalCount === 1 ? '' : 's'}
              </span>
            </div>
          </div>

          <div className="taste-vector-content-grid">
            <div className="taste-vector-chart-card">
              <div className="vector-y-axis" aria-hidden="true">
                <span>1.0</span>
                <span>0.5</span>
                <span>0.0</span>
              </div>

              <div className="vector-bars-container">
                {tasteVector && tasteVector.length > 0 ? (
                  <div className="vector-bars-flex" role="img" aria-label="64-dimensional musical taste vector graph">
                    {Array.from({ length: 64 }).map((_, i) => {
                      const val = tasteVector[i] ?? 0;
                      const pct = val > 0 ? Math.min(100, Math.max(0, val * 100)) : 0;

                      let barColor = '#38bdf8';
                      if (i >= 16 && i < 32) barColor = '#6366f1';
                      else if (i >= 32 && i < 48) barColor = '#c084fc';
                      else if (i >= 48) barColor = '#f59e0b';

                      return (
                        <div key={i} className="vector-bar-column" title={`Dim ${i + 1}: ${val.toFixed(3)}`}>
                          <span
                            className="vector-bar vector-bar--pos"
                            style={{
                              height: `${pct}%`,
                              bottom: 0,
                              backgroundColor: barColor,
                              boxShadow: pct > 0 ? `0 0 5px ${barColor}55` : 'none',
                            }}
                          />
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="vector-empty-state">
                    Play songs in your library to generate your client-side 64-dimensional taste vector.
                  </div>
                )}
              </div>
            </div>

            <div className="taste-vector-insights-card">
              <h4 className="insights-title">Taste Vector Insights</h4>
              <ul className="insights-list">
                <li>
                  <div className="insights-icon-wrap">
                    <Music size={15} />
                  </div>
                  <div>
                    <strong>64 dimensions</strong>
                    <p>Captures genre, mood, era, and audio traits</p>
                  </div>
                </li>
                <li>
                  <div className="insights-icon-wrap">
                    <Lock size={15} />
                  </div>
                  <div>
                    <strong>Local computation</strong>
                    <p>Calculated in-browser from your playback history</p>
                  </div>
                </li>
                <li>
                  <div className="insights-icon-wrap">
                    <Shield size={15} />
                  </div>
                  <div>
                    <strong>Export your profile</strong>
                    <p>Save the current taste vector as a JSON file</p>
                  </div>
                </li>
              </ul>
            </div>
          </div>
        </section>

        <div className="taste-export-banner">
          <div className="taste-export-info">
            <Info size={17} className="taste-info-icon" />
            <p>
              Your taste vector is calculated in your browser from your library and listening history. Export it as a JSON file to inspect or back up.
            </p>
          </div>
          <button
            type="button"
            className="taste-export-btn"
            onClick={handleExportProfile}
          >
            <Download size={15} />
            <span>Export Taste Vector JSON</span>
          </button>
        </div>
      </div>
    </div>
  );
}
