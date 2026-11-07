import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectLang, dominantLang, shorthandLang } from '../src/util/lang.ts';

test('shorthandLang decides on one unambiguous function word', () => {
  assert.equal(shorthandLang('budget Q1 -> 2 options, Jane veut la B'), 'fr');
  assert.equal(shorthandLang('hiring: PCO backfill, posting by friday'), 'en');
  assert.equal(shorthandLang('send capacity plan to Jane'), 'en');
  assert.equal(shorthandLang('formation outil de suivi sem du 17'), 'fr');
  assert.equal(shorthandLang('vendor contract renewal may slip to Nov'), 'en');
});

test('shorthandLang counts a French accent as evidence', () => {
  assert.equal(shorthandLang('contrat signé'), 'fr');
  assert.equal(shorthandLang('Jane a validé'), 'fr');
});

test('shorthandLang ignores words both languages use', () => {
  assert.equal(shorthandLang('IT PMO sync'), undefined);
  assert.equal(shorthandLang('Jane a dit ok'), undefined);
  assert.equal(shorthandLang('3 items plus 2'), undefined);
});

test('shorthandLang stays undecided on a balanced or wordless line', () => {
  assert.equal(shorthandLang('budget ok'), undefined);
  assert.equal(shorthandLang('go Q4'), undefined);
  assert.equal(shorthandLang('kick-off du portal by friday'), undefined);
  assert.equal(shorthandLang(''), undefined);
});

test('shorthandLang reads the everyday words of a note that has no function word', () => {
  assert.equal(shorthandLang('Jane absente lundi'), 'fr');
  assert.equal(shorthandLang('relancer Marc demain'), 'fr');
  assert.equal(shorthandLang('prochain point jeudi'), 'fr');
  assert.equal(shorthandLang('dry run mardi'), 'fr');
  assert.equal(shorthandLang('ship Friday'), 'en');
  assert.equal(shorthandLang('2 offers out, 1 accepted'), 'en');
  assert.equal(shorthandLang('build 500 failed on staging'), 'en');
  // A borrowed noun does not make a French line English.
  assert.equal(shorthandLang('le meeting est demain'), 'fr');
});

test('shorthandLang leaves a line that switches language inside as written', () => {
  assert.equal(shorthandLang('le kick-off est le 3 nov, need to book the big room'), undefined);
  assert.equal(shorthandLang('Jane said the budget is frozen, donc on attend janvier'), undefined);
  assert.equal(shorthandLang('on a discuté du rollout plan, but nothing is decided yet'), undefined);
  // One borrowed word in a line that is otherwise in one language does not make it mixed.
  assert.equal(shorthandLang("on garde l'option A si le prix dépasse 120 k$"), 'fr');
  assert.equal(shorthandLang('Tom to draft the rollback plan by Wednesday'), 'en');
});

test('detectLang still needs two function words', () => {
  assert.equal(detectLang('send plan to Jane'), undefined);
  assert.equal(detectLang('we need to send the plan'), 'en');
  assert.equal(detectLang('il faut envoyer le plan'), 'fr');
});

test('dominantLang weighs every passage', () => {
  assert.equal(dominantLang(['le budget est prêt', 'ok', 'on va voir avec les RH']), 'fr');
  assert.equal(dominantLang([]), 'en');
});
