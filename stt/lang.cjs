'use strict';

/* French or English, from function words.

   This is a CommonJS port of src/util/lang.ts: the worker runs outside the
   plugin bundle and cannot import it. The word lists and thresholds must stay
   identical in both files (test/worker.test.ts compares them). */

const FR = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'est', 'sont', 'que', 'qui', 'pour',
  'pas', 'dans', 'sur', 'avec', 'nous', 'vous', 'ils', 'elles', 'on', 'au', 'aux', 'ce', 'cette',
  'ces', 'mais', 'ou', 'où', 'donc', 'faut', 'fait', 'faire', 'être', 'avoir', 'plus', 'très',
  'ça', 'cest', 'quil', 'quon', 'je', 'tu', 'il', 'elle', 'ne', 'se', 'sa', 'son', 'ses', 'leur',
  'comme', 'aussi', 'alors', 'parce', 'quand', 'comment', 'pourquoi', 'combien', 'oui', 'non',
  'va', 'vont', 'peut', 'doit', 'avait', 'été', 'chez', 'entre', 'sans', 'sous', 'après', 'avant',
]);

const EN = new Set([
  'the', 'a', 'an', 'and', 'is', 'are', 'was', 'were', 'that', 'which', 'for', 'not', 'in', 'on',
  'with', 'we', 'you', 'they', 'it', 'this', 'these', 'those', 'but', 'or', 'so', 'need', 'do',
  'does', 'did', 'be', 'have', 'has', 'had', 'more', 'very', 'i', 'he', 'she', 'of', 'to', 'at',
  'by', 'from', 'as', 'also', 'then', 'because', 'when', 'how', 'why', 'what', 'who', 'yes', 'no',
  'will', 'would', 'can', 'could', 'should', 'must', 'been', 'between', 'without', 'after',
  'before', 'our', 'your', 'their', 'there', 'if', 'about', 'just',
]);

function words(text) {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-zàâäçéèêëîïôöùûüœ]+/u)
    .filter(Boolean);
}

/**
 * Counts of French and English function words.
 * @param {string} text
 * @returns {{ fr: number, en: number, total: number }}
 */
function langScores(text) {
  let fr = 0;
  let en = 0;
  const all = words(text);
  for (const w of all) {
    if (FR.has(w)) fr += 1;
    if (EN.has(w)) en += 1;
  }
  return { fr, en, total: all.length };
}

/**
 * The language of a passage, or undefined when it is too short or too mixed to call.
 * @param {string} text
 * @returns {'fr' | 'en' | undefined}
 */
function detectLang(text) {
  const { fr, en } = langScores(text);
  if (fr + en < 2) return undefined;
  if (fr >= en * 1.5) return 'fr';
  if (en >= fr * 1.5) return 'en';
  return undefined;
}

module.exports = { detectLang, langScores };
