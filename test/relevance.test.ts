import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nearBest, retrievalFloors, UNMEASURED_FLOORS } from '../src/rag/relevance.ts';

test('retrievalFloors: EmbeddingGemma has its own floors, whatever the tag or the registry prefix', () => {
  const measured = retrievalFloors('embeddinggemma-2:270m');
  // Unrelated text scores 0.51 to 0.75 with this model: a floor below that filters nothing.
  assert.ok(measured.enhance > 0.6 && measured.enhance < 0.75);
  assert.ok(measured.transcript >= 0.55);
  assert.ok(measured.vault >= 0.55);
  assert.ok(Number.isFinite(measured.enhanceGap));
  assert.deepEqual(retrievalFloors('  EmbeddingGemma-2:740m '), measured);
  assert.deepEqual(retrievalFloors('registry.ollama.ai/library/embeddinggemma:latest'), measured);
});

test('retrievalFloors: a model nobody measured keeps the old floors and no gap', () => {
  assert.deepEqual(retrievalFloors('qwen3-embedding:8b'), UNMEASURED_FLOORS);
  assert.deepEqual(retrievalFloors(''), UNMEASURED_FLOORS);
  assert.equal(UNMEASURED_FLOORS.enhanceGap, Number.POSITIVE_INFINITY);
});

test('nearBest keeps the hits close to the best one, in their order', () => {
  const hits = [
    { id: 'a', score: 0.8 },
    { id: 'b', score: 0.77 },
    { id: 'c', score: 0.7 },
  ];
  assert.deepEqual(
    nearBest(hits, 0.04).map((h) => h.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    nearBest([hits[2], hits[0], hits[1]], 0.04).map((h) => h.id),
    ['a', 'b'],
  );
  assert.equal(nearBest(hits, Number.POSITIVE_INFINITY).length, 3);
  assert.deepEqual(nearBest([], 0.04), []);
});
