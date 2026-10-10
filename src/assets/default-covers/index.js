import cottage from './cottage.jpg';
import dusk from './dusk.svg';
import ocean from './ocean.svg';
import aurora from './aurora.svg';
import vinyl from './vinyl.svg';

const covers = [cottage, dusk, ocean, aurora, vinyl];

export function defaultCoverFor(song) {
  const key = String(song?.songKey || song?.id || song?.track || '');
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return covers[Math.abs(hash) % covers.length];
}
