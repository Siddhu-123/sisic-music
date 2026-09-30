// User-saved equalizer presets, kept in the browser's local storage. Storage is
// untrusted input (it can be edited, truncated or written by an older version), so
// everything read back is validated and clamped before it reaches the UI.

import { EQ_FREQUENCIES, clampGain } from './eqMath.js';

export const EQ_USER_PRESETS_KEY = 'sisic:eq-user-presets:v1';
export const MAX_USER_PRESETS = 12;
export const MAX_PRESET_NAME = 24;

export function cleanPresetName(value) {
  return String(value ?? '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_PRESET_NAME);
}

/** Validates whatever was stored; returns only well-formed presets (ids are regenerated from names). */
export function sanitizeUserPresets(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const presets = [];
  for (const item of value) {
    const name = cleanPresetName(item?.name);
    if (!name || !Array.isArray(item?.gains) || item.gains.length !== EQ_FREQUENCIES.length) continue;
    if (!item.gains.every(gain => typeof gain === 'number' && Number.isFinite(gain))) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    presets.push({ name, gains: item.gains.map(clampGain) });
    if (presets.length >= MAX_USER_PRESETS) break;
  }
  return presets;
}

export function loadUserPresets(storage) {
  try {
    const raw = storage?.getItem(EQ_USER_PRESETS_KEY);
    return raw ? sanitizeUserPresets(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function persistUserPresets(storage, presets) {
  try {
    storage?.setItem(EQ_USER_PRESETS_KEY, JSON.stringify(presets));
    return true;
  } catch {
    return false; // full or disabled storage must never break the equalizer
  }
}

/** Adds a preset, or replaces one with the same name (case-insensitive). */
export function upsertUserPreset(presets, name, gains) {
  const cleaned = cleanPresetName(name);
  if (!cleaned) return { presets, error: 'Give the preset a name.' };
  const entry = sanitizeUserPresets([{ name: cleaned, gains }])[0];
  if (!entry) return { presets, error: 'Those settings could not be saved.' };
  const existing = presets.findIndex(preset => preset.name.toLowerCase() === cleaned.toLowerCase());
  if (existing < 0 && presets.length >= MAX_USER_PRESETS) return { presets, error: `You can keep up to ${MAX_USER_PRESETS} presets. Delete one first.` };
  const next = existing < 0 ? [...presets, entry] : presets.map((preset, index) => (index === existing ? entry : preset));
  return { presets: next, saved: entry };
}

export function removeUserPreset(presets, name) {
  return presets.filter(preset => preset.name.toLowerCase() !== String(name).toLowerCase());
}

export const sameGains = (a, b) => a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) < 0.001);
