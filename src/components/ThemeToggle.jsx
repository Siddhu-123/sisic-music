import { useCallback } from 'react';

export function ThemeToggle({ theme = 'light', onToggle, className = '' }) {
  const isDark = theme === 'dark';

  const handleKeyDown = useCallback((event) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      onToggle();
    }
  }, [onToggle]);

  return (
    <button
      type="button"
      className={`pixo-theme-toggle ${isDark ? 'pixo-theme-toggle--dark' : 'pixo-theme-toggle--light'} ${className}`.trim()}
      role="switch"
      aria-checked={isDark}
      aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
      onClick={onToggle}
      onKeyDown={handleKeyDown}
      title={`Switch to ${isDark ? 'light' : 'dark'} mode`}
    >
      <span className="pixo-toggle-track">
        {/* Night sky elements (twinkling stars) */}
        <span className="pixo-stars-layer" aria-hidden="true">
          <span className="pixo-star star-1" />
          <span className="pixo-star star-2" />
          <span className="pixo-star star-3" />
          <span className="pixo-star star-4" />
        </span>

        {/* Day sky elements (clouds) */}
        <span className="pixo-clouds-layer" aria-hidden="true">
          <span className="pixo-cloud cloud-1" />
          <span className="pixo-cloud cloud-2" />
        </span>

        {/* Celestial thumb (Sun gliding and morphing to Moon) */}
        <span className="pixo-thumb">
          {/* Radiating Sun Rays */}
          <svg className="pixo-sun-rays" viewBox="0 0 32 32" aria-hidden="true">
            <line x1="16" y1="2" x2="16" y2="5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="16" y1="27" x2="16" y2="30" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="2" y1="16" x2="5" y2="16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="27" y1="16" x2="30" y2="16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="6.1" y1="6.1" x2="8.2" y2="8.2" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="23.8" y1="23.8" x2="25.9" y2="25.9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="6.1" y1="25.9" x2="8.2" y2="23.8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="23.8" y1="8.2" x2="25.9" y2="6.1" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>

          {/* Celestial orb with crescent shadow & craters */}
          <span className="pixo-orb">
            <span className="pixo-craters" aria-hidden="true">
              <span className="pixo-crater crater-1" />
              <span className="pixo-crater crater-2" />
              <span className="pixo-crater crater-3" />
            </span>
          </span>
        </span>
      </span>
    </button>
  );
}
