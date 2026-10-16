import { createInfiniteMix } from './mixEngine.js';

let activeRadio = null;

export function startRadio(ctx, seedKey) {
  stopRadio();
  const generator = createInfiniteMix(ctx, { seedKey });
  const seed = (ctx?.songs || []).find(song => (song.songKey || song.id) === seedKey);
  const songs = seed ? [seed] : [];
  while (songs.length < 50) {
    const song = generator.next();
    if (!song) break;
    songs.push(song);
  }
  const radio = {
    next: () => generator.next(),
    observe: event => generator.observe(event),
    stop() { if (activeRadio === radio) activeRadio = null; },
  };
  activeRadio = radio;
  return { songs };
}

export function getActiveRadio() {
  return activeRadio;
}

export function stopRadio() {
  const radio = activeRadio;
  activeRadio = null;
  return Boolean(radio);
}
