import { StrictMode } from 'react';
import { Component } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';

const appBasePath = new URL(import.meta.env.BASE_URL, window.location.origin).pathname;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then(registrations => Promise.all(
      registrations
        .filter(registration => registration.scope.includes(appBasePath))
        .map(registration => registration.unregister())
    ))
    .catch(error => console.warn('Service worker cleanup failed:', error));
}

if ('caches' in window) {
  caches.keys()
    .then(keys => Promise.all(
      keys
        .filter(key => key.includes('sisic') || key.includes('sisic-music') || key.includes(appBasePath))
        .map(key => caches.delete(key))
    ))
    .catch(error => console.warn('Cache cleanup failed:', error));
}

class RootErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('App crashed:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="root-error" role="alert">
          <h1>Sisic Music could not start</h1>
          <p>{this.state.error.message || 'A browser error stopped the app from loading.'}</p>
        </main>
      );
    }

    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
