import { useEffect, useState } from 'react';

function resizeArtworkUrl(url = '', size = 300) {
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return url;
  const safeSize = Math.max(60, Math.round(Number(size) || 300));
  return url.replace(/\/\d+x\d+bb\./i, `/${safeSize}x${safeSize}bb.`);
}

export function AsyncArtworkImage({ song, className = '', fallbackSize = 24, alt = '', size = 300, sizes, priority = false }) {
  const [fetchedArtUrl, setFetchedArtUrl] = useState('');

  useEffect(() => {
    let active = true;
    if (!song) return undefined;
    import('../services/artworkService.js')
      .then(({ getSongArtwork }) => getSongArtwork(song))
      .then(res => {
        if (active && res?.coverArtUrl) setFetchedArtUrl(res.coverArtUrl);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [song]);

  const artUrl = resizeArtworkUrl(fetchedArtUrl || song?.coverArtUrl, size);
  const hue = song?.track ? song.track.charCodeAt(0) % 360 : 200;

  if (artUrl) {
    return (
      <img
        src={artUrl}
        alt={alt || `${song?.track || 'Song'} cover`}
        className={className}
        width={size}
        height={size}
        sizes={sizes}
        loading={priority ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : 'low'}
        decoding="async"
      />
    );
  }

  return (
    <div
      className={`${className} artwork-fallback`}
      role="img"
      aria-label={alt || `${song?.track || 'Song'} cover placeholder`}
      style={{ background: `linear-gradient(135deg, hsl(${hue}, 70%, 35%), hsl(${(hue + 60) % 360}, 70%, 20%))` }}
    >
      <span style={{ fontSize: `${fallbackSize}px` }}>♪</span>
    </div>
  );
}
