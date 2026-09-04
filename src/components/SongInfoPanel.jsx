import { useState } from 'react';
import { Play, SkipForward, Download, ListMusic, Plus, Trash2, RefreshCw, X, Copy, FolderOpen } from 'lucide-react';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { statusDetails } from './componentUtils.jsx';
import { AsyncArtworkImage } from './AsyncArtworkImage.jsx';

export function SongInfoPanel({ song, onClose, onPlay, onPlayNext, onAddToQueue, onAddToPlaylist, onReview, onDelete, onMarkDuplicate, onRestoreDuplicate, onSave, onPrepare, isDownloading = false }) {
  const dialogRef = useDialogFocus(true, onClose);
  const status = statusDetails(song);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() => ({
      artist: song.artist || '',
      track: song.track || '',
      album: song.album || '',
      genre: song.genre || '',
      releaseDate: song.releaseDate || '',
      description: song.description || '',
      lyrics: song.lyrics || '',
    }));

  const setField = (field, value) => setForm(previous => ({ ...previous, [field]: value }));
  const save = async () => {
    setSaving(true);
    try {
      await onSave?.(song, form);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="song-info-panel" role="dialog" aria-modal="true" aria-labelledby="song-info-title" tabIndex={-1}>
        <div className="panel-header">
          <div>
            <span className="song-info-panel__eyebrow">Song information</span>
            <h2 id="song-info-title">{song.track}</h2>
            <p>{song.artist}{song.album ? ` · ${song.album}` : ''}</p>
          </div>
          <div className="song-info-panel__header-actions">
            {onSave && <button className="panel-action-btn" onClick={() => setEditing(value => !value)}>{editing ? 'Cancel edit' : 'Edit details'}</button>}
            <button data-dialog-autofocus className="icon-btn" onClick={onClose} aria-label="Close song info"><X size={20} /></button>
          </div>
        </div>

        <div className="song-info-panel__hero">
          <AsyncArtworkImage
            song={song}
            className="song-info-panel__art"
            alt={`${song.track} cover`}
            fallbackSize={26}
            size={160}
            priority
          />
          <div>
            <strong>{status.label}</strong>
            <span>{song.filename || song.driveFileId || 'No Drive file linked yet'}</span>
            <span>{song.album || 'Album not available'}</span>
          </div>
        </div>

        <div className="song-info-panel__actions">
          <button className="panel-action-btn panel-action-btn--primary" onClick={() => onPlay?.(song)}><Play size={16} /> Play</button>
          <button className="panel-action-btn" onClick={() => onPlayNext?.(song)}><SkipForward size={16} /> Play next</button>
          <button className="panel-action-btn" onClick={() => onAddToQueue?.(song)}><ListMusic size={16} /> Queue</button>
          <button className="panel-action-btn" onClick={() => onAddToPlaylist?.(song)}><Plus size={16} /> Playlist</button>
          <button className="panel-action-btn" onClick={() => onPrepare?.(song)} disabled={isDownloading}><Download size={16} /> Prepare on Drive</button>
          <button className="panel-action-btn" onClick={() => onReview?.(song)}><RefreshCw size={16} /> Suggest source</button>
          {onMarkDuplicate && <button className="panel-action-btn panel-action-btn--danger" onClick={() => onMarkDuplicate(song)}><Copy size={16} /> Mark duplicate</button>}
          {onRestoreDuplicate && <button className="panel-action-btn" onClick={() => onRestoreDuplicate(song)}><FolderOpen size={16} /> Restore to Ready</button>}
          {onDelete && <button className="panel-action-btn panel-action-btn--danger" onClick={() => onDelete(song)}><Trash2 size={16} /> Delete</button>}
        </div>

        {editing ? (
          <div className="song-info-panel__edit-form">
            <div className="song-info-panel__edit-grid">
              <label>Artist<input value={form.artist} onChange={event => setField('artist', event.target.value)} /></label>
              <label>Title<input value={form.track} onChange={event => setField('track', event.target.value)} /></label>
              <label>Album<input value={form.album} onChange={event => setField('album', event.target.value)} /></label>
              <label>Genre<input value={form.genre} onChange={event => setField('genre', event.target.value)} /></label>
              <label>Release date<input value={form.releaseDate} onChange={event => setField('releaseDate', event.target.value)} placeholder="YYYY-MM-DD" /></label>
            </div>
            <label>Description<textarea rows="3" value={form.description} onChange={event => setField('description', event.target.value)} /></label>
            <label>Lyrics<textarea rows="7" value={form.lyrics} onChange={event => setField('lyrics', event.target.value)} /></label>
            <button className="btn-primary song-info-panel__save" onClick={save} disabled={saving || !form.artist?.trim() || !form.track?.trim()}>
              {saving ? 'Saving…' : 'Save details to Drive'}
            </button>
          </div>
        ) : (
          <div className="song-info-panel__sections">
            <section><h3>Description</h3><p>{song.description || 'No description is available yet.'}</p></section>
            <section><h3>Lyrics</h3><p>{song.lyrics || 'Lyrics are not available yet. They can be added by the metadata pipeline later.'}</p></section>
          </div>
        )}

        <dl className="song-info-panel__metadata">
          <div><dt>Artist</dt><dd>{song.artist || 'Unknown artist'}</dd></div>
          <div><dt>Created / added</dt><dd>{song.dateCreated || (song.dateAdded ? new Date(song.dateAdded).toLocaleString() : 'Unknown')}</dd></div>
          <div><dt>Last played</dt><dd>{song.lastPlayedAt ? new Date(song.lastPlayedAt).toLocaleString() : 'Not played yet'}</dd></div>
          <div><dt>Play count</dt><dd>{song.playCount || 0}</dd></div>
        </dl>
      </section>
    </div>
  );
}
