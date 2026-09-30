import { TEMPLATES } from './djCommentaryTemplates.js';

export { TEMPLATES };

function shortenName(name) {
  if (typeof name !== 'string' || name.length <= 28) return name;
  const truncated = name.slice(0, 28);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
}

function fillTemplate(template, facts) {
  let text = template.text;
  // Handle any ternary expression format {firstTime ? "A" : "B" + playCount}
  text = text.replace(/\{(\w+)\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)"(?:\s*\+\s*(\w+))?\}/g, (_, cond, ifTrue, ifFalse, extra) => {
    const val = facts[cond];
    if (val) return ifTrue;
    const add = extra && facts[extra] != null ? facts[extra] : '';
    return add ? (ifFalse.endsWith(' ') ? ifFalse + add : ifFalse + ' ' + add) : ifFalse;
  });

  const replacements = {
    artist: facts.artist ? shortenName(facts.artist) : '',
    title: facts.title ? shortenName(facts.title) : '',
    prevArtist: facts.prevArtist ? shortenName(facts.prevArtist) : '',
    prevTitle: facts.prevTitle ? shortenName(facts.prevTitle) : '',
    theme: facts.theme || '',
    count: facts.count != null ? facts.count : '',
    mood: facts.mood || '',
    tempoRelation: facts.tempoRelation || '',
    keyRelation: facts.keyRelation || '',
    playCount: facts.playCount != null ? facts.playCount : '',
    lastPlayedDaysAgo: facts.lastPlayedDaysAgo != null ? facts.lastPlayedDaysAgo : '',
    timeOfDay: facts.timeOfDay || '',
    firstTime: facts.firstTime ? 'first time' : '',
  };

  for (const [key, value] of Object.entries(replacements)) {
    text = text.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  return text;
}

export function commentaryFor(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) return null;

  const {
    kind,
    facts,
    memory = { recent: [] },
    rng = Math.random,
    templates = TEMPLATES,
  } = options;

  if (typeof kind !== 'string' || !['set-intro', 'link', 'callback'].includes(kind)) return null;
  if (typeof facts !== 'object' || facts === null || Array.isArray(facts)) return null;
  if (typeof memory !== 'object' || memory === null || Array.isArray(memory)) return null;
  if (typeof rng !== 'function') return null;
  if (!Array.isArray(templates)) return null;

  const recent = Array.isArray(memory.recent) ? memory.recent.slice(0, 12) : [];

  const eligible = templates.filter((t) => {
    if (!t || typeof t !== 'object') return false;
    if (t.kind !== kind) return false;
    if (!Array.isArray(t.needs)) return false;
    return t.needs.every((need) => {
      const val = facts[need];
      return val !== undefined && val !== null && val !== '';
    });
  });

  if (eligible.length === 0) return null;

  const nonRecent = eligible.filter((t) => !recent.includes(t.id));
  const pool = nonRecent.length > 0 ? nonRecent : eligible;

  const index = Math.floor(rng() * pool.length);
  const chosen = pool[index];

  const text = fillTemplate(chosen, facts);

  const newRecent = [chosen.id, ...recent].slice(0, 12);
  const newMemory = { ...memory, recent: newRecent };

  return { text, id: chosen.id, memory: newMemory };
}
