import { useMemo, useState } from 'react';
import { Sliders, X, RotateCcw, Save, Trash2 } from 'lucide-react';
import { EQ_FREQUENCIES, EQ_PRESETS } from '../services/audioGraph.js';
import {
  EQ_CURVE_FREQUENCIES,
  EQ_GAIN_STEP,
  EQ_MAX_GAIN,
  EQ_MIN_GAIN,
  eqResponseDb,
  headroomDb,
} from '../services/eqMath.js';
import {
  MAX_PRESET_NAME,
  loadUserPresets,
  persistUserPresets,
  removeUserPreset,
  sameGains,
  upsertUserPreset,
} from '../services/eqUserPresets.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';

// The curve is drawn over +-15 dB so a +12 dB slider never touches the frame.
const CURVE_RANGE_DB = 15;
const CURVE_W = 600;
const CURVE_H = 160;
const LOG_SPAN = Math.log(EQ_CURVE_FREQUENCIES.at(-1) / EQ_CURVE_FREQUENCIES[0]);

const xFor = frequency => (Math.log(frequency / EQ_CURVE_FREQUENCIES[0]) / LOG_SPAN) * CURVE_W;
const yFor = db => (CURVE_H / 2) - ((Math.max(-CURVE_RANGE_DB, Math.min(CURVE_RANGE_DB, db)) / CURVE_RANGE_DB) * (CURVE_H / 2));
const percentX = frequency => `${(xFor(frequency) / CURVE_W) * 100}%`;
const percentY = db => `${(yFor(db) / CURVE_H) * 100}%`;

const shortFrequency = hz => (hz >= 1000 ? `${hz / 1000}k` : `${hz}`);
const longFrequency = hz => (hz >= 1000 ? `${hz / 1000} kilohertz` : `${hz} hertz`);
const formatGain = gain => `${gain > 0 ? '+' : ''}${gain.toFixed(1)}`;

function safeStorage() {
  try { return window.localStorage; } catch { return undefined; }
}

function ResponseCurve({ response, bandDb, enabled }) {
  const points = response.map((db, index) => `${xFor(EQ_CURVE_FREQUENCIES[index]).toFixed(1)},${yFor(db).toFixed(1)}`);
  const line = `M${points.join(' L')}`;
  const area = `${line} L${CURVE_W},${CURVE_H / 2} L0,${CURVE_H / 2} Z`;
  return (
    <div className={`eq-curve ${enabled ? '' : 'eq-curve--off'}`}>
      <div className="eq-curve__plot">
        <svg className="eq-curve__svg" viewBox={`0 0 ${CURVE_W} ${CURVE_H}`} preserveAspectRatio="none" role="img" aria-label="Frequency response of the current equalizer settings">
          {[-12, -6, 6, 12].map(db => <line key={db} className="eq-curve__grid" x1="0" x2={CURVE_W} y1={yFor(db)} y2={yFor(db)} />)}
          {[100, 1000, 10000].map(hz => <line key={hz} className="eq-curve__grid" y1="0" y2={CURVE_H} x1={xFor(hz)} x2={xFor(hz)} />)}
          <line className="eq-curve__zero" x1="0" x2={CURVE_W} y1={CURVE_H / 2} y2={CURVE_H / 2} />
          <path className="eq-curve__area" d={area} />
          <path className="eq-curve__line" d={line} />
        </svg>
        {EQ_FREQUENCIES.map((hz, index) => (
          <span key={hz} className="eq-curve__dot" style={{ left: percentX(hz), top: percentY(bandDb[index]) }} aria-hidden="true" />
        ))}
        {[12, 0, -12].map(db => <span key={db} className="eq-curve__label eq-curve__label--y" style={{ top: percentY(db) }} aria-hidden="true">{db > 0 ? `+${db}` : db}</span>)}
        {[[100, '100'], [1000, '1k'], [10000, '10k']].map(([hz, label]) => <span key={hz} className="eq-curve__label eq-curve__label--x" style={{ left: percentX(hz) }} aria-hidden="true">{label}</span>)}
      </div>
    </div>
  );
}

export function EqualizerModal({ isOpen, onClose, eqPreset, eqGains, eqEnabled = true, onSetPreset, onSetGain, onSetGains, onSetEnabled }) {
  const dialogRef = useDialogFocus(isOpen, onClose);
  const [userPresets, setUserPresets] = useState(() => loadUserPresets(safeStorage()));
  const [saving, setSaving] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [message, setMessage] = useState('');

  const gains = useMemo(() => EQ_FREQUENCIES.map((_, index) => eqGains[index] ?? 0), [eqGains]);
  const response = useMemo(() => eqResponseDb(gains), [gains]);
  const bandDb = useMemo(() => eqResponseDb(gains, EQ_FREQUENCIES), [gains]);
  const cutDb = useMemo(() => headroomDb(gains), [gains]);

  if (!isOpen) return null;

  const updatePresets = next => {
    setUserPresets(next);
    persistUserPresets(safeStorage(), next);
  };
  const savePreset = event => {
    event.preventDefault();
    const result = upsertUserPreset(userPresets, presetName, gains);
    if (result.error) { setMessage(result.error); return; }
    updatePresets(result.presets);
    setSaving(false);
    setPresetName('');
    setMessage(`Saved "${result.saved.name}".`);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal-content equalizer-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="equalizer-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-title-row">
            <Sliders className="modal-icon" size={20} />
            <h2 id="equalizer-title" className="modal-title">Audio Equalizer</h2>
          </div>
          <button type="button" className="neumorphic-button neumorphic-button--icon" onClick={onClose} aria-label="Close Equalizer">
            <X size={18} />
          </button>
        </div>

        <div className="eq-toolbar">
          <button
            type="button"
            role="switch"
            aria-checked={eqEnabled}
            className={`eq-switch ${eqEnabled ? 'eq-switch--on' : ''}`}
            onClick={() => onSetEnabled?.(!eqEnabled)}
          >
            <span className="eq-switch__track" aria-hidden="true"><span className="eq-switch__thumb" /></span>
            <span>{eqEnabled ? 'Equalizer on' : 'Equalizer off'}</span>
          </button>
          <p className="eq-headroom" role="status">
            {!eqEnabled
              ? 'Bypassed: audio passes through unchanged. Your settings are kept.'
              : cutDb < 0
                ? <>Headroom <strong>{cutDb.toFixed(1)} dB</strong>. Turned down automatically so boosts can&apos;t clip.</>
                : 'No boost, so no headroom is needed.'}
          </p>
        </div>

        <ResponseCurve response={response} bandDb={bandDb} enabled={eqEnabled} />

        <div className="equalizer-presets">
          <span className="equalizer-label" id="eq-presets-label">Presets</span>
          <div className="preset-buttons-grid" role="group" aria-labelledby="eq-presets-label">
            {Object.entries(EQ_PRESETS).map(([key, preset]) => (
              <button
                key={key}
                type="button"
                className={`preset-button ${eqPreset === key ? 'preset-button--active' : ''}`}
                aria-pressed={eqPreset === key}
                onClick={() => onSetPreset(key)}
              >
                {preset.name}
              </button>
            ))}
            {userPresets.map(preset => {
              const active = eqPreset === 'custom' && sameGains(preset.gains, gains);
              return (
                <span key={preset.name} className={`preset-button preset-button--user ${active ? 'preset-button--active' : ''}`}>
                  <button type="button" className="preset-button__apply" aria-pressed={active} onClick={() => onSetGains?.(preset.gains)}>{preset.name}</button>
                  <button
                    type="button"
                    className="preset-button__delete"
                    aria-label={`Delete preset ${preset.name}`}
                    onClick={() => { updatePresets(removeUserPreset(userPresets, preset.name)); setMessage(`Deleted "${preset.name}".`); }}
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              );
            })}
            {!saving && (
              <button type="button" className="preset-button preset-button--add" onClick={() => { setSaving(true); setMessage(''); }}>
                <Save size={13} /> Save current
              </button>
            )}
          </div>
          {saving && (
            <form className="eq-save-form" onSubmit={savePreset}>
              <input
                type="text"
                value={presetName}
                maxLength={MAX_PRESET_NAME}
                onChange={event => setPresetName(event.target.value)}
                placeholder="Name this preset"
                aria-label="Preset name"
                autoFocus
              />
              <button type="submit" className="neumorphic-button neumorphic-button--primary">Save</button>
              <button type="button" className="neumorphic-button" onClick={() => { setSaving(false); setMessage(''); }}>Cancel</button>
            </form>
          )}
          {message && <p className="eq-message" role="status">{message}</p>}
        </div>

        <div className={`equalizer-sliders-container ${eqEnabled ? '' : 'equalizer-sliders-container--off'}`}>
          {EQ_FREQUENCIES.map((freq, index) => {
            const gain = gains[index];
            return (
              <div key={freq} className="eq-band">
                <span className="eq-gain-label">{formatGain(gain)}</span>
                <div className="eq-slider-track">
                  <input
                    type="range"
                    min={EQ_MIN_GAIN}
                    max={EQ_MAX_GAIN}
                    step={EQ_GAIN_STEP}
                    value={gain}
                    onChange={(e) => onSetGain(index, Number(e.target.value))}
                    className="eq-slider vertical"
                    aria-label={`${longFrequency(freq)} band gain`}
                    aria-orientation="vertical"
                    aria-valuetext={`${formatGain(gain)} decibels`}
                  />
                </div>
                <span className="eq-freq-label">{shortFrequency(freq)}</span>
              </div>
            );
          })}
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="neumorphic-button"
            onClick={() => onSetPreset('flat')}
          >
            <RotateCcw size={15} style={{ marginRight: '6px' }} />
            Reset to Flat
          </button>
          <button
            type="button"
            className="neumorphic-button neumorphic-button--primary"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
