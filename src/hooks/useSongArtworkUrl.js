import { useEffect, useState } from 'react';
import { defaultCoverFor } from '../assets/default-covers/index.js';

export function resizeArtworkUrl(url = '', size = 300) {
  if (!url || typeof url !== 'string' || url.startsWith('data:') || url.startsWith('blob:')) return url;
  const safeSize = Math.max(60, Math.round(Number(size) || 300));
  if (/\/\d+x\d+bb\./i.test(url)) {
    return url.replace(/\/\d+x\d+bb\./i, `/${safeSize}x${safeSize}bb.`);
  }
  if (url.includes('googleusercontent.com') || url.includes('drive.google.com')) {
    if (/=s\d+/i.test(url)) {
      return url.replace(/=s\d+/i, `=s${safeSize}`);
    }
    if (/=w\d+-h\d+/i.test(url)) {
      return url.replace(/=w\d+-h\d+/i, `=w${safeSize}-h${safeSize}`);
    }
    if (url.includes('googleusercontent.com') && !url.includes('=')) {
      return `${url}=s${safeSize}`;
    }
  }
  return url;
}

/**
 * Resolve a song's artwork URL once per consumer with shared defaultCover policy.
 */
export function useSongArtworkUrl(song, { size = 300, defaultCover = false } = {}) {
  const [fetchedArt, setFetchedArt] = useState(null);
  const [failedUrl, setFailedUrl] = useState('');
  const songKey = `${song?.songKey || song?.id || ''}:${song?.coverArtUrl || ''}`;

  useEffect(() => {
    let active = true;
    if (!song) return undefined;
    import('../services/artworkService.js')
      .then(({ getSongArtwork }) => getSongArtwork(song))
      .then(res => {
        if (!active || !res?.coverArtUrl) return;
        if (defaultCover && res.isProcedural) return;
        setFetchedArt({ key: songKey, url: res.coverArtUrl });
      })
      .catch(() => {});
    return () => { active = false; };
  }, [song, songKey, defaultCover]);

  const ownArt = defaultCover && String(song?.coverArtUrl || '').startsWith('data:image/svg+xml') ? '' : song?.coverArtUrl;
  const candidateUrl = resizeArtworkUrl((fetchedArt?.key === songKey ? fetchedArt.url : '') || ownArt, size);
  const activeUrl = candidateUrl && failedUrl !== candidateUrl ? candidateUrl : '';
  const src = activeUrl || (defaultCover ? defaultCoverFor(song) : '');
  const isDefaultCover = !activeUrl && Boolean(defaultCover);

  return {
    src,
    isDefaultCover,
    onError: () => {
      if (candidateUrl) setFailedUrl(candidateUrl);
    },
  };
}
