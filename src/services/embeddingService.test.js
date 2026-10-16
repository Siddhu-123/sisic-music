import assert from 'node:assert/strict';
import test from 'node:test';
import { areVectorSpacesCompatible } from './contextualRecommendationService.js';
import {
  DEFAULT_AUDIO_EMBEDDING_MODEL,
  EMBEDDINGGEMMA2_VECTOR_SPACE,
  getPreferredVectorSpace,
} from './embeddingService.js';
import { GEMMA2_MODEL } from './gemmaVectors.js';

test('registers Gemma 2 metadata and prefers it when present among involved songs', () => {
  assert.deepEqual(EMBEDDINGGEMMA2_VECTOR_SPACE, {
    model: GEMMA2_MODEL,
    dimensions: 256,
    provider: 'embeddinggemma2-service',
    vectorType: 'learned-audio',
  });
  assert.equal(getPreferredVectorSpace([{ songKey: 'a', embeddingModel: GEMMA2_MODEL }]), EMBEDDINGGEMMA2_VECTOR_SPACE);
  assert.equal(getPreferredVectorSpace([{ model: 'msd-musicnn-1', dimensions: 200, vectorType: 'learned-audio' }]).model, 'msd-musicnn-1');
  assert.equal(getPreferredVectorSpace([]), DEFAULT_AUDIO_EMBEDDING_MODEL);
});

test('Gemma and MusiCNN vectors are incompatible spaces', () => {
  assert.equal(areVectorSpacesCompatible(
    { model: GEMMA2_MODEL, dimensions: 256, vectorType: 'learned-audio' },
    { model: 'msd-musicnn-1', dimensions: 200, vectorType: 'learned-audio' },
  ), false);
});
