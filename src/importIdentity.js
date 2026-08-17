export const SUPPORTED_AUDIO_EXTENSIONS = new Set(['aac', 'aiff', 'flac', 'm4a', 'mp3', 'ogg', 'opus', 'wav']);

export function extensionFor(fileName = '') {
  return String(fileName).split('.').pop()?.toLowerCase() || '';
}

export function isSupportedAudioFile(file) {
  return Boolean(file && SUPPORTED_AUDIO_EXTENSIONS.has(extensionFor(file.name)));
}

export function parseAudioFilename(fileName = '') {
  const stem = String(fileName).replace(/\.[^/.]+$/, '').trim();
  const separator = stem.indexOf(' - ');
  if (separator > 0) {
    return {
      artist: stem.slice(0, separator).trim() || 'Unknown Artist',
      track: stem.slice(separator + 3).trim() || stem,
    };
  }
  return { artist: 'Unknown Artist', track: stem || 'Untitled' };
}

export function fileSignature(file = {}) {
  return `${file.name || ''}:${file.size || 0}:${file.lastModified || 0}`;
}

export function dedupeFileList(files = []) {
  const seen = new Set();
  return files.filter(file => {
    const signature = fileSignature(file);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}
