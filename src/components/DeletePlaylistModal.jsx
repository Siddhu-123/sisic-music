import { useRef } from 'react';
import { Trash2, AlertTriangle, X } from 'lucide-react';
import { useDialogFocus } from '../hooks/useDialogFocus.js';

export function DeletePlaylistModal({
  isOpen,
  playlist,
  onClose,
  onConfirm,
  isDeleting = false,
  error = '',
}) {
  const cancelBtnRef = useRef(null);
  const dialogRef = useDialogFocus(Boolean(isOpen && playlist), onClose, { canClose: !isDeleting });

  if (!isOpen || !playlist) return null;

  return (
    <div
      className="modal-overlay delete-playlist-overlay"
      onClick={() => { if (!isDeleting) onClose(); }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className="modal-content delete-playlist-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-playlist-title"
        aria-describedby="delete-playlist-desc"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-title-row">
            <Trash2 className="modal-icon delete-playlist-icon" size={20} />
            <div>
              <h2 id="delete-playlist-title" className="modal-title">Delete Playlist</h2>
              <p className="modal-subtitle">Permanent removal from playlists</p>
            </div>
          </div>
          <button
            type="button"
            className="neumorphic-button neumorphic-button--icon"
            onClick={onClose}
            disabled={isDeleting}
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        <div className="delete-playlist-body">
          <p id="delete-playlist-desc" className="delete-playlist-desc">
            Are you sure you want to delete <strong>&ldquo;{playlist.name}&rdquo;</strong>?
          </p>
          <p className="delete-playlist-subtext">
            Songs in this playlist will remain in your library.
          </p>
          {error && (
            <div className="delete-playlist-error" role="alert">
              <AlertTriangle size={16} />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button
            ref={cancelBtnRef}
            type="button"
            className="neumorphic-button delete-playlist-cancel-btn"
            data-dialog-autofocus
            onClick={onClose}
            disabled={isDeleting}
            autoFocus
          >
            Cancel
          </button>
          <button
            type="button"
            className="neumorphic-button delete-playlist-confirm-btn"
            onClick={() => onConfirm(playlist)}
            disabled={isDeleting}
          >
            {isDeleting ? 'Deleting…' : 'Delete Playlist'}
          </button>
        </div>
      </div>
    </div>
  );
}
