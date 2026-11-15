import { Component, Fragment } from 'react';
import { RefreshCw, RotateCcw, X } from 'lucide-react';
import { isChunkLoadError } from '../utils/lazyWithRetry.js';

/**
 * Scoped error boundary for lazily-loaded views and modals so stale deployment
 * chunks or localized render failures recover cleanly without crashing the open app.
 */
export class AsyncBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, retryKey: 0 };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error(`AsyncBoundary (${this.props.label || 'view'}) caught error:`, error, info);
  }

  handleRetry = () => {
    this.setState(prev => ({ error: null, retryKey: prev.retryKey + 1 }));
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    const { error, retryKey } = this.state;
    const { label = 'this view', variant = 'inline', onDismiss, children } = this.props;

    if (!error) {
      return <Fragment key={retryKey}>{children}</Fragment>;
    }

    const chunkUpdate = isChunkLoadError(error);
    const title = chunkUpdate ? 'Update available' : `Could not open ${label}`;
    const description = chunkUpdate
      ? `Sisic Music was updated while this tab stayed open, so ${label} needs a quick reload.`
      : (error?.message || `Something went wrong while loading ${label}.`);

    const card = (
      <section
        className={`async-boundary ${variant === 'modal' ? 'async-boundary--modal' : 'async-boundary--inline'}`}
        role={variant === 'modal' ? 'dialog' : 'alert'}
        aria-modal={variant === 'modal' ? 'true' : undefined}
        aria-label={title}
        onClick={variant === 'modal' ? event => event.stopPropagation() : undefined}
      >
        <div className="async-boundary__head">
          <div>
            <span className="async-boundary__eyebrow">
              {chunkUpdate ? 'New version deployed' : 'Module recovery'}
            </span>
            <h2 className="async-boundary__title">{title}</h2>
          </div>
          {onDismiss && (
            <button
              type="button"
              className="icon-btn"
              onClick={onDismiss}
              aria-label={`Close ${label}`}
            >
              <X size={18} />
            </button>
          )}
        </div>
        <p className="async-boundary__message">{description}</p>
        <div className="async-boundary__actions">
          <button type="button" className="btn-primary async-boundary__btn" onClick={this.handleReload}>
            <RefreshCw size={15} />
            <span>Reload app</span>
          </button>
          <button type="button" className="panel-action-btn async-boundary__btn" onClick={this.handleRetry}>
            <RotateCcw size={15} />
            <span>Retry</span>
          </button>
          {onDismiss && (
            <button type="button" className="panel-action-btn async-boundary__btn" onClick={onDismiss}>
              <span>Dismiss</span>
            </button>
          )}
        </div>
      </section>
    );

    if (variant === 'modal') {
      return (
        <div className="modal-backdrop" role="presentation" onClick={onDismiss}>
          {card}
        </div>
      );
    }

    return card;
  }
}
