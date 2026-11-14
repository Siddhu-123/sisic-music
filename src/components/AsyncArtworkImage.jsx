import { memo } from 'react';
import { useSongArtworkUrl } from '../hooks/useSongArtworkUrl.js';

export const AsyncArtworkImage = memo(function AsyncArtworkImage({
  song,
  className = '',
  fallbackSize = 24,
  alt = '',
  size = 300,
  sizes,
  priority = false,
  defaultCover = false,
}) {
  const { src, isDefaultCover, onError } = useSongArtworkUrl(song, { size, defaultCover });
  const hue = song?.track ? song.track.charCodeAt(0) % 360 : 200;

  if (src) {
    return (
      <img
        src={src}
        onError={isDefaultCover ? undefined : onError}
        alt={alt || `${song?.track || 'Song'} cover${isDefaultCover ? ' placeholder' : ''}`}
        className={isDefaultCover ? `${className} artwork-default-cover` : className}
        width={size}
        height={size}
        sizes={isDefaultCover ? undefined : sizes}
        style={{ aspectRatio: '1 / 1', objectFit: 'cover' }}
        loading={priority ? 'eager' : 'lazy'}
        fetchPriority={priority && !isDefaultCover ? 'high' : 'low'}
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
