import React, { useMemo } from 'react';
import { Sparkles, Play, Plus, X, ListPlus } from 'lucide-react';
import { findSimilarSongs } from '../services/tasteEmbeddingService.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';

export function RecommendationsModal({ isOpen, onClose, targetSong, librarySongs = [], onPlaySong, onAddToQueue }) {
  const dialogRef = useDialogFocus(Boolean(isOpen && targetSong), onClose);
  const recommendations = useMemo(() => {
    if (!targetSong) return [];
    return findSimilarSongs(targetSong, librarySongs, { limit: 12 });
  }, [targetSong, librarySongs]);

  if (!isOpen || !targetSong) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal-content recommendations-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recommendations-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-title-row">
            <Sparkles className="modal-icon" size={20} />
            <div>
              <h2 id="recommendations-title" className="modal-title">More Like This</h2>
              <p className="modal-subtitle">
                Songs similar to &ldquo;{targetSong.track}&rdquo; by {targetSong.artist}
              </p>
            </div>
          </div>
          <button type="button" className="neumorphic-button neumorphic-button--icon" onClick={onClose} aria-label="Close recommendations">
            <X size={18} />
          </button>
        </div>

        <div className="recommendations-list">
          {recommendations.length === 0 ? (
            <div className="empty-state">No recommendations found in your library yet.</div>
          ) : (
            recommendations.map((song) => {
              const matchPct = Math.round(((song.similarityScore + 1) / 2) * 100);
              return (
                <div key={song.songKey} className="recommendation-card">
                  <div className="recommendation-info">
                    <div className="recommendation-track">{song.track}</div>
                    <div className="recommendation-artist">{song.artist}</div>
                  </div>
                  <div className="recommendation-meta">
                    <span className="similarity-badge">{matchPct}% match</span>
                    <div className="recommendation-actions">
                      <button
                        type="button"
                        className="neumorphic-button neumorphic-button--icon"
                        onClick={() => { onAddToQueue(song); }}
                        aria-label={`Add ${song.track} to queue`}
                        title="Add to queue"
                      >
                        <Plus size={16} />
                      </button>
                      <button
                        type="button"
                        className="neumorphic-button neumorphic-button--icon neumorphic-button--primary"
                        onClick={() => { onPlaySong(song); onClose(); }}
                        aria-label={`Play ${song.track}`}
                        title="Play song"
                      >
                        <Play size={16} fill="currentColor" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="neumorphic-button"
            onClick={() => {
              recommendations.forEach(s => onAddToQueue(s));
              onClose();
            }}
          >
            <ListPlus size={16} style={{ marginRight: '6px' }} />
            Add All to Queue
          </button>
          <button type="button" className="neumorphic-button neumorphic-button--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
