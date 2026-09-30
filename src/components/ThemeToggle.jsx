import { useCallback } from 'react';

const STAR_PATHS = [
  'M26.0525 1.65414C25.1407 1.65414 24.75 1.15789 24.75 0C24.75 1.15789 24.4242 1.65414 23.4473 1.65414C24.4242 1.65414 24.75 2.15038 24.75 3.47368C24.75 2.15038 25.1407 1.65414 26.0525 1.65414Z',
  'M25.1841 15.5489C23.9683 15.5489 23.4475 15.0527 23.4475 13.8948C23.4474 15.0527 23.013 15.5489 21.7104 15.5489C23.013 15.5489 23.4474 16.0452 23.4474 17.3685C23.4474 16.0452 23.9683 15.5489 25.1841 15.5489Z',
  'M13.8948 4.21802C12.3751 4.21802 11.724 3.47366 11.724 1.73682C11.7239 3.47366 11.1809 4.21802 9.55273 4.21802C11.1809 4.21802 11.7239 4.96238 11.7239 6.94734C11.7239 4.96238 12.3751 4.21802 13.8948 4.21802Z',
  'M4.34211 20.718C2.82237 20.718 2.17129 19.9737 2.17129 18.2368C2.1712 19.9737 1.6282 20.718 0 20.718C1.62821 20.718 2.17121 21.4624 2.17121 23.4473C2.17121 21.4624 2.82237 20.718 4.34211 20.718Z',
  'M30.3948 30.2706C28.8751 30.2706 28.224 29.5263 28.224 27.7894C28.2239 29.5263 27.6809 30.2706 26.0527 30.2706C27.6809 30.2706 28.2239 31.015 28.2239 33C28.2239 31.015 28.8751 30.2706 30.3948 30.2706Z',
  'M11.2894 27.2519C9.76963 27.2519 9.11855 26.6316 9.11855 25.1842C9.11847 26.6316 8.57546 27.2519 6.94727 27.2519C8.57548 27.2519 9.11848 27.8722 9.11848 29.5263C9.11848 27.8722 9.76963 27.2519 11.2894 27.2519Z',
  'M13.8948 18.609C12.983 18.609 12.5923 18.2368 12.5923 17.3684C12.5923 18.2368 12.2665 18.609 11.2896 18.609C12.2665 18.609 12.5923 18.9812 12.5923 19.9737C12.5923 18.9812 12.983 18.609 13.8948 18.609Z',
  'M18.2368 30.767C17.6289 30.767 17.3685 30.3948 17.3685 29.5264C17.3685 30.3948 17.1513 30.767 16.5 30.767C17.1513 30.767 17.3685 31.1391 17.3685 32.1316C17.3685 31.1391 17.6289 30.767 18.2368 30.767Z',
  'M6.94755 11.6616C6.03571 11.6616 5.64506 11.2894 5.64506 10.421C5.645 11.2894 5.3192 11.6616 4.34229 11.6616C5.31921 11.6616 5.64501 12.0338 5.64501 13.0263C5.64501 12.0338 6.03571 11.6616 6.94755 11.6616Z',
];

const CLOUD_PATH = 'M10.7143 15.6406C9.42857 13.9263 1.36735e-06 15.6406 2.00431e-06 22.9266L58.7903 22.9266C60.1901 22.9266 62.2236 10.1139 52.7913 3.1821C42.9181 -4.07363 30.4286 1.92631 28.7143 12.6406C19.7143 4.49774 10.7143 11.7835 10.7143 15.6406Z';

export function ThemeToggle({ theme = 'light', onToggle, className = '' }) {
  const isDark = theme === 'dark';

  const handleKeyDown = useCallback(
    (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onToggle?.();
      }
    },
    [onToggle]
  );

  return (
    <div
      className={`${isDark ? 'themeicon' : 'themeicon1'} ${className}`.trim()}
      onClick={onToggle}
      onKeyDown={handleKeyDown}
      role="switch"
      aria-checked={isDark}
      aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
      tabIndex={0}
    >
      {isDark ? (
        <>
          <svg
            className="stars"
            height="2rem"
            viewBox="0 0 31 33"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            {STAR_PATHS.map((path, index) => (
              <path key={index} d={path} fill="#D9D9D9" />
            ))}
          </svg>

          <svg
            className="cloud"
            height="1.6rem"
            viewBox="0 0 60 23"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path d={CLOUD_PATH} fill="white" />
          </svg>
        </>
      ) : (
        <>
          <svg
            className="stars"
            width="31"
            height="33"
            viewBox="0 0 31 33"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            {STAR_PATHS.map((path, index) => (
              <path key={index} d={path} fill="#D9D9D9" />
            ))}
          </svg>

          <svg
            className="cloud"
            width="60"
            height="23"
            viewBox="0 0 60 23"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path d={CLOUD_PATH} fill="white" />
          </svg>
        </>
      )}

      <div className="circles" />

      <div className="circle">
        <div className="c1" />
        <div className="c2" />
        <div className="c3" />
      </div>
    </div>
  );
}

export default ThemeToggle;
