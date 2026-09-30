import test from 'node:test';
import assert from 'node:assert/strict';
import { createDjVoice, pickVoice, countWords } from './djVoice.js';

class FakeUtterance {
  constructor(text) {
    this.text = text;
    this.rate = 1;
    this.volume = 1;
    this.voice = null;
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
  }
}

class FakeSpeech {
  constructor(voices = []) {
    this.voices = voices;
    this.utterances = [];
    this.cancelCalls = 0;
  }
  getVoices() {
    return this.voices;
  }
  speak(utterance) {
    this.utterances.push(utterance);
  }
  cancel() {
    this.cancelCalls += 1;
  }
  get lastUtterance() {
    return this.utterances.at(-1);
  }
}

test('pickVoice follows voice choice order: localService en, then named regex, then any en, else default', () => {
  assert.equal(pickVoice([]), null);
  assert.equal(pickVoice(null), null);

  const defaultVoice = { name: 'Generic', lang: 'fr', default: true };
  const genericNonDefault = { name: 'Other', lang: 'fr', default: false };
  assert.equal(pickVoice([genericNonDefault, defaultVoice]), defaultVoice);

  const frenchEn = { name: 'Any English', lang: 'en-US' };
  assert.equal(pickVoice([defaultVoice, frenchEn]), frenchEn);

  const nonLocalSamantha = { name: 'Samantha', lang: 'en-US', localService: false };
  const otherEn = { name: 'Other', lang: 'en-US', localService: false };
  assert.equal(pickVoice([otherEn, nonLocalSamantha]), nonLocalSamantha);

  const localOther = { name: 'Alex', lang: 'en-US', localService: true };
  assert.equal(pickVoice([nonLocalSamantha, localOther]), localOther, 'localService en preferred over non-local named');

  const localDaniel = { name: 'Daniel', lang: 'en-GB', localService: true };
  assert.equal(pickVoice([localOther, localDaniel]), localDaniel, 'named local en preferred among local en');
});

test('countWords handles empty, whitespace, and normal sentences', () => {
  assert.equal(countWords(''), 0);
  assert.equal(countWords('   '), 0);
  assert.equal(countWords('hello world'), 2);
  assert.equal(countWords('  up   next is   a classic track  '), 6);
});

test('unavailable speech resolves unavailable and never ducks', async () => {
  const duckCalls = [];
  const voice = createDjVoice({
    speech: null,
    Utterance: FakeUtterance,
    duck: (db, s) => duckCalls.push([db, s]),
  });

  assert.equal(voice.available, false);
  const result = await voice.speak('Hello there');
  assert.equal(result, 'unavailable');
  assert.equal(duckCalls.length, 0);
});

test('unavailable speech when Utterance is missing never ducks', async () => {
  const duckCalls = [];
  const voice = createDjVoice({
    speech: new FakeSpeech(),
    Utterance: null,
    duck: (db, s) => duckCalls.push([db, s]),
  });

  assert.equal(voice.available, false);
  const result = await voice.speak('Hello');
  assert.equal(result, 'unavailable');
  assert.equal(duckCalls.length, 0);
});

test('duck down then up exactly once per utterance in the right order', async () => {
  const duckCalls = [];
  const speech = new FakeSpeech([
    { name: 'Daniel', lang: 'en-GB', localService: true },
  ]);
  const voice = createDjVoice({
    speech,
    Utterance: FakeUtterance,
    duck: (db, s) => duckCalls.push([db, s]),
  });

  assert.equal(voice.available, true);
  assert.equal(voice.busy, false);

  const speakPromise = voice.speak('Welcome to Sisic radio');
  assert.equal(voice.busy, true);
  const utterance = speech.lastUtterance;
  assert.ok(utterance);
  assert.equal(utterance.voice?.name, 'Daniel');
  assert.equal(duckCalls.length, 0, 'no duck until speech actually starts');

  utterance.onstart?.();
  assert.deepEqual(duckCalls, [[-12, 0.3]], 'ducked -12 dB on start');

  utterance.onend?.();
  assert.deepEqual(duckCalls, [[-12, 0.3], [0, 0.5]], 'restored to 0 dB on end');

  const result = await speakPromise;
  assert.equal(result, 'done');
  assert.equal(voice.busy, false);
});

test('cancel restores the duck', async () => {
  const duckCalls = [];
  const speech = new FakeSpeech();
  const voice = createDjVoice({
    speech,
    Utterance: FakeUtterance,
    duck: (db, s) => duckCalls.push([db, s]),
  });

  const speakPromise = voice.speak('Speaking some words');
  const utterance = speech.lastUtterance;
  utterance.onstart?.();
  assert.deepEqual(duckCalls, [[-12, 0.3]]);

  voice.cancel();
  assert.deepEqual(duckCalls, [[-12, 0.3], [0, 0.5]]);
  assert.equal(speech.cancelCalls, 1);

  const result = await speakPromise;
  assert.equal(result, 'cancelled');
  assert.equal(voice.busy, false);
});

test('a second speak cancels the first', async () => {
  const duckCalls = [];
  const speech = new FakeSpeech();
  const voice = createDjVoice({
    speech,
    Utterance: FakeUtterance,
    duck: (db, s) => duckCalls.push([db, s]),
  });

  const firstPromise = voice.speak('First line');
  const firstUtterance = speech.lastUtterance;
  firstUtterance.onstart?.();
  assert.deepEqual(duckCalls, [[-12, 0.3]]);

  const secondPromise = voice.speak('Second line');
  assert.deepEqual(duckCalls, [[-12, 0.3], [0, 0.5]], 'first duck restored when cancelled');
  const firstResult = await firstPromise;
  assert.equal(firstResult, 'cancelled');

  const secondUtterance = speech.lastUtterance;
  assert.notEqual(secondUtterance, firstUtterance);
  secondUtterance.onstart?.();
  assert.deepEqual(duckCalls, [[-12, 0.3], [0, 0.5], [-12, 0.3]]);

  secondUtterance.onend?.();
  assert.deepEqual(duckCalls, [[-12, 0.3], [0, 0.5], [-12, 0.3], [0, 0.5]]);
  const secondResult = await secondPromise;
  assert.equal(secondResult, 'done');
});

test('the timeout fallback cancels utterance, restores duck and resolves done', async () => {
  const duckCalls = [];
  let scheduledCallback = null;
  let scheduledMs = 0;
  let clearedId = null;

  const speech = new FakeSpeech();
  const voice = createDjVoice({
    speech,
    Utterance: FakeUtterance,
    duck: (db, s) => duckCalls.push([db, s]),
    setTimeoutFn: (fn, ms) => {
      scheduledCallback = fn;
      scheduledMs = ms;
      return 1234;
    },
    clearTimeoutFn: id => {
      clearedId = id;
    },
  });

  const text = 'one two three four'; // 4 words
  // timeout should be (4 * 0.55 + 3) * 1000 = (2.2 + 3) * 1000 = 5200 ms
  const speakPromise = voice.speak(text);
  assert.equal(scheduledMs, 5200);

  const utterance = speech.lastUtterance;
  utterance.onstart?.();
  assert.deepEqual(duckCalls, [[-12, 0.3]]);

  // Simulate timeout firing (browser never fires onend)
  assert.ok(typeof scheduledCallback === 'function');
  scheduledCallback();

  assert.equal(speech.cancelCalls, 1, 'speech cancelled on timeout');
  assert.deepEqual(duckCalls, [[-12, 0.3], [0, 0.5]], 'duck restored on timeout');

  const result = await speakPromise;
  assert.equal(result, 'done');
  assert.equal(clearedId, 1234);
  assert.equal(voice.busy, false);
});

// ---- pins found by mutation testing ----
test('pickVoice falls back to the default voice, then the first voice', () => {
  assert.equal(pickVoice([{ name: 'x', lang: 'fr-FR' }, { name: 'y', lang: 'de-DE', default: true }]).name, 'y');
  assert.equal(pickVoice([{ name: 'x', lang: 'fr-FR' }]).name, 'x');
  assert.equal(pickVoice([{ name: 'x', lang: 'fr-FR' }, { name: 'z', lang: 'de-DE' }]).name, 'x');
});

test('speak sets rate 1.02 and volume 1 by default, honours numbers and ignores non-numbers', async () => {
  const run = async options => {
    const speech = new FakeSpeech();
    const voice = createDjVoice({ speech, Utterance: FakeUtterance });
    const done = voice.speak('hello there', options);
    const { rate, volume } = speech.lastUtterance;
    speech.lastUtterance.onend();
    await done;
    return { rate, volume };
  };
  assert.deepEqual(await run(undefined), { rate: 1.02, volume: 1 });
  assert.deepEqual(await run({ rate: 1.3, volume: 0.5 }), { rate: 1.3, volume: 0.5 });
  assert.deepEqual(await run({ rate: NaN, volume: 'loud' }), { rate: 1.02, volume: 1 });
});

test('speech without a speak function, or an Utterance that throws, resolves unavailable', async () => {
  assert.equal(await createDjVoice({ speech: {}, Utterance: FakeUtterance }).speak('hi'), 'unavailable');
  assert.equal(await createDjVoice({ speech: { speak() {} }, Utterance: undefined }).speak('hi'), 'unavailable');
  class Throwing { constructor() { throw new Error('no'); } }
  assert.equal(await createDjVoice({ speech: new FakeSpeech(), Utterance: Throwing }).speak('hi'), 'unavailable');
});

test('ducking happens once per utterance even if start fires twice, and never after the utterance ended', async () => {
  const speech = new FakeSpeech();
  const calls = [];
  const voice = createDjVoice({ speech, Utterance: FakeUtterance, duck: (db, s) => calls.push([db, s]) });
  const done = voice.speak('one two three');
  const utterance = speech.lastUtterance;
  utterance.onstart();
  utterance.onstart();
  assert.deepEqual(calls, [[-12, 0.3]]);
  utterance.onend();
  assert.equal(await done, 'done');
  utterance.onstart();
  assert.deepEqual(calls, [[-12, 0.3], [0, 0.5]]);
});

test('speech errors: canceled and interrupted resolve cancelled, anything else resolves done', async () => {
  const outcome = async event => {
    const speech = new FakeSpeech();
    const voice = createDjVoice({ speech, Utterance: FakeUtterance });
    const done = voice.speak('hello');
    speech.lastUtterance.onerror(event);
    return done;
  };
  assert.equal(await outcome({ error: 'canceled' }), 'cancelled');
  assert.equal(await outcome({ error: 'interrupted' }), 'cancelled');
  assert.equal(await outcome({ error: 'synthesis-failed' }), 'done');
  assert.equal(await outcome(undefined), 'done');
});
