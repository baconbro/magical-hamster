import type { Lang } from '../types.ts';

/* stt/lang.cjs is a CommonJS port of this file for the speech worker. The word
   lists and thresholds must stay identical; test/worker.test.ts fails if they drift.

   French or English, from function words. Deliberately tiny: it only has to
   tell Fred's two languages apart on a sentence or more of text, and it says
   "don't know" rather than guess on short or balanced input. */

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

/** True for a French or English function word ("pour", "with", "dans"), accents aside. */
export function isFunctionWord(word: string): boolean {
  return FUNCTION_WORDS.has(word.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase());
}

const FUNCTION_WORDS = new Set([...FR, ...EN].map((w) => w.normalize('NFD').replace(/\p{M}+/gu, '')));

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-zàâäçéèêëîïôöùûüœ]+/u)
    .filter(Boolean);
}

/** Counts of French and English function words. */
export function langScores(text: string): { fr: number; en: number; total: number } {
  let fr = 0;
  let en = 0;
  const all = words(text);
  for (const w of all) {
    if (FR.has(w)) fr += 1;
    if (EN.has(w)) en += 1;
  }
  return { fr, en, total: all.length };
}

/** The language of a passage, or undefined when it is too short or too mixed to call. */
export function detectLang(text: string): Lang | undefined {
  const { fr, en } = langScores(text);
  if (fr + en < 2) return undefined;
  if (fr >= en * 1.5) return 'fr';
  if (en >= fr * 1.5) return 'en';
  return undefined;
}

/** The dominant language across many passages, weighted by length. Defaults to English on a tie. */
export function dominantLang(texts: string[]): Lang {
  let fr = 0;
  let en = 0;
  for (const t of texts) {
    const s = langScores(t);
    fr += s.fr;
    en += s.en;
  }
  return fr > en ? 'fr' : 'en';
}

/* Words that count as a function word in one language and are common, as
   something else, in the other: "IT" the department, "a" the French verb,
   "plus" in English, "est." for an estimate. */
const AMBIGUOUS = new Set(['a', 'i', 'it', 'on', 'or', 'as', 'an', 'plus', 'son', 'est', 'un', 'do', 'non']);

const FRENCH_ACCENT = /[àâçéèêëîïôùûœ]/i;

/* What a telegraphic note is made of when it has no function word at all:
   "Jane absente lundi", "ship Friday", "relancer Marc demain". Days, months and
   the everyday words of meeting notes. Used for shorthand lines only: these
   lists are not in the speech worker's port. */
const FR_NOTE = new Set([
  'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche', 'janvier', 'février',
  'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'aout', 'septembre', 'octobre',
  'novembre', 'décembre', 'decembre', 'demain', 'hier', 'aujourdhui', 'semaine', 'semaines', 'sem',
  'mois', 'jours', 'prochain', 'prochaine', 'dernier', 'dernière', 'retard', 'absent', 'absente',
  'relance', 'relancer', 'rencontre', 'réunion', 'reunion', 'équipe', 'equipe', 'suivi', 'livrable',
  'échéance', 'echeance', 'embauche', 'poste', 'postes', 'fournisseur', 'contrat', 'signé', 'signe',
  'approuvé', 'approuve', 'envoyé', 'envoyer', 'attente', 'attend', 'voir', 'revoir', 'valider',
  'préparer', 'preparer', 'demander', 'confirmer', 'daccord', 'lui', 'étape', 'etape', 'besoin',
  'besoins', 'reste', 'reporté', 'reporte', 'gelé', 'gel', 'prévu', 'prevu', 'vague', 'vagues',
]);

const EN_NOTE = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january',
  'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november',
  'december', 'tomorrow', 'yesterday', 'today', 'week', 'weeks', 'month', 'months', 'days', 'next',
  'last', 'late', 'delay', 'delayed', 'absent', 'team', 'follow', 'deadline', 'due',
  'hiring', 'vendor', 'signed', 'approved', 'sent', 'send', 'ship', 'shipped', 'waiting', 'pending',
  'review', 'check', 'ask', 'confirm', 'agreed', 'step', 'needs', 'left', 'moved', 'frozen',
  'blockers', 'blocked', 'failed', 'fixed', 'out', 'now', 'offers', 'accepted', 'booked', 'owner',
]);

/* Shared spellings: no evidence either way. */
const NOTE_BOTH = new Set(['absent', 'mars', 'mai', 'reste']);

/**
 * The language of one line of shorthand. Terse notes carry few function
 * words, so a single unambiguous one decides, a French accent counts as
 * evidence, and so do the everyday words of notes (days, months, "relance",
 * "ship"). Undefined when nothing tips it either way, and when the line really
 * is in both languages: "le kick-off est le 3 nov, need to book the big room"
 * must stay as written, not be turned into one language.
 */
export function shorthandLang(text: string): Lang | undefined {
  let fr = 0;
  let en = 0;
  for (const w of words(text)) {
    if (AMBIGUOUS.has(w)) continue;
    if (FR.has(w)) fr += 1;
    if (EN.has(w)) en += 1;
    if (NOTE_BOTH.has(w)) continue;
    if (FR_NOTE.has(w)) fr += 1;
    if (EN_NOTE.has(w)) en += 1;
  }
  if (FRENCH_ACCENT.test(text)) fr += 1;
  // Both languages, neither one twice the other: a line that switches inside.
  if (fr > 0 && en > 0 && Math.max(fr, en) <= 2 * Math.min(fr, en)) return undefined;
  if (fr > en) return 'fr';
  if (en > fr) return 'en';
  return undefined;
}
