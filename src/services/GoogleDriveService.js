import { asSongRecord, canonicalAudioFilename, getSongKey, jobFilePrefix } from '../songIdentity';

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
].join(' ');

const TOKEN_STORAGE_KEY = 'sisic_access_token';
const EXPIRY_STORAGE_KEY = 'sisic_token_expiry';
const JOB_MIME_TYPE = 'application/json';
const JOB_FILE_FIELDS = 'files(id,name,modifiedTime,appProperties)';
const AUDIO_FILE_FIELDS = 'files(id,name,mimeType,size,appProperties)';
const FILE_METADATA_FIELDS = 'id,name,mimeType,size,appProperties';

function escapeDriveQuery(value = '') {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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

function isAudioFileMetadata(file = {}) {
  const name = String(file.name || '').toLowerCase();
  const mimeType = String(file.mimeType || '').toLowerCase();
  const appProperties = file.appProperties || {};

  if (appProperties.sisicJob === 'true') return false;
  if (name.startsWith('sisic-job-') || name.endsWith('.json')) return false;
  if (mimeType === JOB_MIME_TYPE || mimeType.includes('json')) return false;

  return mimeType.startsWith('audio/') || name.endsWith('.mp3');
}

function firstAudioFile(files = []) {
  return files.find(isAudioFileMetadata) || null;
}

class GoogleDriveService {
  constructor() {
    this.tokenClient = null;
    this.accessToken = localStorage.getItem(TOKEN_STORAGE_KEY) || null;
    this.tokenExpiry = Number(localStorage.getItem(EXPIRY_STORAGE_KEY)) || null;
  }

  _persistToken(token, expiry) {
    this.accessToken = token;
    this.tokenExpiry = expiry;
    if (token && expiry) {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
      localStorage.setItem(EXPIRY_STORAGE_KEY, String(expiry));
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      localStorage.removeItem(EXPIRY_STORAGE_KEY);
    }
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
        this._persistToken(resp.access_token, Date.now() + (resp.expires_in * 1000));
      },
    });
  }

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
        this._persistToken(resp.access_token, Date.now() + (resp.expires_in * 1000));
        resolve(resp.access_token);
      };
      this.tokenClient.requestAccessToken({ prompt: '' });
    });
  }

  get isAuthenticated() {
    return Boolean(this.accessToken && Date.now() < (this.tokenExpiry || 0));
  }

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

  async driveList(query, fields = JOB_FILE_FIELDS, pageSize = 100) {
    const params = new URLSearchParams({
      q: query,
      fields,
      pageSize: String(pageSize),
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    const resp = await this.driveGet(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, 'Drive file list');
    const data = await resp.json();
    return data.files || [];
  }

  async fetchSpotifyLibrary(fileId) {
    const resp = await this.driveGet(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      'Spotify library file'
    );
    return await resp.json();
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
    if (blob.type && !blob.type.startsWith('audio/')) {
      throw new Error(`Drive file is not audio. Download returned ${blob.type}.`);
    }
    return blob;
  }

  async readJsonFile(fileId, label = 'Drive JSON file') {
    const resp = await this.driveGet(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, label);
    return await resp.json();
  }

  async listDownloadJobs(folderId) {
    const escapedFolder = escapeDriveQuery(folderId);
    const q = `name contains 'sisic-job-' and '${escapedFolder}' in parents and trashed=false`;
    const files = await this.driveList(q, JOB_FILE_FIELDS, 100);
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
    return jobs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async findDownloadJob(song, folderId) {
    const songKey = getSongKey(song);
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
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: JOB_MIME_TYPE }));
    form.append('file', new Blob([content], { type: JOB_MIME_TYPE }));
    const resp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,appProperties', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}` },
      body: form,
    });
    if (!resp.ok) {
      throw new Error(`Drive job create failed: ${resp.status} ${await resp.text()}`);
    }
    const file = await resp.json();
    return normalizeJob(job, file);
  }

  async requestSongDownload(songInput, folderId, sourceUrl = '') {
    const song = asSongRecord(songInput);
    const existing = await this.findDownloadJob(song, folderId);
    if (existing && ['queued', 'downloading', 'done'].includes(existing.status)) {
      return { queued: false, alreadyQueued: existing.status !== 'done', job: existing };
    }

    const now = new Date().toISOString();
    const job = {
      schemaVersion: 1,
      jobId: crypto.randomUUID(),
      songKey: song.songKey,
      track: song.track,
      artist: song.artist,
      album: song.album || '',
      expectedFilename: canonicalAudioFilename(song),
      status: 'queued',
      attempts: 0,
      lastError: '',
      createdAt: now,
      updatedAt: now,
      uploadedFileId: '',
      sourceUrl,
    };
    const created = await this.createJobFile(job, folderId);
    return { queued: true, alreadyQueued: false, job: created };
  }
}

export const driveService = new GoogleDriveService();
