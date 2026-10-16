import { useState } from 'react';
import { emptyGemmaServiceStatus, gemmaServiceStatusText, getGemmaServiceConfig, runSavedGemmaServiceSync, saveGemmaServiceConfig } from '../services/gemmaServiceConfig.js';
import { syncGemmaVectorsFromService } from '../services/gemmaVectors.js';

export function GemmaServicePanel({ librarySongs = [], onSynced, status: externalStatus, onStatusChange, onConfigChange }) {
  const [config, setConfig] = useState(() => getGemmaServiceConfig() || { baseUrl: '', token: '' });
  const [busy, setBusy] = useState(false);
  const [localStatus, setLocalStatus] = useState(emptyGemmaServiceStatus);
  const status = externalStatus || localStatus;
  const updateStatus = value => {
    setLocalStatus(value);
    onStatusChange?.(value);
  };

  const save = () => {
    const saved = saveGemmaServiceConfig(config);
    if (!saved) {
      updateStatus({ ...status, error: 'Could not save settings on this device.' });
      return;
    }
    setConfig(saved);
    updateStatus({ ...status, error: '' });
    onConfigChange?.();
  };

  const clearToken = () => {
    const next = { ...config, token: '' };
    const saved = saveGemmaServiceConfig(next);
    setConfig(saved || next);
    updateStatus({ ...status, error: saved ? '' : 'Could not clear the token on this device.' });
    onConfigChange?.();
  };

  const sync = async () => {
    setBusy(true);
    try {
      const next = await runSavedGemmaServiceSync({ librarySongs, onSynced, sync: syncGemmaVectorsFromService });
      updateStatus(next);
    } catch (error) {
      updateStatus({ ...status, error: error?.message || 'Sync failed.' });
    } finally {
      setBusy(false);
    }
  };

  return <section className="gemma-service-panel" aria-label="EmbeddingGemma service sync">
    <strong>EmbeddingGemma service</strong>
    <label className="gemma-service-panel__field">
      Service base URL
      <input type="url" autoComplete="url" value={config.baseUrl} onChange={event => setConfig(current => ({ ...current, baseUrl: event.target.value }))} />
    </label>
    <label className="gemma-service-panel__field">
      Bearer token
      <input type="password" autoComplete="off" value={config.token} onChange={event => setConfig(current => ({ ...current, token: event.target.value }))} />
    </label>
    <div className="panel-actions">
      <button type="button" className="panel-action-btn" onClick={save}>Save</button>
      <button type="button" className="panel-action-btn panel-action-btn--primary" onClick={sync} disabled={busy}>{busy ? 'Syncing…' : 'Sync vectors now'}</button>
      <button type="button" className="panel-action-btn" onClick={clearToken}>Clear token</button>
    </div>
    <p className="gemma-service-panel__status" role="status" aria-live="polite">{gemmaServiceStatusText(status)}</p>
  </section>;
}
