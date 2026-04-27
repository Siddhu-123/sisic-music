import { StrictMode } from 'react';
import { Component } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';

if ('serviceWorker' in navigator) {
  const appBase = new URL(import.meta.env.BASE_URL || './', window.location.href);
  const workerUrl = new URL('stream-sw.js', appBase);
  navigator.serviceWorker.register(workerUrl, { scope: appBase.pathname })
    .catch(error => console.warn('Drive stream worker registration failed:', error));
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
