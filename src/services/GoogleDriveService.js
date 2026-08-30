import {
  asSongRecord,
  canonicalAudioFilename,
  compareSongSimilarity,
  findSimilarSongMatch,
  getSongKey,
  jobFilePrefix,
} from '../songIdentity.js';
import { cleanImportedFilename } from '../importIdentity.js';
import { tokenExpiryFromResponse } from './driveAuth.js';

// drive.file limits writes to files created/opened by Sisic. The read-only
// scope remains necessary because a configured Spotify export may predate the
// app and therefore may not be visible through drive.file alone.
export const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
].join(' ');

const TOKEN_STORAGE_KEY = 'sisic_access_token';
const EXPIRY_STORAGE_KEY = 'sisic_token_expiry';
const TOKEN_SCOPE_STORAGE_KEY = 'sisic_token_scope';
const TOKEN_VERSION_STORAGE_KEY = 'sisic_token_version';
const AUTH_HISTORY_STORAGE_KEY = 'sisic_drive_authorized';
const JOB_MIME_TYPE = 'application/json';
const SONG_INDEX_FILENAME = 'sisic-songs.json';
const QUEUE_INDEX_FILENAME = 'sisic-queue.json';
export const SOURCE_FEEDBACK_FILENAME = 'sisic-source-feedback.json';
const CANONICAL_QUEUE_STORAGE_MODE = 'canonical';
const DELETED_INDEX_FILENAME = 'sisic-deleted.json';
const DUPLICATE_INDEX_FILENAME = 'sisic-duplicates.json';
const PLAYLIST_INDEX_FILENAME = 'sisic-playlists.json';
const PLAYBACK_LOG_FILENAME = 'sisic-playback-log.json';
const CLIENT_INSTANCE_STORAGE_KEY = 'sisic_client_instance_id';
const MAX_PLAYBACK_LOGS = 200;
const JOB_FILE_FIELDS = 'files(id,name,modifiedTime,appProperties)';
const AUDIO_FILE_FIELDS = 'files(id,name,mimeType,size,modifiedTime,appProperties)';
const FILE_METADATA_FIELDS = 'id,name,mimeType,size,appProperties';

function safeSessionGet(key) {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeSessionSet(key, value) {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(key, value);
  } catch (error) {
    console.warn(`Session storage set error for key ${key}:`, error);
  }
}

function safeSessionRemove(key) {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(key);
  // eslint-disable-next-line no-empty
  } catch {}
}

function safeStorageGet(key) {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch (error) {
    console.warn(`Storage set error for key ${key}:`, error);
  }
}

function safeStorageRemove(key) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  // eslint-disable-next-line no-empty
  } catch {}
}

function getClientInstanceId() {
  const existing = safeStorageGet(CLIENT_INSTANCE_STORAGE_KEY);
  if (existing) return existing;
  const next = typeof crypto !== 'undefined' && crypto.randomUUID ? `web-${crypto.randomUUID()}` : `web-${Date.now()}`;
  safeStorageSet(CLIENT_INSTANCE_STORAGE_KEY, next);
  return next;
}

const CLIENT_INSTANCE_ID = getClientInstanceId();

export function escapeDriveQuery(value = '') {
  return String(value || '')
    .split('')
    .filter(ch => {
      const code = ch.charCodeAt(0);
      return (code >= 32 && code !== 127 && !(code >= 128 && code <= 159));
    })
    .join('')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function normalizeJob(raw, file = {}) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    ...raw,
    jobFileId: file.id || raw.jobFileId || '',
    jobFileName: file.name || raw.jobFileName || '',
    updatedAt: raw.updatedAt || file.modifiedTime || raw.createdAt || new Date().toISOString(),
  };
}

function candidateSourceUrl(candidate = {}) {
  const value = candidate.url || candidate.webpage_url || candidate.original_url || '';
  if (value) {
    const text = String(value).trim();
    if (/^https?:\/\//i.test(text)) return text;
    return `https://www.youtube.com/watch?v=${encodeURIComponent(text)}`;
  }
  const videoId = String(candidate.videoId || candidate.id || '').trim();
  return videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` : '';
}

function candidateIdentity(candidate = {}) {
  return String(candidate.candidateId || candidate.videoId || candidate.id || candidate.url || candidate.webpage_url || '').trim();
}

export function isAudioFileMetadata(file = {}) {
  const name = String(file.name || '').toLowerCase();
  const mimeType = String(file.mimeType || '').toLowerCase();
  const appProperties = file.appProperties || {};

  if (appProperties.sisicJob === 'true') return false;
  if (appProperties.sisicImportSource === 'true') return false;
  if (name.startsWith('sisic-job-') || name.endsWith('.json')) return false;
  if (mimeType === JOB_MIME_TYPE || mimeType.includes('json')) return false;

  return mimeType.startsWith('audio/') || name.endsWith('.mp3');
}

function firstAudioFile(files = []) {
  return files.find(isAudioFileMetadata) || null;
}

function inferSongPartsFromFilename(name = '') {
  const withoutExt = cleanImportedFilename(name);
  const [artist = '', ...trackParts] = withoutExt.split(' - ');
  return {
    artist: artist.trim() || 'Unknown Artist',
    track: trackParts.join(' - ').trim() || withoutExt.trim() || 'Unknown Track',
  };
}

function isUnknownLabel(value = '', unknownValue = 'Unknown') {
  const normalized = String(value || '').trim().toLowerCase();
  return !normalized || normalized === unknownValue.toLowerCase();
}

function isStagedImportLabel(value = '') {
  return /^sisic-import-source-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i.test(String(value || '').trim());
}

function meaningfulValue(value, unknownValue) {
  return isUnknownLabel(value, unknownValue) || isStagedImportLabel(value) ? '' : String(value || '').trim();
}

function isUnknownSongKey(songKey = '') {
  return String(songKey || '').trim().toLowerCase() === 'unknown artist::unknown track';
}

function normalizeSongIndexEntry(file = {}, item = null) {
  const appProperties = file.appProperties || {};
  const filename = file.name || file.filename || '';
  const inferred = inferSongPartsFromFilename(filename);
  const normalizedItem = item ? asSongRecord(item) : null;
  const artist = (normalizedItem?.artist && !isStagedImportLabel(normalizedItem.artist) ? normalizedItem.artist : '')
    || meaningfulValue(appProperties.sisicArtist, 'Unknown Artist')
    || meaningfulValue(file.artist, 'Unknown Artist')
    || inferred.artist;
  const track = (normalizedItem?.track && !isStagedImportLabel(normalizedItem.track) ? normalizedItem.track : '')
    || meaningfulValue(appProperties.sisicTrack, 'Unknown Track')
    || meaningfulValue(file.track, 'Unknown Track')
    || inferred.track;
  const existingSongKey = appProperties.sisicSongKey || file.songKey || '';
  const songKey = normalizedItem?.songKey
    || (isUnknownSongKey(existingSongKey) ? '' : existingSongKey)
    || getSongKey({ artist, track });
  return {
    songKey,
    artist,
    track,
    album: normalizedItem?.album || appProperties.sisicAlbum || file.album || '',
    description: normalizedItem?.description || appProperties.sisicDescription || file.description || '',
    lyrics: normalizedItem?.lyrics || file.lyrics || '',
    genre: normalizedItem?.genre || file.genre || '',
    releaseDate: normalizedItem?.releaseDate || file.releaseDate || '',
    coverArtUrl: normalizedItem?.coverArtUrl || file.coverArtUrl || '',
    filename: isStagedImportLabel(filename) ? canonicalAudioFilename({ artist, track }) : (filename || canonicalAudioFilename({ artist, track })),
    driveFileId: file.id || file.driveFileId || '',
    mimeType: file.mimeType || 'audio/mpeg',
    size: Number(file.size || 0),
    modifiedTime: file.modifiedTime || '',
    sourceUrl: normalizedItem?.sourceUrl || appProperties.sisicSourceUrl || file.sourceUrl || '',
    sourceTitle: normalizedItem?.sourceTitle || appProperties.sisicSourceTitle || file.sourceTitle || '',
    sourceUploader: normalizedItem?.sourceUploader || appProperties.sisicSourceUploader || file.sourceUploader || '',
    sourceVideoId: normalizedItem?.sourceVideoId || appProperties.sisicSourceVideoId || file.sourceVideoId || '',
    sourceDuration: normalizedItem?.sourceDuration || appProperties.sisicSourceDuration || file.sourceDuration || '',
    sourceSelectionMode: normalizedItem?.sourceSelectionMode || appProperties.sisicSourceSelectionMode || file.sourceSelectionMode || '',
    qualityStatus: normalizedItem?.qualityStatus || appProperties.sisicQualityStatus || file.qualityStatus || '',
    qualityReviewedAt: normalizedItem?.qualityReviewedAt || appProperties.sisicQualityReviewedAt || file.qualityReviewedAt || '',
    updatedAt: new Date().toISOString(),
  };
}

function normalizeQueueIndexJob(job = {}) {
  return normalizeJob(job) || null;
}

function indexBody(type, values, previous = {}) {
  const body = {
    schemaVersion: 1,
    revision: (Number(previous.revision) || 0) + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: CLIENT_INSTANCE_ID,
    [type]: values,
  };
  if (previous.storageMode) body.storageMode = previous.storageMode;
  return body;
}

function normalizePlaylistIndexEntry(playlist = {}) {
  const songKeys = Array.isArray(playlist.songKeys) ? playlist.songKeys.filter(Boolean) : [];
  return {
    playlistKey: playlist.playlistKey || '',
    name: playlist.name || 'Untitled Playlist',
    source: playlist.source || 'sisic',
    songKeys: [...new Set(songKeys)],
    updatedAt: playlist.updatedAt || new Date().toISOString(),
  };
}

function normalizeDeletedEntry(songInput = {}, extra = {}) {
  const song = asSongRecord(songInput);
  return {
    songKey: song.songKey,
    artist: song.artist,
    track: song.track,
    album: song.album || '',
    deletedAt: extra.deletedAt || new Date().toISOString(),
    reason: extra.reason || 'ready-offload',
    previousDriveFileId: extra.previousDriveFileId || song.driveFileId || '',
  };
}

function normalizeDuplicateEntry(songInput = {}, extra = {}) {
  const song = asSongRecord(songInput);
  return {
    songKey: song.songKey,
    artist: song.artist,
    track: song.track,
    album: song.album || '',
    driveFileId: extra.driveFileId || song.driveFileId || '',
    duplicateAt: extra.duplicateAt || new Date().toISOString(),
    duplicateOfSongKey: extra.duplicateOfSongKey || '',
    reason: extra.reason || 'user-marked-duplicate',
  };
}

export class GoogleDriveService {
  constructor() {
    this.tokenClient = null;
    // Clean up any legacy localStorage tokens from older builds.
    safeStorageRemove(TOKEN_STORAGE_KEY);
    safeStorageRemove(EXPIRY_STORAGE_KEY);
    safeStorageRemove(TOKEN_SCOPE_STORAGE_KEY);
    safeStorageRemove(TOKEN_VERSION_STORAGE_KEY);

    // Active session tokens are stored in sessionStorage so page refreshes
    // seamlessly preserve the authenticated session without asking the user
    // to sign in on every reload.
    const storedToken = safeSessionGet(TOKEN_STORAGE_KEY);
    const storedExpiry = Number(safeSessionGet(EXPIRY_STORAGE_KEY)) || 0;
    if (storedToken && Date.now() < storedExpiry) {
      this.accessToken = storedToken;
      this.tokenExpiry = storedExpiry;
      this.tokenVersion = safeSessionGet(TOKEN_VERSION_STORAGE_KEY) || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
      this.hasAuthorizedSession = true;
      this.authRequired = false;
      // Repair the non-secret marker if it was lost while the tab still had
      // a valid session token.
      safeStorageSet(AUTH_HISTORY_STORAGE_KEY, 'true');
    } else {
      this.accessToken = null;
      this.tokenExpiry = null;
      this.tokenVersion = '';
      // An expired session token still proves that this tab was previously
      // authorized. Keep the shell mounted so GIS can renew it silently.
      this.hasAuthorizedSession = safeStorageGet(AUTH_HISTORY_STORAGE_KEY) === 'true' || Boolean(storedToken);
      safeSessionRemove(TOKEN_STORAGE_KEY);
      safeSessionRemove(EXPIRY_STORAGE_KEY);
      safeSessionRemove(TOKEN_VERSION_STORAGE_KEY);
      if (storedToken) safeStorageSet(AUTH_HISTORY_STORAGE_KEY, 'true');
    }
    this.jobCache = new Map();
    this.indexFileCache = new Map();
    this.songIndexCache = null;
    this.queueIndexCache = null;
    this.authRequiredListeners = new Set();
    this.authRequired = false;
    this.tokenRequestPromise = null;
    this.tokenErrorCallback = null;
  }

  _persistToken(token, expiry, tokenVersion = '') {
    this.accessToken = token;
    this.tokenExpiry = expiry;
    this.tokenVersion = token ? (tokenVersion || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()))) : '';
    if (token && expiry) this.authRequired = false;
    if (token && expiry) {
      this.hasAuthorizedSession = true;
      safeStorageSet(AUTH_HISTORY_STORAGE_KEY, 'true');
      safeSessionSet(TOKEN_STORAGE_KEY, token);
      safeSessionSet(EXPIRY_STORAGE_KEY, String(expiry));
      safeSessionSet(TOKEN_VERSION_STORAGE_KEY, this.tokenVersion);
    } else {
      safeSessionRemove(TOKEN_STORAGE_KEY);
      safeSessionRemove(EXPIRY_STORAGE_KEY);
      safeSessionRemove(TOKEN_VERSION_STORAGE_KEY);
    }
    if (token) {
      this.syncTokenToServiceWorker();
    } else {
      this.clearServiceWorkerToken();
    }
  }

  clearServiceWorkerToken() {
    if (typeof navigator === 'undefined') return;
    const message = { type: 'SISIC_DRIVE_CLEAR_TOKEN' };
    const controller = navigator.serviceWorker?.controller;
    if (controller) controller.postMessage(message);
    navigator.serviceWorker?.ready?.then(registration => {
      if (registration.active && registration.active !== controller) {
        registration.active.postMessage(message);
      }
    }).catch(() => {});
  }

  syncTokenToServiceWorker(target = null) {
    if (!this.isAuthenticated || typeof navigator === 'undefined') return false;
    const message = {
      type: 'SISIC_DRIVE_TOKEN',
      accessToken: this.accessToken,
      tokenVersion: this.tokenVersion,
    };
    if (target?.postMessage) target.postMessage(message);
    const controller = navigator.serviceWorker?.controller;
    if (controller && controller !== target) controller.postMessage(message);
    navigator.serviceWorker?.ready?.then(registration => {
      if (registration.active && registration.active !== target && registration.active !== controller) {
        registration.active.postMessage(message);
      }
    }).catch(() => {});
    return true;
  }

  adoptStoredToken() {
    // Kept as a migration hook for callers from older builds. Tokens are no
    // longer restored from localStorage.
    safeStorageRemove(TOKEN_STORAGE_KEY);
    safeStorageRemove(EXPIRY_STORAGE_KEY);
    safeStorageRemove(TOKEN_SCOPE_STORAGE_KEY);
    safeStorageRemove(TOKEN_VERSION_STORAGE_KEY);
    return false;
  }

  subscribeAuthRequired(listener) {
    this.authRequiredListeners.add(listener);
    return () => this.authRequiredListeners.delete(listener);
  }

  requireAuthentication(reason = null) {
    const error = reason instanceof Error
      ? reason
      : new Error(String(reason || 'Google Drive authentication is required.'));
    const wasRequired = this.authRequired;
    this.authRequired = true;
    this._persistToken(null, null);
    if (!wasRequired) {
      this.authRequiredListeners.forEach(listener => listener(error));
    }
    return error;
  }

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
        this._persistToken(resp.access_token, tokenExpiryFromResponse(resp));
      },
      error_callback: error => this.tokenErrorCallback?.(error),
    });
  }

  requestToken({ prompt } = {}) {
    if (this.tokenRequestPromise) return this.tokenRequestPromise;
    this.tokenRequestPromise = new Promise((resolve, reject) => {
      if (!this.tokenClient) {
        reject(new Error('Token client not initialized'));
        return;
      }
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        this.tokenErrorCallback = null;
        callback(value);
      };
      this.tokenClient.callback = (resp) => {
        if (resp.error) {
          finish(reject, new Error(resp.error_description || resp.error));
          return;
        }
        const accessToken = String(resp.access_token || '').trim();
        if (!accessToken) {
          finish(reject, new Error('Google sign-in did not return an access token.'));
          return;
        }
        this._persistToken(accessToken, tokenExpiryFromResponse(resp));
        finish(resolve, accessToken);
      };
      this.tokenErrorCallback = error => {
        const message = error?.type === 'popup_closed'
          ? 'Google sign-in was closed before it finished.'
          : 'Google sign-in could not open. Allow pop-ups and try again.';
        finish(reject, new Error(message));
      };
      const requestedPrompt = typeof prompt === 'string'
        ? prompt
        : (this.hasAuthorizedSession ? '' : 'consent');
      this.tokenClient.requestAccessToken({ prompt: requestedPrompt });
    }).finally(() => {
      this.tokenRequestPromise = null;
      this.tokenErrorCallback = null;
    });
    return this.tokenRequestPromise;
  }

  async getValidAccessToken() {
    if (this.isAuthenticated) return this.accessToken;
    throw this.requireAuthentication(new Error('Google Drive authorization is required.'));
  }

  get isAuthenticated() {
    return Boolean(this.accessToken && Date.now() < (this.tokenExpiry || 0));
  }

  async authorizedFetch(url, options = {}, label = 'Drive request') {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${await this.getValidAccessToken()}`);
    const resp = await fetch(url, { ...options, headers });
    if (resp.status === 401) {
      throw this.requireAuthentication(new Error(`${label} needs Google Drive reconnection.`));
    }
    return resp;
  }

  async driveGet(url, label = 'Drive request') {
    const resp = await this.authorizedFetch(url, {}, label);
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

  async driveList(query, fields = JOB_FILE_FIELDS, pageSize = 100) {
    const allFiles = [];
    let pageToken = '';
    const requestedFields = fields.includes('nextPageToken') ? fields : `nextPageToken,${fields}`;

    do {
      const params = new URLSearchParams({
        q: query,
        fields: requestedFields,
        pageSize: String(pageSize),
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const resp = await this.driveGet(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, 'Drive file list');
      const data = await resp.json();
      allFiles.push(...(data.files || []));
      pageToken = data.nextPageToken || '';
    } while (pageToken);

    return allFiles;
  }

  async fetchSpotifyLibrary(fileId) {
    const resp = await this.driveGet(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      'Spotify library file'
    );
    return await resp.json();
  }

  async fetchStorageQuota() {
    try {
      const resp = await this.driveGet(
        'https://www.googleapis.com/drive/v3/about?fields=storageQuota',
        'Drive storage quota'
      );
      const data = await resp.json();
      const quota = data.storageQuota || {};
      return {
        limitBytes: Number(quota.limit || 0),
        usageBytes: Number(quota.usage || 0),
        usageInDriveBytes: Number(quota.usageInDrive || 0),
        usageInDriveTrashBytes: Number(quota.usageInDriveTrash || 0),
      };
    } catch (error) {
      console.warn('Drive storage quota unavailable:', error);
      return null;
    }
  }

  async findJsonIndexFile(folderId, filename) {
    const cacheKey = `${folderId}:${filename}`;
    const cached = this.indexFileCache.get(cacheKey);
    if (cached) return cached;

    const escapedFolder = escapeDriveQuery(folderId);
    const escapedName = escapeDriveQuery(filename);
    const q = `name='${escapedName}' and '${escapedFolder}' in parents and trashed=false`;
    const files = await this.driveList(q, 'files(id,name,modifiedTime,appProperties)', 10);
    const file = files[0] || null;
    if (file) this.indexFileCache.set(cacheKey, file);
    return file;
  }

  async createJsonIndexFile(folderId, filename, body) {
    const metadata = {
      name: filename,
      parents: [folderId],
      mimeType: JOB_MIME_TYPE,
      appProperties: {
        sisicIndex: 'true',
        sisicIndexName: filename,
      },
    };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: JOB_MIME_TYPE }));
    form.append('file', new Blob([JSON.stringify(body, null, 2)], { type: JOB_MIME_TYPE }));
    const resp = await this.authorizedFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,appProperties', {
      method: 'POST',
      body: form,
    }, 'Drive index create');
    if (!resp.ok) throw new Error(`Drive index create failed: ${resp.status} ${await resp.text()}`);
    const file = await resp.json();
    this.indexFileCache.set(`${folderId}:${filename}`, file);
    return file;
  }

  async updateJsonIndexFile(fileId, body) {
    const params = new URLSearchParams({
      uploadType: 'media',
      fields: 'id,name,modifiedTime,appProperties',
      supportsAllDrives: 'true',
    });
    const resp = await this.authorizedFetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': JOB_MIME_TYPE,
      },
      body: JSON.stringify(body, null, 2),
    }, 'Drive index update');
    if (!resp.ok) throw new Error(`Drive index update failed: ${resp.status} ${await resp.text()}`);
    return await resp.json();
  }

  async readJsonIndex(folderId, filename, defaultBody = {}) {
    const file = await this.findJsonIndexFile(folderId, filename);
    if (!file) return defaultBody;
    return await this.readJsonFile(file.id, filename);
  }

  async writeJsonIndex(folderId, filename, body) {
    const file = await this.findJsonIndexFile(folderId, filename);
    if (!file) {
      return await this.createJsonIndexFile(folderId, filename, body);
    }
    const updatedFile = await this.updateJsonIndexFile(file.id, body);
    this.indexFileCache.set(`${folderId}:${filename}`, updatedFile);
    return updatedFile;
  }

  async mutateJsonIndex(folderId, filename, key, defaultValues, mutator) {
    const current = await this.readJsonIndex(folderId, filename, indexBody(key, defaultValues || []));
    const currentValues = Array.isArray(current[key]) ? current[key] : [];
    const nextValues = await mutator([...currentValues], current);
    const body = indexBody(key, Array.isArray(nextValues) ? nextValues : [], current);
    await this.writeJsonIndex(folderId, filename, body);
    if (filename === SONG_INDEX_FILENAME) this.songIndexCache = body;
    if (filename === QUEUE_INDEX_FILENAME) this.queueIndexCache = body;
    return body;
  }

  async trashFile(fileId) {
    if (!fileId) throw new Error('Missing Drive file ID.');
    const params = new URLSearchParams({
      fields: 'id,name,trashed',
      supportsAllDrives: 'true',
    });
    const resp = await this.authorizedFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ trashed: true }),
    }, 'Drive file trash');
    if (!resp.ok) throw new Error(`Drive file trash failed: ${resp.status} ${await resp.text()}`);
    return await resp.json();
  }

  async updateFileAppProperties(fileId, updates = {}) {
    if (!fileId) return null;
    const existing = await this.getAudioFileMetadata(fileId);
    if (!existing) return null;
    const params = new URLSearchParams({
      fields: FILE_METADATA_FIELDS,
      supportsAllDrives: 'true',
    });
    const resp = await this.authorizedFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appProperties: { ...(existing.appProperties || {}), ...updates },
      }),
    }, 'Drive audio metadata update');
    if (!resp.ok) throw new Error(`Drive audio metadata update failed: ${resp.status} ${await resp.text()}`);
    return await resp.json();
  }

  async updateAudioFileMetadata(fileId, { name = '', appProperties = {} } = {}) {
    if (!fileId) return null;
    const existing = await this.getAudioFileMetadata(fileId);
    if (!existing) return null;
    const params = new URLSearchParams({
      fields: FILE_METADATA_FIELDS,
      supportsAllDrives: 'true',
    });
    const body = {
      appProperties: { ...(existing.appProperties || {}), ...appProperties },
    };
    if (name) body.name = name;
    const resp = await this.authorizedFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, 'Drive audio metadata update');
    if (!resp.ok) throw new Error(`Drive audio metadata update failed: ${resp.status} ${await resp.text()}`);
    return await resp.json();
  }

  async listAudioFiles(folderId) {
    const escapedFolder = escapeDriveQuery(folderId);
    const q = `'${escapedFolder}' in parents and trashed=false`;
    const files = await this.driveList(q, AUDIO_FILE_FIELDS, 100);
    return files.filter(isAudioFileMetadata);
  }

  async syncSongIndex(folderId) {
    const audioFiles = await this.listAudioFiles(folderId);
    const previous = await this.readJsonIndex(folderId, SONG_INDEX_FILENAME, indexBody('songs', []));
    const previousSongs = Array.isArray(previous.songs) ? previous.songs : [];
    const previousByKey = new Map(previousSongs.filter(item => item.songKey).map(item => [item.songKey, item]));
    const previousByFileId = new Map(previousSongs.filter(item => item.driveFileId).map(item => [item.driveFileId, item]));
    const metadataFields = ['description', 'lyrics', 'genre', 'releaseDate', 'coverArtUrl', 'metadataStatus', 'metadataSource', 'metadataUpdatedAt'];
    const songs = audioFiles.map(file => {
      const entry = normalizeSongIndexEntry(file);
      const previousEntry = previousByKey.get(entry.songKey) || previousByFileId.get(entry.driveFileId);
      return previousEntry
        ? { ...entry, ...Object.fromEntries(metadataFields.filter(field => Object.prototype.hasOwnProperty.call(previousEntry, field)).map(field => [field, previousEntry[field]])) }
        : entry;
    }).sort((a, b) => a.songKey.localeCompare(b.songKey));
    const body = indexBody('songs', songs, previous);
    await this.writeJsonIndex(folderId, SONG_INDEX_FILENAME, body);
    this.songIndexCache = body;
    return body;
  }

  async readSongIndex(folderId, { forceRefresh = false } = {}) {
    if (this.songIndexCache && !forceRefresh) return this.songIndexCache;
    const body = await this.readJsonIndex(folderId, SONG_INDEX_FILENAME, indexBody('songs', []));
    this.songIndexCache = {
      ...body,
      songs: Array.isArray(body.songs) ? body.songs.map(song => normalizeSongIndexEntry(song)) : [],
    };
    return this.songIndexCache;
  }

  async findSongInIndex(song, folderId, { allowSimilarity = true } = {}) {
    const index = await this.readSongIndex(folderId);
    const songKey = getSongKey(song);
    const found = index.songs.find(entry => entry.songKey === songKey && entry.driveFileId);
    let matched = found;
    let similarity = null;

    if (!matched && allowSimilarity) {
      const match = findSimilarSongMatch(song, index.songs.filter(entry => entry.driveFileId), 'medium');
      if (match) {
        matched = match.song;
        similarity = match.similarity;
      }
    }

    if (!matched) return null;
    // The song index is metadata, not proof that the referenced Drive object
    // is still the audio file. Older queue versions could leave a job JSON ID
    // in this field after a replacement. Validate the object before returning
    // it to playback or to the download/review actions.
    const metadata = await this.getAudioFileMetadata(matched.driveFileId);
    if (!metadata) return null;
    return {
      id: metadata.id || matched.driveFileId,
      name: metadata.name || matched.filename,
      mimeType: metadata.mimeType || matched.mimeType || 'audio/mpeg',
      size: Number(metadata.size || matched.size || 0),
      modifiedTime: metadata.modifiedTime || matched.modifiedTime,
      similarity,
      appProperties: metadata.appProperties || {
        sisicAudio: 'true',
        sisicSongKey: matched.songKey,
        sisicArtist: matched.artist,
        sisicTrack: matched.track,
      },
    };
  }

  async confirmSongIndexMatch(folderId, songInput, matchedFile) {
    const song = asSongRecord(songInput);
    const entry = normalizeSongIndexEntry({
      id: matchedFile.id || matchedFile.driveFileId,
      name: matchedFile.name || matchedFile.filename || canonicalAudioFilename(song),
      mimeType: matchedFile.mimeType || 'audio/mpeg',
      size: matchedFile.size || 0,
      modifiedTime: matchedFile.modifiedTime || '',
      appProperties: matchedFile.appProperties || {},
    }, song);
    entry.confirmedMatch = true;
    entry.matchUpdatedAt = new Date().toISOString();
    const body = await this.mutateJsonIndex(folderId, SONG_INDEX_FILENAME, 'songs', [], songs => {
      const byKey = new Map(songs.filter(item => item.songKey).map(item => [item.songKey, item]));
      byKey.set(song.songKey, entry);
      return [...byKey.values()].sort((a, b) => a.songKey.localeCompare(b.songKey));
    });
    return body.songs.find(item => item.songKey === song.songKey) || entry;
  }

  async updateSongReview(folderId, songInput, reviewStatus, extra = {}) {
    const song = asSongRecord(songInput);
    const reviewedAt = new Date().toISOString();
    if (song.driveFileId) {
      await this.updateFileAppProperties(song.driveFileId, {
        sisicQualityStatus: reviewStatus,
        sisicQualityReviewedAt: reviewedAt,
      });
    }
    const body = await this.mutateJsonIndex(folderId, SONG_INDEX_FILENAME, 'songs', [], songs => {
      const byKey = new Map(songs.filter(item => item.songKey).map(item => [item.songKey, item]));
      const existing = byKey.get(song.songKey) || normalizeSongIndexEntry({
        id: song.driveFileId || '',
        name: song.filename || canonicalAudioFilename(song),
        mimeType: song.mimeType || 'audio/mpeg',
        size: song.size || 0,
        modifiedTime: song.modifiedTime || '',
        appProperties: {},
      }, song);
      byKey.set(song.songKey, {
        ...existing,
        qualityStatus: reviewStatus,
        qualityReviewedAt: reviewedAt,
        reviewNote: extra.reviewNote || existing.reviewNote || '',
      });
      return [...byKey.values()].sort((a, b) => a.songKey.localeCompare(b.songKey));
    });
    return body.songs.find(item => item.songKey === song.songKey) || null;
  }

  async syncQueueIndexFromJobFiles(folderId) {
    const current = await this.readQueueIndex(folderId);
    if (current.storageMode === CANONICAL_QUEUE_STORAGE_MODE) return current.jobs;
    const jobs = await this.listDownloadJobFiles(folderId);
    const previous = current;
    const body = indexBody('jobs', jobs.map(normalizeQueueIndexJob).filter(Boolean), previous);
    await this.writeJsonIndex(folderId, QUEUE_INDEX_FILENAME, body);
    this.queueIndexCache = body;
    return body.jobs;
  }

  async readQueueIndex(folderId) {
    const body = await this.readJsonIndex(folderId, QUEUE_INDEX_FILENAME, indexBody('jobs', []));
    this.queueIndexCache = {
      ...body,
      jobs: Array.isArray(body.jobs) ? body.jobs : [],
    };
    return this.queueIndexCache;
  }

  async upsertQueueIndexJob(folderId, job) {
    const current = await this.readQueueIndex(folderId);
    const normalized = normalizeQueueIndexJob(job);
    if (!normalized) return current;
    const jobsById = new Map(current.jobs.map(item => [item.jobId, item]));
    jobsById.set(normalized.jobId, normalized);
    const body = indexBody('jobs', [...jobsById.values()].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))), current);
    await this.writeJsonIndex(folderId, QUEUE_INDEX_FILENAME, body);
    this.queueIndexCache = body;
    return body;
  }

  async updateQueueIndexJob(folderId, jobInput, updates = {}) {
    const current = await this.readQueueIndex(folderId);
    const existing = (current.jobs || []).find(job => job.jobId === jobInput?.jobId);
    if (!existing) throw new Error('The download job is no longer in the canonical Drive queue. Refresh and try again.');
    const updated = normalizeQueueIndexJob({
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    });
    const jobsById = new Map((current.jobs || []).map(job => [job.jobId, job]));
    jobsById.set(updated.jobId, updated);
    const body = indexBody(
      'jobs',
      [...jobsById.values()].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))),
      current,
    );
    if (current.storageMode === CANONICAL_QUEUE_STORAGE_MODE) body.storageMode = CANONICAL_QUEUE_STORAGE_MODE;
    await this.writeJsonIndex(folderId, QUEUE_INDEX_FILENAME, body);
    this.queueIndexCache = body;
    return updated;
  }

  async recordSourceFeedback(folderId, songInput, candidate, decision) {
    const song = asSongRecord(songInput);
    const normalizedDecision = String(decision || '').toLowerCase();
    if (!['accepted', 'rejected'].includes(normalizedDecision)) throw new Error('Source feedback must be accepted or rejected.');
    const sourceUrl = candidateSourceUrl(candidate);
    const candidateId = candidateIdentity(candidate) || sourceUrl;
    if (!song.songKey || !candidateId || !sourceUrl) throw new Error('The YouTube candidate is missing its source URL.');
    const entry = {
      decisionId: crypto.randomUUID(),
      songKey: song.songKey,
      artist: song.artist || '',
      track: song.track || '',
      candidateId,
      sourceVideoId: candidate.videoId || candidate.id || '',
      sourceUrl,
      sourceTitle: candidate.title || '',
      sourceUploader: candidate.uploader || candidate.channel || '',
      decision: normalizedDecision,
      createdAt: new Date().toISOString(),
      createdBy: CLIENT_INSTANCE_ID,
    };
    await this.mutateJsonIndex(folderId, SOURCE_FEEDBACK_FILENAME, 'decisions', [], decisions => {
      const sameCandidate = item => (
        item.songKey === entry.songKey
        && (item.candidateId === entry.candidateId || item.sourceUrl === entry.sourceUrl)
      );
      return [...decisions.filter(item => !sameCandidate(item)), entry].slice(-500);
    });
    return entry;
  }

  async selectDownloadCandidate(folderId, songInput, candidate) {
    const song = asSongRecord(songInput);
    const sourceUrl = candidateSourceUrl(candidate);
    if (!sourceUrl) throw new Error('The selected candidate has no YouTube URL.');
    const existing = songInput?.downloadJob?.jobId
      ? songInput.downloadJob
      : await this.findDownloadJob(song, folderId);
    if (!existing?.jobId) {
      const result = await this.requestSongDownload(song, folderId, sourceUrl, {
        allowRedownload: true,
        replaceExisting: Boolean(song.driveFileId),
        replacementForFileId: song.driveFileId || '',
        reviewAction: 'accepted-candidate',
      });
      await this.recordSourceFeedback(folderId, song, candidate, 'accepted');
      return result;
    }
    const now = new Date().toISOString();
    const updated = await this.updateQueueIndexJob(folderId, existing, {
      status: 'queued',
      attempts: 0,
      lastError: '',
      nextAttemptAt: '',
      uploadedFileId: '',
      sourceUrl,
      selectedSourceUrl: sourceUrl,
      sourceVideoId: candidate.videoId || candidate.id || '',
      sourceTitle: candidate.title || '',
      sourceUploader: candidate.uploader || candidate.channel || '',
      sourceDuration: candidate.duration || '',
      sourceSelectionMode: 'reviewed-youtube-candidate',
      reviewState: 'accepted',
      reviewDecision: 'accepted',
      reviewDecisionAt: now,
      reviewCandidates: [],
      reviewAction: 'accepted-candidate',
    });
    await this.recordSourceFeedback(folderId, song, candidate, 'accepted');
    return { queued: true, alreadyQueued: false, job: updated };
  }

  async retryDownloadSearch(folderId, songInput) {
    const song = asSongRecord(songInput);
    const existing = songInput?.downloadJob?.jobId
      ? songInput.downloadJob
      : await this.findDownloadJob(song, folderId);
    if (!existing?.jobId) {
      return await this.requestSongDownload(song, folderId, '', { allowRedownload: true });
    }
    const updated = await this.updateQueueIndexJob(folderId, existing, {
      status: 'queued',
      attempts: 0,
      lastError: '',
      nextAttemptAt: '',
      sourceUrl: '',
      selectedSourceUrl: '',
      sourceVideoId: '',
      sourceTitle: '',
      sourceUploader: '',
      sourceDuration: '',
      sourceSelectionMode: '',
      reviewState: 'search-again',
      reviewDecision: '',
      reviewDecisionAt: '',
      reviewCandidates: [],
    });
    return { queued: true, alreadyQueued: false, job: updated };
  }

  async ensureDeletedIndex(folderId) {
    return await this.readJsonIndex(folderId, DELETED_INDEX_FILENAME, indexBody('deleted', []));
  }

  async readDeletedIndex(folderId) {
    const body = await this.ensureDeletedIndex(folderId);
    return {
      ...body,
      deleted: Array.isArray(body.deleted) ? body.deleted : [],
    };
  }

  findDeletedMatch(songInput, deleted = [], minimumConfidence = 'high') {
    const song = asSongRecord(songInput);
    const exact = deleted.find(item => item.songKey === song.songKey);
    if (exact) {
      return { deleted: exact, similarity: compareSongSimilarity(song, exact) };
    }
    const match = findSimilarSongMatch(song, deleted, minimumConfidence);
    return match ? { deleted: match.song, similarity: match.similarity } : null;
  }

  async addDeletedSong(folderId, songInput, extra = {}) {
    const entry = normalizeDeletedEntry(songInput, extra);
    const body = await this.mutateJsonIndex(folderId, DELETED_INDEX_FILENAME, 'deleted', [], deleted => {
      const byKey = new Map(deleted.filter(item => item.songKey).map(item => [item.songKey, item]));
      byKey.set(entry.songKey, entry);
      return [...byKey.values()].sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')));
    });
    return body.deleted.find(item => item.songKey === entry.songKey) || entry;
  }

  async removeDeletedSong(folderId, songInput) {
    const song = asSongRecord(songInput);
    const body = await this.mutateJsonIndex(folderId, DELETED_INDEX_FILENAME, 'deleted', [], deleted => (
      deleted.filter(item => item.songKey !== song.songKey && compareSongSimilarity(song, item).confidence !== 'high')
    ));
    return body.deleted;
  }

  async ensureDuplicateIndex(folderId) {
    return await this.readJsonIndex(folderId, DUPLICATE_INDEX_FILENAME, indexBody('duplicates', []));
  }

  async readDuplicateIndex(folderId) {
    const body = await this.ensureDuplicateIndex(folderId);
    return {
      ...body,
      duplicates: Array.isArray(body.duplicates) ? body.duplicates : [],
    };
  }

  async addDuplicateSong(folderId, songInput, extra = {}) {
    const entry = normalizeDuplicateEntry(songInput, extra);
    const body = await this.mutateJsonIndex(folderId, DUPLICATE_INDEX_FILENAME, 'duplicates', [], duplicates => {
      const byKey = new Map(duplicates.filter(item => item.songKey).map(item => [item.songKey, item]));
      byKey.set(entry.songKey, entry);
      return [...byKey.values()].sort((a, b) => String(b.duplicateAt || '').localeCompare(String(a.duplicateAt || '')));
    });
    return body.duplicates.find(item => item.songKey === entry.songKey) || entry;
  }

  async removeDuplicateSong(folderId, songInput) {
    const song = asSongRecord(songInput);
    const body = await this.mutateJsonIndex(folderId, DUPLICATE_INDEX_FILENAME, 'duplicates', [], duplicates => (
      duplicates.filter(item => item.songKey !== song.songKey)
    ));
    return body.duplicates;
  }

  async updateSongMetadata(folderId, songInput, updates = {}) {
    const song = asSongRecord(songInput);
    const allowedFields = ['artist', 'track', 'album', 'description', 'lyrics', 'genre', 'releaseDate', 'coverArtUrl', 'metadataStatus', 'metadataSource'];
    const patch = Object.fromEntries(
      allowedFields
        .filter(field => Object.prototype.hasOwnProperty.call(updates, field))
        .map(field => [field, String(updates[field] || '').trim()]),
    );
    const nextSong = asSongRecord({ ...song, ...patch, songKey: song.songKey });
    const updatedAt = new Date().toISOString();

    if (song.driveFileId) {
      await this.updateAudioFileMetadata(song.driveFileId, {
        name: canonicalAudioFilename(nextSong),
        appProperties: {
          sisicSongKey: song.songKey,
          sisicArtist: nextSong.artist,
          sisicTrack: nextSong.track,
          sisicAlbum: nextSong.album || '',
        },
      });
    }

    const songBody = await this.mutateJsonIndex(folderId, SONG_INDEX_FILENAME, 'songs', [], songs => {
      const byKey = new Map(songs.filter(item => item.songKey).map(item => [item.songKey, item]));
      const existing = byKey.get(song.songKey) || {};
      byKey.set(song.songKey, {
        ...existing,
        ...nextSong,
        songKey: song.songKey,
        filename: canonicalAudioFilename(nextSong),
        driveFileId: song.driveFileId || existing.driveFileId || '',
        updatedAt,
        metadataUpdatedAt: updatedAt,
      });
      return [...byKey.values()].sort((a, b) => String(a.songKey).localeCompare(String(b.songKey)));
    });

    const importJobId = song.driveImportJobId || song.downloadJob?.jobId || '';
    if (importJobId) {
      await this.mutateJsonIndex(folderId, QUEUE_INDEX_FILENAME, 'jobs', [], jobs => jobs.map(job => (
        job.jobId === importJobId || job.songKey === song.songKey
          ? { ...job, ...patch, songKey: song.songKey, expectedFilename: canonicalAudioFilename(nextSong), metadataUpdatedAt: updatedAt, updatedAt }
          : job
      )));
    }

    try {
      const duplicateIndex = await this.readDuplicateIndex(folderId);
      if (duplicateIndex.duplicates.some(item => item.songKey === song.songKey)) {
        await this.mutateJsonIndex(folderId, DUPLICATE_INDEX_FILENAME, 'duplicates', [], duplicates => duplicates.map(item => (
          item.songKey === song.songKey ? { ...item, ...nextSong, songKey: song.songKey, driveFileId: song.driveFileId || item.driveFileId || '', updatedAt } : item
        )));
      }
    } catch (error) {
      console.warn('Duplicate metadata refresh skipped:', error);
    }
    return songBody.songs.find(item => item.songKey === song.songKey) || { ...nextSong, updatedAt };
  }

  async deleteReadySong(folderId, songInput) {
    const song = asSongRecord(songInput);
    const previousDriveFileId = song.driveFileId;
    if (!previousDriveFileId) throw new Error('This Ready song does not have a Drive file ID.');
    await this.trashFile(previousDriveFileId);
    await this.mutateJsonIndex(folderId, SONG_INDEX_FILENAME, 'songs', [], songs => (
      songs.filter(item => item.songKey !== song.songKey && item.driveFileId !== previousDriveFileId)
    ));
    return await this.addDeletedSong(folderId, song, {
      previousDriveFileId,
      reason: 'ready-offload',
    });
  }

  async readPlaylistIndex(folderId) {
    const body = await this.readJsonIndex(folderId, PLAYLIST_INDEX_FILENAME, indexBody('playlists', []));
    return {
      ...body,
      playlists: Array.isArray(body.playlists) ? body.playlists.map(normalizePlaylistIndexEntry) : [],
    };
  }

  async writePlaylistIndex(folderId, playlists = []) {
    const normalized = playlists.map(normalizePlaylistIndexEntry).filter(playlist => playlist.playlistKey && playlist.songKeys.length > 0);
    return await this.mutateJsonIndex(folderId, PLAYLIST_INDEX_FILENAME, 'playlists', [], () => normalized);
  }

  async readPlaybackLog(folderId) {
    const body = await this.readJsonIndex(folderId, PLAYBACK_LOG_FILENAME, indexBody('events', []));
    return {
      ...body,
      events: Array.isArray(body.events) ? body.events : [],
    };
  }

  async appendPlaybackLog(folderId, event = {}) {
    const logEntry = {
      id: event.id || crypto.randomUUID(),
      eventType: event.eventType || 'playback-event',
      songKey: event.songKey || '',
      artist: event.artist || '',
      track: event.track || '',
      driveFileId: event.driveFileId || '',
      positionSeconds: Number(event.positionSeconds || 0),
      durationSeconds: Number(event.durationSeconds || 0),
      secondsPlayed: Number(event.secondsPlayed == null ? event.positionSeconds || 0 : event.secondsPlayed),
      expectedFullPlay: Boolean(event.expectedFullPlay),
      userInitiated: Boolean(event.userInitiated),
      sessionId: event.sessionId || '',
      context: event.context && typeof event.context === 'object' ? { ...event.context } : null,
      sourceSurface: event.sourceSurface || event.source || 'player',
      skipReason: event.skipReason || '',
      message: event.message || '',
      createdAt: event.createdAt || new Date().toISOString(),
      createdBy: CLIENT_INSTANCE_ID,
    };
    try {
      await this.mutateJsonIndex(folderId, PLAYBACK_LOG_FILENAME, 'events', [], events => (
        [logEntry, ...events].slice(0, MAX_PLAYBACK_LOGS)
      ));
    } catch (error) {
      console.warn('Playback log write failed:', error);
    }
    return logEntry;
  }

  async loadDriveIndexes(folderId) {
    const [songs, queue, deleted, duplicates, playlists, quota, playback] = await Promise.all([
      this.readSongIndex(folderId),
      this.readQueueIndex(folderId),
      this.readDeletedIndex(folderId),
      this.readDuplicateIndex(folderId),
      this.readPlaylistIndex(folderId),
      this.fetchStorageQuota(),
      this.readPlaybackLog(folderId),
    ]);
    return {
      songs: songs.songs || [],
      jobs: queue.jobs || [],
      deleted: deleted.deleted || [],
      duplicates: duplicates.duplicates || [],
      playlists: playlists.playlists || [],
      playbackEvents: playback.events || [],
      quota,
    };
  }

  async syncDriveIndexes(folderId) {
    return await this.loadDriveIndexes(folderId);
  }

  async getAudioFileMetadata(fileId) {
    if (!fileId) return null;
    const params = new URLSearchParams({
      fields: FILE_METADATA_FIELDS,
      supportsAllDrives: 'true',
    });
    try {
      const resp = await this.driveGet(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`,
        'Drive audio metadata'
      );
      const file = await resp.json();
      return isAudioFileMetadata(file) ? file : null;
    } catch (error) {
      console.warn('Drive audio metadata validation failed:', fileId, error);
      return null;
    }
  }

  async findSongFile(songOrTitle, folderId, maybeArtist = '') {
    const song = typeof songOrTitle === 'object'
      ? asSongRecord(songOrTitle)
      : asSongRecord({ track: songOrTitle, artist: maybeArtist });
    const indexed = await this.findSongInIndex(song, folderId);
    if (indexed) return indexed;

    const songKey = getSongKey(song);
    const escapedFolder = escapeDriveQuery(folderId);
    const escapedKey = escapeDriveQuery(songKey);

    const metadataQuery = [
      `'${escapedFolder}' in parents`,
      'trashed=false',
      `appProperties has { key='sisicSongKey' and value='${escapedKey}' }`,
    ].join(' and ');
    const metadataMatches = await this.driveList(metadataQuery, AUDIO_FILE_FIELDS, 10);
    const metadataAudio = firstAudioFile(metadataMatches);
    if (metadataAudio) return metadataAudio;

    const escapedName = escapeDriveQuery(canonicalAudioFilename(song));
    const filenameQuery = `name='${escapedName}' and '${escapedFolder}' in parents and trashed=false`;
    const filenameMatches = await this.driveList(filenameQuery, AUDIO_FILE_FIELDS, 10);
    return firstAudioFile(filenameMatches);
  }

  async downloadFileAsBlob(fileId) {
    const metadata = await this.getAudioFileMetadata(fileId);
    if (!metadata) {
      throw new Error('Drive file is not an audio file. It may be a download job JSON file.');
    }
    const resp = await this.driveGet(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      'Drive audio download'
    );
    const blob = await resp.blob();
    if (blob.type && !blob.type.startsWith('audio/') && blob.type !== 'application/octet-stream') {
      throw new Error(`Drive file is not audio. Download returned ${blob.type}.`);
    }
    if (blob.type && blob.type.startsWith('audio/')) return blob;
    return new Blob([await blob.arrayBuffer()], { type: metadata.mimeType || 'audio/mpeg' });
  }

  async readJsonFile(fileId, label = 'Drive JSON file') {
    const resp = await this.driveGet(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, label);
    return await resp.json();
  }

  async listDownloadJobFiles(folderId) {
    const escapedFolder = escapeDriveQuery(folderId);
    const q = `name contains 'sisic-job-' and '${escapedFolder}' in parents and trashed=false`;
    const files = await this.driveList(q, JOB_FILE_FIELDS, 100);
    const jobs = [];
    for (const file of files) {
      const cached = this.jobCache.get(file.id);
      if (cached?.modifiedTime === file.modifiedTime) {
        jobs.push(cached.job);
        continue;
      }

      try {
        const content = await this.readJsonFile(file.id, 'Drive job file');
        const job = normalizeJob(content, file);
        if (job) {
          this.jobCache.set(file.id, { modifiedTime: file.modifiedTime, job });
          jobs.push(job);
        }
      } catch (error) {
        console.error('Failed to read Drive job file:', file.name, error);
      }
    }
    return jobs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async listDownloadJobs(folderId) {
    const index = await this.readQueueIndex(folderId);
    if (Array.isArray(index.jobs)) {
      return index.jobs.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    }
    return [];
  }

  async findDownloadJob(song, folderId) {
    const songKey = getSongKey(song);
    const queueIndex = await this.readQueueIndex(folderId);
    const indexed = [...(queueIndex.jobs || [])]
      .filter(job => job.songKey === songKey)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
    if (indexed) return indexed;

    const escapedFolder = escapeDriveQuery(folderId);
    const escapedKey = escapeDriveQuery(songKey);
    const q = [
      `name contains 'sisic-job-'`,
      `'${escapedFolder}' in parents`,
      'trashed=false',
      `appProperties has { key='sisicSongKey' and value='${escapedKey}' }`,
    ].join(' and ');
    const files = await this.driveList(q, JOB_FILE_FIELDS, 20);
    const jobs = [];
    for (const file of files) {
      try {
        const content = await this.readJsonFile(file.id, 'Drive job file');
        const job = normalizeJob(content, file);
        if (job) jobs.push(job);
      } catch (error) {
        console.error('Failed to read Drive job file:', file.name, error);
      }
    }
    return jobs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] || null;
  }

  async createJobFile(job, folderId) {
    const currentQueue = await this.readQueueIndex(folderId);
    if (currentQueue.storageMode === CANONICAL_QUEUE_STORAGE_MODE) {
      const normalized = normalizeJob(job, {
        id: `queue:${job.jobId}`,
        name: QUEUE_INDEX_FILENAME,
      });
      const jobsById = new Map((currentQueue.jobs || []).map(item => [item.jobId, item]));
      jobsById.set(normalized.jobId, normalized);
      const body = indexBody(
        'jobs',
        [...jobsById.values()].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))),
        currentQueue,
      );
      body.storageMode = CANONICAL_QUEUE_STORAGE_MODE;
      await this.writeJsonIndex(folderId, QUEUE_INDEX_FILENAME, body);
      this.queueIndexCache = body;
      return normalized;
    }

    const content = JSON.stringify(job, null, 2);
    const metadata = {
      name: `${jobFilePrefix(job.songKey)}-${job.jobId}.json`,
      parents: [folderId],
      mimeType: JOB_MIME_TYPE,
      appProperties: {
        sisicJob: 'true',
        sisicSongKey: job.songKey,
        sisicArtist: job.artist,
        sisicTrack: job.track,
      },
    };
    const createForm = () => {
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: JOB_MIME_TYPE }));
      form.append('file', new Blob([content], { type: JOB_MIME_TYPE }));
      return form;
    };
    const resp = await this.authorizedFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,appProperties', {
      method: 'POST',
      body: createForm(),
    }, 'Drive job create');
    if (!resp.ok) {
      throw new Error(`Drive job create failed: ${resp.status} ${await resp.text()}`);
    }
    const file = await resp.json();
    const normalized = normalizeJob(job, file);
    if (normalized?.jobFileId) {
      this.jobCache.set(normalized.jobFileId, {
        modifiedTime: normalized.updatedAt,
        job: normalized,
      });
    }
    return normalized;
  }

  async uploadImportSource(file, folderId, jobId) {
    const safeName = String(file?.name || 'source-audio').replace(/[\\/]/g, '_');
    const metadata = {
      name: `sisic-import-source-${jobId}-${safeName}`,
      parents: [folderId],
      mimeType: file?.type || 'audio/mpeg',
      appProperties: {
        sisicImportSource: 'true',
        sisicImportJobId: jobId,
      },
    };
    const createForm = () => {
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: JOB_MIME_TYPE }));
      form.append('file', file, safeName);
      return form;
    };

    const resp = await this.authorizedFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,modifiedTime,appProperties', {
      method: 'POST',
      body: createForm(),
    }, 'Drive import source upload');
    if (!resp.ok) throw new Error(`Drive import source upload failed: ${resp.status} ${await resp.text()}`);
    return await resp.json();
  }

  async createImportedAudioJob(songInput, file, folderId) {
    const song = asSongRecord(songInput);
    const jobId = crypto.randomUUID();
    const source = await this.uploadImportSource(file, folderId, jobId);
    const now = new Date().toISOString();
    const job = {
      schemaVersion: 1,
      jobId,
      songKey: song.songKey,
      track: song.track,
      artist: song.artist,
      album: song.album || '',
      description: song.description || '',
      lyrics: song.lyrics || '',
      genre: song.genre || '',
      releaseDate: song.releaseDate || '',
      expectedFilename: canonicalAudioFilename(song),
      status: 'queued',
      attempts: 0,
      lastError: '',
      createdAt: now,
      updatedAt: now,
      uploadedFileId: '',
      sourceUrl: '',
      sourceFileId: source.id,
      sourceFileName: file.name || '',
      sourceMimeType: file.type || 'audio/mpeg',
      requestedBy: 'browser-import',
      allowRedownload: true,
    };

    try {
      const created = await this.createJobFile(job, folderId);
      if (!created.jobFileId.startsWith('queue:')) await this.upsertQueueIndexJob(folderId, created);
      return created;
    } catch (error) {
      if (source.id) {
        try {
          await this.trashFile(source.id);
        } catch (cleanupError) {
          console.warn('Drive import source cleanup failed:', cleanupError);
        }
      }
      throw error;
    }
  }

  async requestSongDownload(songInput, folderId, sourceUrl = '', options = {}) {
    const song = asSongRecord(songInput);
    const {
      auto = false,
      allowRedownload = false,
      replaceExisting = false,
      replacementForFileId = '',
      reviewAction = '',
    } = options;
    const deletedIndex = await this.readDeletedIndex(folderId);
    const deletedMatch = this.findDeletedMatch(song, deletedIndex.deleted, 'high');
    if (deletedMatch && !allowRedownload) {
      return {
        queued: false,
        alreadyQueued: false,
        blocked: true,
        deleted: deletedMatch.deleted,
        job: {
          jobId: `deleted-${song.songKey}`,
          songKey: song.songKey,
          artist: song.artist,
          track: song.track,
          status: 'blocked',
          lastError: 'This song was intentionally deleted from Drive.',
          updatedAt: deletedMatch.deleted.deletedAt || new Date().toISOString(),
        },
      };
    }
    if (deletedMatch && allowRedownload) {
      await this.removeDeletedSong(folderId, song);
    }

    const existing = await this.findDownloadJob(song, folderId);
    if (existing && ['queued', 'downloading'].includes(existing.status)) {
      return { queued: false, alreadyQueued: existing.status !== 'done', job: existing };
    }
    if (existing?.status === 'done' && !replaceExisting) {
      return { queued: false, alreadyQueued: false, job: existing };
    }

    const now = new Date().toISOString();
    const job = {
      schemaVersion: 1,
      jobId: crypto.randomUUID(),
      songKey: song.songKey,
      track: song.track,
      artist: song.artist,
      album: song.album || '',
      description: song.description || '',
      lyrics: song.lyrics || '',
      genre: song.genre || '',
      releaseDate: song.releaseDate || '',
      expectedFilename: canonicalAudioFilename(song),
      status: 'queued',
      attempts: 0,
      lastError: '',
      createdAt: now,
      updatedAt: now,
      uploadedFileId: '',
      sourceUrl,
      qualityStatus: reviewAction === 'reject-video' ? 'pending-replacement' : '',
      reviewAction,
      replacementForFileId: replacementForFileId || (replaceExisting ? song.driveFileId || '' : ''),
      requestedBy: auto ? 'playlist-readiness' : 'browser',
      allowRedownload: Boolean(allowRedownload),
    };
    const created = await this.createJobFile(job, folderId);
    if (!created.jobFileId.startsWith('queue:')) {
      try {
        await this.upsertQueueIndexJob(folderId, created);
      } catch (error) {
        console.warn('Queued job was created, but queue index could not be updated by the browser:', error);
      }
    }
    return { queued: true, alreadyQueued: false, job: created };
  }
}

export const driveService = new GoogleDriveService();
