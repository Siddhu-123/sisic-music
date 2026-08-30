import React from 'react';
import { Sliders, X, RotateCcw } from 'lucide-react';
import { EQ_FREQUENCIES, EQ_PRESETS } from '../services/audioGraph.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';

export function EqualizerModal({ isOpen, onClose, eqPreset, eqGains, onSetPreset, onSetGain }) {
  const dialogRef = useDialogFocus(isOpen, onClose);

  if (!isOpen) return null;

  const formatFrequency = (hz) => {
    return hz >= 1000 ? `${(hz / 1000).toFixed(1).replace('.0', '')}kHz` : `${hz}Hz`;
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

        <div className="equalizer-presets">
          <label className="equalizer-label">Presets</label>
          <div className="preset-buttons-grid">
            {Object.entries(EQ_PRESETS).map(([key, preset]) => (
              <button
                key={key}
                type="button"
                className={`preset-button ${eqPreset === key ? 'preset-button--active' : ''}`}
                onClick={() => onSetPreset(key)}
              >
                {preset.name}
              </button>
            ))}
          </div>
        </div>

        <div className="equalizer-sliders-container">
          {EQ_FREQUENCIES.map((freq, index) => {
            const gain = eqGains[index] ?? 0;
            return (
              <div key={freq} className="eq-band">
                <span className="eq-gain-label">{gain > 0 ? `+${gain}dB` : `${gain}dB`}</span>
                <div className="eq-slider-track">
                  <input
                    type="range"
                    min="-12"
                    max="12"
                    step="1"
                    value={gain}
                    onChange={(e) => onSetGain(index, Number(e.target.value))}
                    className="eq-slider vertical"
                    aria-label={`${formatFrequency(freq)} band gain`}
                  />
                </div>
                <span className="eq-freq-label">{formatFrequency(freq)}</span>
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
