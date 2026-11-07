import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spokenNumbersToDigits as digits } from '../src/util/numbers.ts';

test('spokenNumbersToDigits: French as the recognizer writes it', () => {
  assert.equal(
    digits("Le taux d'adoption est à cinquante quatre pour cent, la cible est de soixante dix pour cent à la fin décembre."),
    "Le taux d'adoption est à 54 %, la cible est de 70 % à la fin décembre.",
  );
  assert.equal(digits('en deux mille vingt six'), 'en 2026');
  assert.equal(digits('quatre-vingt-dix-neuf dossiers'), '99 dossiers');
  assert.equal(digits('quatre vingt dix neuf dossiers'), '99 dossiers');
  assert.equal(digits('soixante et onze personnes'), '71 personnes');
  assert.equal(digits('vingt et un jours'), '21 jours');
  assert.equal(digits('dix sept postes'), '17 postes');
  assert.equal(digits('mille deux cent cinquante dollars'), '1250 dollars');
  assert.equal(digits('trois cent mille'), '300000');
  assert.equal(digits('quarante mille de plus'), '40000 de plus');
  assert.equal(digits('trois virgule cinq millions'), '3,5 millions');
  assert.equal(digits("autour d'un virgule huit million"), "autour d'1,8 million");
});

test('spokenNumbersToDigits: English', () => {
  assert.equal(digits('eighteen thousand four hundred dollars'), '18400 dollars');
  assert.equal(digits('two hundred and five users'), '205 users');
  assert.equal(digits('NPS went from thirty one to thirty eight'), 'NPS went from 31 to 38');
  assert.equal(digits('ninety nine point nine percent uptime'), '99.9 % uptime');
  assert.equal(digits('savings of two point four million over five years'), 'savings of 2.4 million over 5 years');
});

test('spokenNumbersToDigits: a word that is also something else stays a word', () => {
  for (const text of [
    'une personne',
    'un ordinateur neuf',
    'one of them',
    'Trois-Rivières',
    'ça coûte cent dollars',
    'a million thanks',
    'et puis voilà',
  ]) {
    assert.equal(digits(text), text, text);
  }
  assert.equal(digits('le neuf novembre à neuf heures trente'), 'le 9 novembre à 9 heures 30');
  // "Two or three", not five.
  assert.equal(digits('deux trois personnes'), '2 3 personnes');
  assert.equal(digits('Deux options sur la table'), '2 options sur la table');
});

test('spokenNumbersToDigits: ranges, sentences and coins stay apart', () => {
  assert.equal(digits('entre deux et trois semaines'), 'entre 2 et 3 semaines');
  assert.equal(digits('between fifty and sixty percent'), 'between 50 and 60 %');
  assert.equal(digits('chapters four and five'), 'chapters 4 and 5');
  assert.equal(digits('between one hundred and two hundred users'), 'between 100 and 200 users');
  assert.equal(digits('one hundred and three thousand nine hundred and sixty-one'), '103961');
  assert.equal(digits('Il y en a vingt. Deux sont partis.'), 'Il y en a 20. 2 sont partis.');
  assert.equal(digits('We hired twenty. Five left.'), 'We hired 20. 5 left.');
  assert.equal(digits('vingt, deux'), '20, 2');
  assert.equal(digits('it costs fifty cents'), 'it costs 50 cents');
  assert.equal(digits('deux cents personnes'), '200 personnes');
  assert.equal(digits('deux-trois jours'), 'deux-trois jours');
});

test('spokenNumbersToDigits: decimals, and the words that are not numbers', () => {
  assert.equal(digits('three point one four'), '3.14');
  assert.equal(digits('trois virgule zéro cinq'), '3,05');
  assert.equal(digits('un virgule un pour cent'), '1,1 %');
  assert.equal(digits('trois virgule vingt cinq'), '3,25');
  assert.equal(digits('On fait un point demain.'), 'On fait un point demain.');
  assert.equal(digits('We need to seize this opportunity.'), 'We need to seize this opportunity.');
  assert.equal(digits('zero trust'), 'zero trust');
  assert.equal(digits('seize personnes'), '16 personnes');
  assert.equal(digits('Sept 14'), 'Sept 14');
  assert.equal(digits('sept personnes'), '7 personnes');
});

test('spokenNumbersToDigits: every number to a thousand, as French and English spell it', () => {
  const units = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize'];
  const tens: Record<number, string> = { 2: 'vingt', 3: 'trente', 4: 'quarante', 5: 'cinquante', 6: 'soixante' };
  const fr99 = (n: number): string => {
    if (n <= 16) return units[n];
    if (n < 20) return `dix-${units[n - 10]}`;
    const t = Math.floor(n / 10);
    const u = n % 10;
    if (t <= 6) return u === 0 ? tens[t] : u === 1 ? `${tens[t]} et un` : `${tens[t]}-${units[u]}`;
    if (t === 7) return n === 71 ? 'soixante et onze' : `soixante-${fr99(n - 60)}`;
    return n === 80 ? 'quatre-vingts' : `quatre-vingt-${fr99(n - 80)}`;
  };
  const fr = (n: number): string => {
    if (n < 100) return fr99(n);
    const c = Math.floor(n / 100);
    const r = n % 100;
    const head = c === 1 ? 'cent' : `${units[c]} cent${r === 0 ? 's' : ''}`;
    return r ? `${head} ${fr99(r)}` : head;
  };
  const eu = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const et = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const en = (n: number): string => {
    if (n < 20) return eu[n];
    if (n < 100) return n % 10 ? `${et[Math.floor(n / 10)]}-${eu[n % 10]}` : et[n / 10];
    return `${eu[Math.floor(n / 100)]} hundred${n % 100 ? ` and ${en(n % 100)}` : ''}`;
  };
  const kept = new Set(['un', 'one', 'zéro', 'zero', 'cent', 'neuf', 'seize']);
  for (let n = 0; n < 1000; n++) {
    for (const words of [fr(n), en(n)]) {
      if (kept.has(words)) continue;
      assert.equal(digits(`total ${words} items`), `total ${n} items`, words);
    }
  }
});
