import { memo, useEffect, useState } from 'react';

function resizeArtworkUrl(url = '', size = 300) {
  if (!url || typeof url !== 'string' || url.startsWith('data:') || url.startsWith('blob:')) return url;
  const safeSize = Math.max(60, Math.round(Number(size) || 300));
  // Apple / iTunes: /600x600bb.jpg -> /240x240bb.jpg
  if (/\/\d+x\d+bb\./i.test(url)) {
    return url.replace(/\/\d+x\d+bb\./i, `/${safeSize}x${safeSize}bb.`);
  }
  // Google User Content / Drive thumbnail: =s600 or =w600-h600
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

export const AsyncArtworkImage = memo(function AsyncArtworkImage({
  song,
  className = '',
  fallbackSize = 24,
  alt = '',
  size = 300,
  sizes,
  priority = false,
}) {
  const [fetchedArt, setFetchedArt] = useState(null);
  const [failedUrl, setFailedUrl] = useState('');
  const songKey = `${song?.songKey || song?.id || ''}:${song?.coverArtUrl || ''}`;

  useEffect(() => {
    let active = true;
    if (!song) return undefined;
    import('../services/artworkService.js')
      .then(({ getSongArtwork }) => getSongArtwork(song))
      .then(res => {
        if (active && res?.coverArtUrl) setFetchedArt({ key: songKey, url: res.coverArtUrl });
      })
      .catch(() => {});
    return () => { active = false; };
  }, [song, songKey]);

  const artUrl = resizeArtworkUrl((fetchedArt?.key === songKey ? fetchedArt.url : '') || song?.coverArtUrl, size);
  const hue = song?.track ? song.track.charCodeAt(0) % 360 : 200;

  if (artUrl && failedUrl !== artUrl) {
    return (
      <img
        src={artUrl}
        onError={() => setFailedUrl(artUrl)}
        alt={alt || `${song?.track || 'Song'} cover`}
        className={className}
        width={size}
        height={size}
        sizes={sizes}
        style={{ aspectRatio: '1 / 1', objectFit: 'cover' }}
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
      style={{
        aspectRatio: '1 / 1',
        background: `linear-gradient(135deg, hsl(${hue}, 70%, 35%), hsl(${(hue + 60) % 360}, 70%, 20%))`,
      }}
    >
      <span style={{ fontSize: `${fallbackSize}px` }}>♪</span>
    </div>
  );
});
