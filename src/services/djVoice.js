export const PREFERRED_VOICE_NAMES = /Samantha|Daniel|Google UK English|Aria|Jenny|Serena|Karen/;

export function pickVoice(voices) {
  if (!Array.isArray(voices) || voices.length === 0) return null;
  const isEn = v => typeof v?.lang === 'string' && v.lang.toLowerCase().startsWith('en');
  const matchesName = v => PREFERRED_VOICE_NAMES.test(v?.name || '');

  // 1. prefer localService voices with lang starting en
  const localEn = voices.filter(v => Boolean(v?.localService) && isEn(v));
  if (localEn.length > 0) {
    return localEn.find(matchesName) || localEn[0];
  }

  // 2. then names matching /Samantha|Daniel|Google UK English|Aria|Jenny|Serena|Karen/
  const named = voices.find(matchesName);
  if (named) return named;

  // 3. then any en
  const anyEn = voices.find(isEn);
  if (anyEn) return anyEn;

  // 4. else the default
  return voices.find(v => Boolean(v?.default)) || voices[0] || null;
}

export function countWords(text) {
  const trimmed = String(text ?? '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function createDjVoice({
  speech = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
  duck = () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  let currentSession = null;

  return {
    get available() {
      return Boolean(speech && typeof speech.speak === 'function' && Utterance);
    },

    get busy() {
      return Boolean(currentSession);
    },

    speak(text, { rate = 1.02, volume = 1 } = {}) {
      if (!speech || typeof speech.speak !== 'function' || !Utterance) {
        return Promise.resolve('unavailable');
      }

      if (currentSession) {
        currentSession.cancel('cancelled');
      }

      const textStr = String(text ?? '');
      let utterance;
      try {
        utterance = new Utterance(textStr);
      } catch {
        return Promise.resolve('unavailable');
      }

      utterance.rate = Number.isFinite(Number(rate)) ? Number(rate) : 1.02;
      utterance.volume = Number.isFinite(Number(volume)) ? Number(volume) : 1;

      try {
        const voices = speech.getVoices?.() || [];
        const voice = pickVoice(voices);
        if (voice) utterance.voice = voice;
      } catch {
        /* voice enumeration failed */
      }

      return new Promise(resolve => {
        let settled = false;
        let ducked = false;
        let timeoutId = null;

        const duckDown = () => {
          if (!ducked && !settled) {
            ducked = true;
            try {
              duck(-12, 0.3);
            } catch {
              /* audio ducking failed */
            }
          }
        };

        const duckUp = () => {
          if (ducked) {
            ducked = false;
            try {
              duck(0, 0.5);
            } catch {
              /* audio restore failed */
            }
          }
        };

        const finish = (result) => {
          if (settled) return;
          settled = true;
          if (timeoutId !== null) {
            clearTimeoutFn(timeoutId);
            timeoutId = null;
          }
          duckUp();
          if (currentSession === session) {
            currentSession = null;
          }
          resolve(result);
        };

        const session = {
          cancel(reason = 'cancelled') {
            if (settled) return;
            try {
              speech.cancel?.();
            } catch {
              /* speech cancel failed */
            }
            finish(reason);
          },
        };
        currentSession = session;

        utterance.onstart = () => {
          duckDown();
        };

        utterance.onend = () => {
          finish('done');
        };

        utterance.onerror = (event) => {
          if (event?.error === 'canceled' || event?.error === 'interrupted') {
            finish('cancelled');
          } else {
            finish('done');
          }
        };

        const words = countWords(textStr);
        const timeoutSeconds = words * 0.55 + 3;
        const timeoutMs = Math.round(timeoutSeconds * 1000);

        timeoutId = setTimeoutFn(() => {
          try {
            speech.cancel?.();
          } catch {
            /* speech cancel failed */
          }
          finish('done');
        }, timeoutMs);

        try {
          speech.speak(utterance);
        } catch {
          finish('unavailable');
        }
      });
    },

    cancel() {
      if (currentSession) {
        currentSession.cancel('cancelled');
      }
    },
  };
}
