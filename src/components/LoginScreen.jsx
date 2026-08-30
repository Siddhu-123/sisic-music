import { Cloud, ExternalLink } from 'lucide-react';

export function LoginScreen({ onLogin, error, busy = false, setupStatus = {} }) {
  const missing = setupStatus.missing || [];
  return (
    <div className="login-screen">
      <div className="login-glow" />
      <div className="login-card">
        <div className="login-logo">
          <span className="login-logo__icon">♪</span>
        </div>
        <h1 className="login-title">Sisic Music</h1>
        <p className="login-sub">Your music. Everywhere. Offline.</p>
        <button className="btn-primary login-btn" onClick={onLogin} disabled={busy}>
          {busy ? 'Connecting…' : 'Sign in with Google'}
        </button>
        {error && <p className="login-error" role="alert">{error}</p>}
        <div className={`setup-card ${missing.length ? 'setup-card--needs-config' : 'setup-card--ready'}`}>
          <div className="setup-card__heading">
            <div>
              <span className="setup-card__eyebrow">First-time setup</span>
              <h2>{missing.length ? 'Connect your own Drive library' : 'Your site is configured'}</h2>
            </div>
            <span className="setup-card__status">
              {missing.length ? 'Needs setup' : 'Ready'}
            </span>
          </div>
          <p className="setup-card__copy">
            GitHub Pages hosts the interface only. Your music stays private in your Google Drive and is accessed after you authorize this site.
          </p>
          <ol className="setup-card__steps">
            <li>Create a Google Cloud OAuth web client and enable the Google Drive API.</li>
            <li>Add this GitHub Pages address as an authorized JavaScript origin.</li>
            <li>Build the site with the client ID, Drive folder ID, and library JSON file ID.</li>
          </ol>
          <div className="setup-card__links">
            <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
              Google Cloud credentials <ExternalLink size={13} />
            </a>
            <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer">
              Enable Drive API <ExternalLink size={13} />
            </a>
          </div>
          <p className="setup-card__permissions"><strong>Drive permission:</strong> the current browser flow requests read-only access so it can find the existing Spotify export, plus app-managed file access for Sisic indexes and downloads. The active token stays in this browser tab's session storage, is cleared when the tab closes, and is never stored in localStorage.</p>
          <p className="setup-card__automation"><strong>Automated:</strong> Google sign-in, Drive authorization, library sync, and offline downloads. <strong>One-time manual step:</strong> Google Cloud OAuth and the three build variables.</p>
          {missing.length > 0 && <p className="setup-card__missing">Missing from this build: {missing.join(', ')}</p>}
        </div>
        <p className="login-hint">Connect to your Google Drive music library</p>
      </div>
    </div>
  );
}
