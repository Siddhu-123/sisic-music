import { useMemo, useRef, useState } from 'react';
import { Download, X, Music, Clock, Users, Shield, Lock, Activity, Info, Sparkles, Layers, Upload, Play, Merge } from 'lucide-react';
import {
  blendTastePassports,
  buildTastePassport,
  parseTastePassport,
  scoreLibraryWithPassport,
  TASTE_PASSPORT_MAX_BYTES,
} from '../services/tastePassportService.js';
import { getPlaybackContext } from '../services/contextualRecommendationService.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { AsyncArtworkImage } from './AsyncArtworkImage.jsx';

const MAX_BARS = 64;
const MIX_SIZE = 30;

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Long vectors (200-dimension audio) are grouped so the chart never exceeds MAX_BARS.
function binVector(vector = []) {
  if (!vector.length) return [];
  const size = Math.ceil(vector.length / MAX_BARS);
  const bars = [];
  for (let start = 0; start < vector.length; start += size) {
    const slice = vector.slice(start, start + size);
    bars.push(slice.reduce((sum, value) => sum + value, 0) / slice.length);
  }
  return bars;
}

const spaceLabel = space => (space.vectorType === 'learned-audio' ? `Sound · ${space.model}` : 'Title, artist & mood tags');

export function TasteProfileModal({ isOpen, onClose, librarySummary, songs = [], likedSongKeys = [], onPlayMix }) {
  const dialogRef = useDialogFocus(isOpen, onClose);
  const fileInputRef = useRef(null);
  const [imported, setImported] = useState(null);
  // Captured once when the modal mounts; the time-of-day label should not flicker while it is open.
  const [currentBucket] = useState(() => getPlaybackContext(Date.now()).timeBucket);
  const [notice, setNotice] = useState({ tone: 'info', text: '' });

  const metrics = librarySummary?.metrics || {};
  const playbackEvents = librarySummary?.playbackEvents;

  // The same signals Explore ranks with: recency-weighted plays, skips and likes.
  const passport = useMemo(
    () => (isOpen ? buildTastePassport({ songs, playbackEvents: playbackEvents || [], likedSongKeys }) : null),
    [isOpen, songs, playbackEvents, likedSongKeys],
  );
  const primary = passport?.spaces[0] || null;
  const tasteVector = primary?.longTerm || null;
  const tasteSignalCount = passport
    ? passport.stats.positiveSignals + passport.stats.negativeSignals + passport.stats.explicitSignals
    : 0;
  const bars = useMemo(() => binVector(tasteVector || []), [tasteVector]);
  const barScale = Math.max(0, ...bars) || 1;
  const vectorGroup = tasteVector ? Math.ceil(tasteVector.length / MAX_BARS) : 1;
  const currentBucketEntry = primary?.contexts[currentBucket] || null;

  // Mixes are drawn from playable songs when the library has any.
  const pool = useMemo(() => {
    const playable = songs.filter(song => song.driveFileId);
    return playable.length ? playable : songs;
  }, [songs]);
  const theirMix = useMemo(
    () => (imported ? scoreLibraryWithPassport(imported.passport, pool, { limit: MIX_SIZE }) : null),
    [imported, pool],
  );

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

  const today = new Date().toISOString().slice(0, 10);
  const canExport = Boolean(passport && (passport.spaces.length || passport.anchors.liked.length));

  const handleImportFile = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > TASTE_PASSPORT_MAX_BYTES) {
      setNotice({ tone: 'error', text: 'That file is too large to be a taste passport.' });
      return;
    }
    const result = parseTastePassport(await file.text());
    if (!result.ok) {
      setImported(null);
      setNotice({ tone: 'error', text: result.errors[0] || 'Could not read that passport.' });
      return;
    }
    setImported({ passport: result.passport, fileName: file.name });
    setNotice({ tone: result.errors.length ? 'warn' : 'info', text: result.errors.length ? `Imported with ${result.errors.length} part(s) skipped: ${result.errors[0]}` : `Imported ${file.name}. Nothing leaves your device.` });
  };

  const playMix = (mix, label) => {
    if (!mix?.songs?.length) {
      setNotice({ tone: 'error', text: mix?.explanation || 'No songs to play from that passport.' });
      return;
    }
    onPlayMix?.(mix.songs);
    setNotice({ tone: 'info', text: `Playing ${label}: ${mix.songs.length} songs. ${mix.explanation}` });
  };

  const blendedPassport = () => (passport && imported ? blendTastePassports(passport, imported.passport) : null);

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

        {primary?.interests.length > 0 && (
          <section className="top-artists-section" aria-label="Your sounds">
            <div className="affinities-header">
              <div className="affinities-title-row">
                <Layers size={18} className="affinities-icon" />
                <div>
                  <h3 className="section-heading">Your Sounds</h3>
                  <span className="section-subtitle">
                    {primary.interests.length > 1 ? 'Distinct tastes found in your listening, each ranked on its own' : 'One consistent taste so far'}
                  </span>
                </div>
              </div>
            </div>
            <ul className="interest-list">
              {primary.interests.map(interest => (
                <li key={interest.label} className="interest-row">
                  <span className="interest-label" title={interest.label}>{interest.label}</span>
                  <span className="interest-track" aria-hidden="true"><span style={{ width: `${Math.max(4, Math.round(interest.weight * 100))}%` }} /></span>
                  <span className="interest-pct">{Math.round(interest.weight * 100)}%</span>
                </li>
              ))}
            </ul>
            {currentBucketEntry && (
              <p className="interest-context">Right now ({currentBucket}) your taste is tuned from {currentBucketEntry.sessions} past {currentBucket} session{currentBucketEntry.sessions === 1 ? '' : 's'}.</p>
            )}
          </section>
        )}

        <section className="taste-vector-section" aria-label="Taste vector profile">
          <div className="taste-vector-header">
            <div className="taste-vector-title-row">
              <Sparkles size={18} className="taste-vector-icon" />
              <div>
                <h3 className="taste-vector-title">Your Taste Vector</h3>
                <p className="taste-vector-subtitle">
                  {primary
                    ? `Your long-term taste as a ${primary.dimensions}-dimensional vector in the "${spaceLabel(primary)}" space. Distinct tastes are kept apart below.`
                    : 'Your long-term taste as a vector. Play or like a few songs to build it.'}
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
                {tasteVector?.length ? `${tasteVector.length}-dimensional vector · ` : ''}{tasteSignalCount.toLocaleString()} listening signal{tasteSignalCount === 1 ? '' : 's'}
              </span>
            </div>
          </div>

          <div className="taste-vector-content-grid">
            <div className="taste-vector-chart-card">
              <div className="vector-y-axis" aria-hidden="true">
                <span>max</span>
                <span>½</span>
                <span>0</span>
              </div>

              <div className="vector-bars-container">
                {bars.length > 0 ? (
                  <div className="vector-bars-flex" role="img" aria-label={`${tasteVector.length}-dimensional musical taste vector graph`}>
                    {bars.map((val, i) => {
                      const pct = val > 0 ? Math.min(100, (val / barScale) * 100) : 0;
                      const quarter = i / bars.length;
                      let barColor = '#38bdf8';
                      if (quarter >= 0.75) barColor = '#f59e0b';
                      else if (quarter >= 0.5) barColor = '#c084fc';
                      else if (quarter >= 0.25) barColor = '#6366f1';

                      return (
                        <div key={i} className="vector-bar-column" title={`Dimension${vectorGroup > 1 ? 's' : ''} ${(i * vectorGroup) + 1}${vectorGroup > 1 ? `–${Math.min(tasteVector.length, (i + 1) * vectorGroup)}` : ''}: ${val.toFixed(3)}`}>
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
                    Play or like a few songs and your taste vector will appear here.
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
                    <strong>{primary?.interests.length > 1 ? `${primary.interests.length} separate tastes` : 'One taste so far'}</strong>
                    <p>{primary?.interests.length > 1 ? 'Songs are matched to the taste they fit best, not an average of all of them' : 'A second taste appears once your listening splits into distinct groups'}</p>
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
                    <strong>Portable passport</strong>
                    <p>Export it below to use your taste in other apps. No play history is included</p>
                  </div>
                </li>
              </ul>
            </div>
          </div>
        </section>

        <section className="passport-panel" aria-label="Taste passport">
          <div className="passport-header">
            <Layers size={18} className="taste-vector-icon" />
            <div>
              <h3 className="taste-vector-title">Taste Passport</h3>
              <p className="taste-vector-subtitle">
                A portable file that describes your taste to any app or person. It holds no play history: only the shape of your taste.
              </p>
            </div>
          </div>

          <ul className="passport-layers">
            <li>
              <strong>Sound space</strong>
              <span>
                {passport?.spaces.find(space => space.interoperable)
                  ? `${passport.spaces.find(space => space.interoperable).model} · works in any app using the same open model`
                  : 'Not available yet. Analyse songs with the Mac worker to add one.'}
              </span>
            </li>
            <li>
              <strong>Anchor tracks</strong>
              <span>{passport?.anchors.liked.length || 0} songs that define your taste. Any app can match them to its own catalogue.</span>
            </li>
            <li>
              <strong>Genres, moods, artists</strong>
              <span>A coarse fallback for apps that share no model with you.</span>
            </li>
          </ul>

          <div className="passport-actions">
            <button
              type="button"
              className="taste-export-btn"
              disabled={!canExport}
              onClick={() => downloadJson(passport, `sisic-taste-passport-${today}.json`)}
            >
              <Download size={15} />
              <span>Export passport</span>
            </button>
            <button type="button" className="taste-export-btn passport-btn--ghost" onClick={() => fileInputRef.current?.click()}>
              <Upload size={15} />
              <span>Import a passport</span>
            </button>
            <input ref={fileInputRef} type="file" accept="application/json,.json" className="passport-file-input" onChange={handleImportFile} aria-label="Import a taste passport file" />
          </div>

          {notice.text && <p className={`passport-notice passport-notice--${notice.tone}`} role="status">{notice.text}</p>}

          {imported && theirMix && (
            <div className="passport-import">
              <div className="passport-import__head">
                <div>
                  <strong>From {imported.passport.generator.name}</strong>
                  <span>
                    {imported.fileName}
                    {imported.passport.createdAt ? ` · ${new Date(imported.passport.createdAt).toLocaleDateString()}` : ''}
                    {` · ${imported.passport.anchors.liked.length} anchor tracks`}
                  </span>
                </div>
                <button type="button" className="passport-link" onClick={() => { setImported(null); setNotice({ tone: 'info', text: '' }); }}>Remove</button>
              </div>
              {imported.passport.descriptors.genres.length > 0 && (
                <div className="artist-chips-container">
                  {imported.passport.descriptors.genres.slice(0, 5).map(genre => (
                    <div key={genre.label} className="artist-affinity-chip"><span className="chip-name">{genre.label}</span></div>
                  ))}
                </div>
              )}
              <p className="passport-import__how">{theirMix.songs.length ? `A ${theirMix.songs.length}-song mix from your library is ready. ${theirMix.explanation}` : theirMix.explanation}</p>
              <div className="passport-actions">
                <button type="button" className="taste-export-btn" disabled={!theirMix.songs.length || !onPlayMix} onClick={() => playMix(theirMix, 'their mix')}>
                  <Play size={15} />
                  <span>Play their mix</span>
                </button>
                <button
                  type="button"
                  className="taste-export-btn passport-btn--ghost"
                  disabled={!passport || !onPlayMix}
                  onClick={() => playMix(scoreLibraryWithPassport(blendedPassport(), pool, { limit: MIX_SIZE }), 'a blend of you both')}
                >
                  <Merge size={15} />
                  <span>Play a blend of us</span>
                </button>
                <button
                  type="button"
                  className="taste-export-btn passport-btn--ghost"
                  disabled={!canExport}
                  onClick={() => downloadJson(blendedPassport(), `sisic-taste-blend-${today}.json`)}
                >
                  <Download size={15} />
                  <span>Export blend</span>
                </button>
              </div>
            </div>
          )}

          <p className="passport-privacy"><Info size={14} aria-hidden="true" /> Passports are built and read on this device. Nothing is uploaded, and imported files are checked and size-limited before use.</p>
        </section>
      </div>
    </div>
  );
}
