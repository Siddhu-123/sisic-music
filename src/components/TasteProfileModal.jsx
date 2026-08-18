import React from 'react';
import { Compass, Download, Upload, X, Music, Radio, Disc } from 'lucide-react';
import { computeTasteCentroid } from '../services/tasteEmbeddingService.js';

export function TasteProfileModal({ isOpen, onClose, librarySummary, songs = [] }) {
  if (!isOpen) return null;

  const metrics = librarySummary?.metrics || {};
  const topArtists = metrics.topArtistsByStarts?.slice(0, 8) || [];
  const tasteSignals = (librarySummary?.playbackEvents || [])
    .filter(event => ['playback-start', 'playback-resume'].includes(event.eventType));
  const tasteVector = computeTasteCentroid(songs, tasteSignals);
  const tasteSignalCount = tasteSignals.filter(event => event.songKey).length;

  const handleExportProfile = () => {
    const profile = {
      schemaVersion: 1,
      appName: 'Sisic Music',
      exportedAt: new Date().toISOString(),
      tasteVector: tasteVector || [],
      libraryMetrics: {
        totalSongs: metrics.totalSongs || songs.length,
        totalArtists: metrics.totalArtists || 0,
        estimatedListeningMinutes: metrics.estimatedListeningMinutes || 0,
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
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Taste Profile">
      <div className="modal-content taste-profile-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title-row">
            <Compass className="modal-icon" size={20} />
            <div>
              <h2 className="modal-title">Personal Taste Profile</h2>
              <p className="modal-subtitle">Client-side derived music taste vector & listening insights</p>
            </div>
          </div>
          <button className="neumorphic-button neumorphic-button--icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="taste-metrics-grid">
          <div className="taste-metric-card">
            <Music className="metric-card-icon" size={18} />
            <div className="metric-card-val">{metrics.totalSongs || songs.length}</div>
            <div className="metric-card-label">Library Songs</div>
          </div>
          <div className="taste-metric-card">
            <Radio className="metric-card-icon" size={18} />
            <div className="metric-card-val">{metrics.estimatedListeningMinutes || 0}m</div>
            <div className="metric-card-label">Listening Time</div>
          </div>
          <div className="taste-metric-card">
            <Disc className="metric-card-icon" size={18} />
            <div className="metric-card-val">{topArtists.length}</div>
            <div className="metric-card-label">Core Artists</div>
          </div>
        </div>

        <div className="top-artists-section">
          <h3 className="section-heading">Top Artist Affinities</h3>
          <div className="artist-chips-container">
            {topArtists.length === 0 ? (
              <span className="empty-subtext">Play more songs to build your affinity graph.</span>
            ) : (
              topArtists.map((item, idx) => (
                <div key={item.artist} className="artist-affinity-chip">
                  <span className="chip-rank">#{idx + 1}</span>
                  <span className="chip-name">{item.artist}</span>
                  <span className="chip-count">{item.plays} plays</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="taste-profile-status" role="status">
          <span className="taste-profile-status__dot" />
          <span>{tasteVector?.length ? `Profile ready · ${tasteVector.length}-dimension vector` : 'Profile waiting for library data'}</span>
          <small>{tasteSignalCount.toLocaleString()} listening signal{tasteSignalCount === 1 ? '' : 's'}</small>
        </div>

        <div className="taste-export-section">
          <p className="export-description">
            Your taste profile is computed 100% on-device and private to your browser. You can export it as a portable JSON file to carry between devices.
          </p>
          <button
            type="button"
            className="neumorphic-button neumorphic-button--primary"
            onClick={handleExportProfile}
          >
            <Download size={16} style={{ marginRight: '6px' }} />
            Export Taste Vector JSON
          </button>
        </div>

        <div className="modal-footer">
          <button type="button" className="neumorphic-button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
