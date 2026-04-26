// Google Drive Service for SpotiClone Web
// Uses Google Identity Services (GIS) for OAuth, then Google Drive REST API

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',   // needed to write queue.json
].join(' ');

class GoogleDriveService {
  constructor() {
    this.tokenClient = null;
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  /** Call once after window.google is loaded */
  initTokenClient(clientId) {
    if (!window.google?.accounts?.oauth2) {
      console.error('Google Identity Services not loaded yet');
      return;
    }
    this.tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: (resp) => {
        if (resp.error) return;
        this.accessToken = resp.access_token;
        this.tokenExpiry = Date.now() + (resp.expires_in * 1000);
      },
    });
  }

  /** Opens Google sign-in popup */
  requestToken() {
    return new Promise((resolve, reject) => {
      if (!this.tokenClient) {
        reject(new Error('Token client not initialized'));
        return;
      }
      this.tokenClient.callback = (resp) => {
        if (resp.error) {
          reject(new Error(resp.error));
          return;
        }
        this.accessToken = resp.access_token;
        this.tokenExpiry = Date.now() + (resp.expires_in * 1000);
        resolve(resp.access_token);
      };
      this.tokenClient.requestAccessToken({ prompt: '' });
    });
  }

  get isAuthenticated() {
    return !!this.accessToken && Date.now() < (this.tokenExpiry || 0);
  }

  /** Generic Drive API GET */
  async driveGet(url, label = 'Drive request') {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!resp.ok) {
      let details = '';
      try {
        const body = await resp.json();
        details = body.error?.message ? ` ${body.error.message}` : '';
      } catch {
        details = resp.statusText ? ` ${resp.statusText}` : '';
      }
      throw new Error(`${label} failed: Drive API ${resp.status}.${details}`);
    }
    return resp;
  }

  /** Fetch spotify_data.json from Drive by file ID */
  async fetchSpotifyLibrary(fileId) {
    const resp = await this.driveGet(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      'Spotify library file'
    );
    return await resp.json();
  }

  /**
   * List files in a Drive folder that match a song name.
   * Used to check if a song is already downloaded to Drive by the Mac worker.
   */
  async findSongFile(songTitle, folderId) {
    const safe = songTitle.replace(/'/g, "\\'").substring(0, 40);
    const q = `name contains '${safe}' and '${folderId}' in parents and trashed=false`;
    const resp = await this.driveGet(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`,
      'Drive song search'
    );
    const data = await resp.json();
    return data.files?.[0] || null;
  }

  /** Download an MP3 file as a Blob for local caching */
  async downloadFileAsBlob(fileId) {
    const resp = await this.driveGet(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      'Drive audio download'
    );
    return await resp.blob();
  }

  // ─── Queue Signaling ──────────────────────────────────────────────────────

  /** Read the current queue.json from Drive. Returns [] if not found. */
  async readQueue(folderId) {
    const q = `name='queue.json' and '${folderId}' in parents and trashed=false`;
    const listResp = await this.driveGet(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
      'Drive queue lookup'
    );
    const listData = await listResp.json();
    const file = listData.files?.[0];
    if (!file) return { queueFileId: null, queue: [] };

    const contentResp = await this.driveGet(
      `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
      'Drive queue file'
    );
    const queue = await contentResp.json();
    return { queueFileId: file.id, queue: Array.isArray(queue) ? queue : [] };
  }

  /** Write an updated queue array back to queue.json on Drive */
  async writeQueue(queueFileId, folderId, queueArray) {
    const content = JSON.stringify(queueArray);
    const blob = new Blob([content], { type: 'application/json' });

    if (queueFileId) {
      // Update existing file
      await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${queueFileId}?uploadType=media`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: blob,
        }
      );
    } else {
      // Create new queue.json
      const metadata = { name: 'queue.json', parents: [folderId] };
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file', blob);
      await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.accessToken}` },
          body: form,
        }
      );
    }
  }

  /** Add a song to the Mac worker's download queue */
  async requestSongDownload(song, folderId) {
    const { queueFileId, queue } = await this.readQueue(folderId);
    const alreadyQueued = queue.some(
      e => e.track === song.track && e.artist === song.artist
    );
    if (!alreadyQueued) {
      queue.push({ track: song.track, artist: song.artist, album: song.album });
      await this.writeQueue(queueFileId, folderId, queue);
    }
  }
}

export const driveService = new GoogleDriveService();
