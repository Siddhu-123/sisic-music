import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, Play, Plus, X, ListPlus } from 'lucide-react';
import { findSimilarSongs } from '../services/tasteEmbeddingService.js';
import { getSongKey } from '../songIdentity.js';
import { getSongVectors } from '../db.js';
import { GEMMA2_MODEL, gemmaNeighbors } from '../services/gemmaVectors.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';

export function RecommendationsModal({ isOpen, onClose, targetSong, librarySongs = [], onPlaySong, onAddToQueue, onRecommendationShown }) {
  const dialogRef = useDialogFocus(Boolean(isOpen && targetSong), onClose);
  const seedKey = targetSong ? (targetSong.songKey || getSongKey(targetSong)) : '';
  // Lookup result is tagged with its seed so a quick A -> B switch never shows or logs A's list for B.
  const [gemmaLookup, setGemmaLookup] = useState({ seedKey: '', recommendations: null });
  useEffect(() => {
    let cancelled = false;
    if (!seedKey) return () => { cancelled = true; };
    const songsByKey = new Map(librarySongs.map(song => [song.songKey || getSongKey(song), song]));
    getSongVectors(GEMMA2_MODEL).then(rows => {
      if (cancelled) return;
      if (!rows.some(row => row.songKey === seedKey)) { setGemmaLookup({ seedKey, recommendations: null }); return; }
      // Filter to library songs before taking the top 12 so the list is not short.
      const libraryRows = rows.filter(row => row.songKey === seedKey || songsByKey.has(row.songKey));
      const recommendations = gemmaNeighbors(seedKey, libraryRows, 12)
        .map(row => ({ ...songsByKey.get(row.songKey), similarityScore: row.similarityScore }));
      setGemmaLookup({ seedKey, recommendations });
    }).catch(() => { if (!cancelled) setGemmaLookup({ seedKey, recommendations: null }); });
    return () => { cancelled = true; };
  }, [seedKey, librarySongs]);
  const fallbackRecommendations = useMemo(() => {
    if (!targetSong) return [];
    return findSimilarSongs(targetSong, librarySongs, { limit: 12 });
  }, [targetSong, librarySongs]);
  const lookupSettled = gemmaLookup.seedKey === seedKey;
  const recommendations = (lookupSettled && gemmaLookup.recommendations) || fallbackRecommendations;
  const impressionKeys = recommendations.slice(0, 50).map(song => song.songKey || getSongKey(song)).join(',');
  const lastImpressionRef = useRef('');
  useEffect(() => {
    if (!isOpen || !seedKey || !lookupSettled) { if (!isOpen) lastImpressionRef.current = ''; return; }
    const signature = `${seedKey}|${impressionKeys}`;
    if (signature === lastImpressionRef.current) return;
    lastImpressionRef.current = signature;
    onRecommendationShown?.('recommendations-modal', impressionKeys ? impressionKeys.split(',') : [], seedKey);
  }, [isOpen, seedKey, lookupSettled, impressionKeys]); // eslint-disable-line react-hooks/exhaustive-deps

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
              // Cosine similarity mapped directly; (s + 1) / 2 showed unrelated songs as a 50%+ match.
              const matchPct = Math.round(Math.max(0, Math.min(1, song.similarityScore)) * 100);
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
