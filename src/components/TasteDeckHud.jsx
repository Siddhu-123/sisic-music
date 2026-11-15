import React, { useEffect, useMemo, useRef } from 'react';
import { Activity, Cpu, Database, Play, Search, Sparkles } from 'lucide-react';
import { buildContextualTasteProfile, rankContextualSongs } from '../services/contextualRecommendationService.js';
import { outcomeWeight } from '../services/behaviourLearning.js';
import { labelCluster } from '../services/galaxyService.js';
import { selectUpcomingQueueItems } from '../services/libraryViewModel.js';
import { dot } from '../services/tasteInterests.js';
import { getSongKey } from '../songIdentity.js';

const CLUSTER_PALETTE = ['#4de2ff', '#ffb84d', '#a78bfa', '#74d99f'];

export function StudioTopBar({
  isAuthenticated,
  isSyncing,
  hasLocalData = false,
  vectorCount = 0,
  vectorDimensions = 64,
  readyCount = 0,
  searchQuery = '',
  onSearchChange,
  onSearchSubmit,
  onOpenTasteProfile,
  onOpenStorage,
  onReconnect,
}) {
  const inputRef = useRef(null);

  useEffect(() => {
    const handleKeyDown = event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const activeDimLabel = vectorCount > 0 ? `${vectorDimensions}D V3` : `${vectorDimensions}D META`;
  const vectorTitle = vectorCount > 0
    ? `Open Taste Profile & ${vectorDimensions}D Vector Analytics`
    : `Open Taste Profile & ${vectorDimensions}D Metadata Vector Analytics`;

  const vaultLabel = isSyncing
    ? 'SYNCING'
    : isAuthenticated
      ? 'VAULT OK'
      : hasLocalData
        ? 'DEV CACHE'
        : 'OFFLINE';

  return (
    <header className="studio-topbar" aria-label="Workspace telemetry and search">
      <form
        className="studio-command-search"
        onSubmit={event => {
          event.preventDefault();
          onSearchSubmit?.(searchQuery);
        }}
      >
        <Search size={15} className="studio-command-search__icon" aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          className="studio-command-search__input"
          placeholder="Search tracks, moods, or sound similarity..."
          value={searchQuery}
          onChange={event => onSearchChange?.(event.target.value)}
          aria-label="Universal library search"
          autoComplete="off"
        />
        <kbd className="studio-command-search__kbd">⌘K</kbd>
      </form>

      <div className="studio-telemetry-pills">
        <button
          type="button"
          className={`studio-pill ${isAuthenticated ? 'studio-pill--ok' : 'studio-pill--warn'}`}
          onClick={isAuthenticated ? onOpenStorage : onReconnect}
          title={isAuthenticated ? 'Google Drive connected' : 'Reconnect Google Drive'}
        >
          <span className="studio-pill__dot" aria-hidden="true" />
          {vaultLabel}
        </button>
        <button
          type="button"
          className="studio-pill studio-pill--amber"
          onClick={onOpenTasteProfile}
          title={vectorTitle}
        >
          <Cpu size={12} aria-hidden="true" />
          {activeDimLabel}{vectorCount > 0 ? ` · ${vectorCount.toLocaleString()}` : ''}
        </button>
        <button
          type="button"
          className="studio-pill studio-pill--cyan"
          onClick={onOpenStorage}
          title="Open Drive storage & sync dashboard"
        >
          <Database size={12} aria-hidden="true" />
          SYNCED · {readyCount.toLocaleString()}
        </button>
      </div>
    </header>
  );
}

function songCosine(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return null;
  return dot(vecA, vecB);
}

/**
 * Computes real chronological listening & energy trajectory points directly from
 * `playbackEvents` + song `energy` (returns null when there are fewer than 2 events).
 */
function buildRealTrajectory(playbackEvents = [], songByKey = new Map()) {
  const ordered = playbackEvents
    .filter(evt => evt && (evt.songKey || evt.track))
    .map(evt => ({
      ...evt,
      ts: Date.parse(evt.createdAt || evt.timestamp || '') || 0,
    }))
    .sort((a, b) => a.ts - b.ts);

  if (ordered.length < 2) return null;

  const bucketCount = Math.min(18, ordered.length);
  const bucketSize = ordered.length / bucketCount;
  const engagementPts = [];
  const energyPts = [];

  for (let b = 0; b < bucketCount; b++) {
    const start = Math.floor(b * bucketSize);
    const end = Math.max(start + 1, Math.floor((b + 1) * bucketSize));
    const slice = ordered.slice(start, end);
    let netOutcome = 0;
    let energySum = 0;
    let energyCount = 0;
    for (const evt of slice) {
      netOutcome += outcomeWeight(evt);
      const song = songByKey.get(evt.songKey);
      if (song && Number.isFinite(Number(song.energy))) {
        energySum += Number(song.energy);
        energyCount++;
      }
    }
    const meanOutcome = Math.max(-1, Math.min(1, netOutcome / slice.length));
    const engagementNorm = (meanOutcome + 1) * 0.5; // [0..1]
    const energyNorm = energyCount > 0 ? Math.max(0, Math.min(1, energySum / energyCount)) : engagementNorm;

    const x = 6 + (b / Math.max(1, bucketCount - 1)) * 188;
    const yCyan = 46 - engagementNorm * 38;
    const yAmber = 46 - energyNorm * 38;
    engagementPts.push(`${x.toFixed(1)},${yCyan.toFixed(1)}`);
    energyPts.push(`${x.toFixed(1)},${yAmber.toFixed(1)}`);
  }

  return {
    cyan: engagementPts.join(' '),
    amber: energyPts.join(' '),
    sampleCount: ordered.length,
  };
}

/**
 * Computes mean consecutive seam cosine across tracks (`endVector -> startVector`,
 * falling back to full `vector` cosine) so card seam badges reflect real acoustic glue.
 */
function computeMixSeam(tracks = [], gemmaVectors) {
  if (!gemmaVectors || tracks.length < 2) return null;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < Math.min(tracks.length - 1, 12); i++) {
    const cur = gemmaVectors.get(tracks[i].songKey);
    const nxt = gemmaVectors.get(tracks[i + 1].songKey);
    const cos = (cur?.endVector && nxt?.startVector)
      ? songCosine(cur.endVector, nxt.startVector)
      : (cur?.vector && nxt?.vector ? songCosine(cur.vector, nxt.vector) : null);
    if (cos != null) {
      sum += cos;
      count++;
    }
  }
  return count > 0 ? Math.max(0, Math.min(1, sum / count)) : null;
}

/**
 * Derives 26 bar heights [0.18..1.0] from actual track energies & vector norms in a focus mix.
 */
function buildCardWaveformBars(tracks = [], gemmaVectors) {
  const count = 26;
  return Array.from({ length: count }, (_, idx) => {
    if (!tracks.length) return 0.25;
    const song = tracks[idx % tracks.length];
    const energy = Number(song?.energy);
    const vec = gemmaVectors?.get?.(song?.songKey)?.vector;
    const vecVal = vec ? Math.abs(vec[idx % vec.length]) * 2.8 : 0.45;
    const raw = Number.isFinite(energy) ? energy * 0.72 + vecVal * 0.28 : 0.35 + vecVal * 0.55;
    return Math.max(0.16, Math.min(1, raw));
  });
}

function calibratedMatchPct(song, profileVector, clusterVector, gemmaVectors) {
  const entry = gemmaVectors?.get?.(song?.songKey);
  const vec = entry?.vector || song?.vector;
  if (!vec) return null;
  const target = clusterVector || profileVector;
  const cos = target ? songCosine(vec, target) : null;
  if (cos == null) return null;
  // Whitened 128D cosine matches typically sit in [-0.2..0.75]; calibrate cleanly onto [0..99]%
  return Math.max(1, Math.min(99, Math.round(((cos + 0.15) / 0.85) * 100)));
}

export function TasteDeckHud({
  songs = [],
  playbackEvents = [],
  gemmaVectors,
  likedSongKeys,
  queue = [],
  queueIndex = 0,
  currentSong,
  onPlaySong,
  onOpenTasteProfile,
}) {
  const telemetry = useMemo(() => {
    const songByKey = new Map();
    const playableSongs = [];
    songs.forEach(song => {
      const key = song.songKey || getSongKey(song);
      if (key) {
        songByKey.set(key, song);
        if (song.driveFileId && !song.isDuplicate && !song.isDeleted) playableSongs.push(song);
      }
    });

    const profile = buildContextualTasteProfile(songs, playbackEvents, {
      likedSongKeys,
      gemmaVectors,
      maxInterests: 4,
    });

    const interests = (profile.interests || []).map((interest, idx) => {
      const clusterSongs = (interest.songKeys || [])
        .map(key => songByKey.get(key))
        .filter(Boolean);
      const label = labelCluster(clusterSongs) || `Cluster ${idx + 1}`;
      return {
        id: `interest-${idx}`,
        label,
        pct: Math.round((interest.weight || 0) * 100),
        size: interest.size || clusterSongs.length,
        color: CLUSTER_PALETTE[idx % CLUSTER_PALETTE.length],
        weight: interest.weight || 0,
        vector: interest.vector,
      };
    });

    const rankByVector = (candidates, targetVec, maxCount = 12) => {
      if (!targetVec || !gemmaVectors?.size) return candidates.slice(0, maxCount);
      return [...candidates]
        .map(song => {
          const vec = gemmaVectors.get(song.songKey)?.vector;
          return { song, sim: vec ? (songCosine(vec, targetVec) ?? -2) : -2 };
        })
        .filter(item => item.sim > -1.5)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, maxCount)
        .map(item => item.song);
    };

    const focusMixes = [];
    interests.slice(0, 2).forEach((cluster, idx) => {
      const tracks = rankByVector(playableSongs, cluster.vector, 16);
      if (tracks.length >= 2) {
        focusMixes.push({
          id: `mix-cluster-${idx}`,
          title: `${cluster.label} · ${idx === 0 ? 'Focus' : 'Peak'}`,
          tracks,
          seam: computeMixSeam(tracks, gemmaVectors),
          tone: idx === 0 ? 'cyan' : 'amber',
          bars: buildCardWaveformBars(tracks, gemmaVectors),
        });
      }
    });

    // Mix 3: Low-energy / late-night acoustic seams if metadata has energy scores
    const chillTracks = [...playableSongs]
      .filter(s => Number.isFinite(Number(s.energy)) && Number(s.energy) <= 0.58)
      .sort((a, b) => Number(a.energy) - Number(b.energy))
      .slice(0, 16);
    if (chillTracks.length >= 2) {
      focusMixes.push({
        id: 'mix-chill',
        title: 'Late Night Acoustic Seams',
        tracks: chillTracks,
        seam: computeMixSeam(chillTracks, gemmaVectors),
        tone: 'cyan',
        bars: buildCardWaveformBars(chillTracks, gemmaVectors),
      });
    }

    // Mix 4: Unexplored vault picks matching active interests
    const unexploredCandidates = playableSongs.filter(s => !(s.playCount > 0));
    const unexploredMix = rankContextualSongs(unexploredCandidates, {
      profile,
      likedSongKeys,
      gemmaVectors,
      limit: 16,
    });
    if (unexploredMix.length >= 2) {
      focusMixes.push({
        id: 'mix-unexplored',
        title: 'Unexplored Vault Picks',
        tracks: unexploredMix,
        seam: computeMixSeam(unexploredMix, gemmaVectors),
        tone: 'cyan',
        bars: buildCardWaveformBars(unexploredMix, gemmaVectors),
      });
    }

    const focusRanked = songs.length
      ? rankContextualSongs(playableSongs.length ? playableSongs : songs, {
          profile,
          likedSongKeys,
          gemmaVectors,
          limit: 5,
        })
      : [];

    const upNext = selectUpcomingQueueItems({ queue, queueIndex, currentSong })
      .map(entry => entry.song)
      .slice(0, 5);

    return {
      interests,
      hasSignal: profile.hasSignal,
      sessionCount: profile.sessionCount || 0,
      profileVector: profile.vector || interests[0]?.vector || null,
      primaryClusterVec: interests[0]?.vector || profile.vector || null,
      focusMixes: focusMixes.slice(0, 4),
      focusRanked,
      upNext,
      trajectory: buildRealTrajectory(playbackEvents, songByKey),
    };
  }, [songs, playbackEvents, gemmaVectors, likedSongKeys, queue, queueIndex, currentSong]);

  return (
    <div className="taste-deck-wrapper">
      <section className="taste-deck-hud" aria-label="Live taste model telemetry">
        <div className="taste-deck-hud__main">
          <div className="taste-deck-hud__header">
            <span className="taste-deck-hud__eyebrow">
              <Activity size={13} aria-hidden="true" />
              LIVE TASTE MODEL ·{' '}
              {telemetry.interests.length > 0
                ? `${telemetry.interests.length} ACTIVE CLUSTER${telemetry.interests.length === 1 ? '' : 'S'}`
                : telemetry.hasSignal
                  ? `${telemetry.sessionCount} SESSION${telemetry.sessionCount === 1 ? '' : 'S'}`
                  : 'BASELINE SIGNAL'}
            </span>
            <button type="button" className="taste-deck-hud__action" onClick={onOpenTasteProfile}>
              <Sparkles size={12} aria-hidden="true" /> Inspect profile
            </button>
          </div>

          {telemetry.interests.length > 0 ? (
            <div className="taste-deck-hud__bars">
              {telemetry.interests.map(cluster => (
                <div key={cluster.id} className="taste-deck-bar">
                  <div className="taste-deck-bar__track">
                    <span
                      className="taste-deck-bar__fill"
                      style={{
                        width: `${Math.max(12, Math.min(100, cluster.pct))}%`,
                        background: cluster.color,
                        boxShadow: `0 0 14px ${cluster.color}66`,
                      }}
                    />
                  </div>
                  <div className="taste-deck-bar__meta">
                    <span className="taste-deck-bar__label" style={{ color: cluster.color }}>
                      {cluster.label}
                    </span>
                    <strong className="taste-deck-bar__pct">{cluster.pct}%</strong>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="taste-deck-hud__empty">
              Play or like tracks to separate your listening modes into live 128D clusters.
            </p>
          )}
        </div>

        <div
          className="taste-deck-sparkline"
          title={
            telemetry.trajectory
              ? `Real session engagement (cyan) & energy (amber) across ${telemetry.trajectory.sampleCount} logged events`
              : 'Waiting for logged playback events'
          }
        >
          {telemetry.trajectory ? (
            <svg viewBox="0 0 200 52" preserveAspectRatio="none" aria-hidden="true">
              <polyline fill="none" stroke="rgba(255, 184, 77, 0.72)" strokeWidth="1.6" points={telemetry.trajectory.amber} />
              <polyline fill="none" stroke="rgba(77, 226, 255, 0.92)" strokeWidth="2" points={telemetry.trajectory.cyan} />
            </svg>
          ) : (
            <div className="taste-deck-sparkline__idle">NO SESSION TELEMETRY</div>
          )}
        </div>
      </section>

      {telemetry.focusMixes.length > 0 && (
        <section className="focus-mix-deck" aria-label="For your current focus">
          <div className="focus-mix-deck__head">
            <span className="focus-mix-deck__eyebrow">FOR YOUR CURRENT FOCUS</span>
            <span className="focus-mix-deck__sub">Acoustic cluster &amp; seam continuity mixes</span>
          </div>
          <div className="focus-mix-deck__grid">
            {telemetry.focusMixes.map(mix => (
              <button
                key={mix.id}
                type="button"
                className="focus-mix-card"
                onClick={() => onPlaySong?.(mix.tracks[0], mix.tracks)}
              >
                <div className="focus-mix-card__title">{mix.title}</div>
                <div className="focus-mix-card__wave" aria-hidden="true">
                  {mix.bars.map((amp, idx) => (
                    <span
                      key={idx}
                      style={{ height: `${Math.round(amp * 100)}%` }}
                    />
                  ))}
                </div>
                <div className="focus-mix-card__badges">
                  <span className={`focus-mix-badge focus-mix-badge--${mix.tone}`}>
                    {mix.seam != null ? `SEAM ${mix.seam.toFixed(2)}` : `${mix.tracks.length} TRACKS`}
                  </span>
                  <span className="focus-mix-badge focus-mix-badge--muted">
                    {gemmaVectors?.size ? '128D' : 'META'}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {(telemetry.focusRanked.length > 0 || telemetry.upNext.length > 0) && (
        <section className="home-precision-split" aria-label="Precision recommendations and queue path">
          {telemetry.focusRanked.length > 0 && (
            <div className="precision-table">
              <div className="precision-table__head">
                <span>Precision Tracklist · Focus Fit</span>
                <span>BPM · MATCH</span>
              </div>
              {telemetry.focusRanked.slice(0, 4).map((song, idx) => {
                const bpm = song.bpm ? `${Math.round(song.bpm)}` : '—';
                const matchPct = calibratedMatchPct(song, telemetry.profileVector, telemetry.primaryClusterVec, gemmaVectors);
                return (
                  <button
                    key={song.songKey}
                    type="button"
                    className="precision-row"
                    onClick={() => onPlaySong?.(song, telemetry.focusRanked)}
                  >
                    <span className="precision-row__idx">{idx + 1}</span>
                    <span className="precision-row__name">
                      <strong>{song.track}</strong>
                      <small>{song.artist}</small>
                    </span>
                    <span className="precision-row__metrics">
                      <span className="precision-bpm">{bpm}</span>
                      <span className="precision-match">{matchPct != null ? `${matchPct}%` : '—'}</span>
                      <Play size={12} className="precision-row__play" aria-hidden="true" />
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {telemetry.upNext.length > 0 && (
            <div className="precision-table">
              <div className="precision-table__head">
                <span>Active Queue Continuum</span>
                <span>BPM · FIT</span>
              </div>
              {telemetry.upNext.slice(0, 4).map((song, idx) => {
                const matchPct = calibratedMatchPct(song, telemetry.profileVector, telemetry.primaryClusterVec, gemmaVectors);
                return (
                  <button
                    key={`${song.songKey}-${idx}`}
                    type="button"
                    className="precision-row"
                    onClick={() => onPlaySong?.(song, telemetry.upNext)}
                  >
                    <span className="precision-row__idx">{idx + 1}</span>
                    <span className="precision-row__name">
                      <strong>{song.track}</strong>
                      <small>{song.artist}</small>
                    </span>
                    <span className="precision-row__metrics">
                      <span className="precision-bpm">{song.bpm ? Math.round(song.bpm) : '—'}</span>
                      <span className="precision-match precision-match--amber">
                        {matchPct != null ? `${matchPct}%` : 'QUEUED'}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
