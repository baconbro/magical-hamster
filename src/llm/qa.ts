import type {
  ChatRequest,
  ChatUsage,
  Excerpt,
  Lang,
  LlmScheduler,
  OllamaClient,
  SourceDoc,
} from '../types.ts';
import { detectLang, shorthandLang } from '../util/lang.ts';
import { collapseWhitespace, estimateTokens, truncate } from '../util/text.ts';
import { plainLinks, qaMessages, sourceLabel } from './prompts.ts';
import { GEN_OPTIONS, MAX_SHORTHAND_CHARS, charsFor, generate } from './summary.ts';
import type { GenSettings } from './summary.ts';

const WORD_CHAR = /[\p{L}\p{N}]/u;

/* What a speech recognizer hands over is not one sentence: a final holds up to
   twenty seconds of speech, several sentences, sometimes two speakers. Its
   question marks are reliable where it writes them, but the mark of a sentence
   said just before a pause only arrives with the next final (`closes`), and
   it writes "est ce que" and "peux tu" without their hyphens.

   So a question is a SENTENCE of the segment: one that ends in "?", or one
   that opens the way questions do. The openers are kept to forms that are
   questions on their own. "Quand on a lancé le pilote..." and "What I mean
   is..." open on an interrogative word and ask nothing: of 26 such statements
   in real transcripts, the old list offered all 26 as questions. */

// "ok", "donc", "so"... in front of the sentence proper.
const FILLER = /^(?:(?:ok(?:ay)?|d'accord|donc|alors|bon|ben|et|mais|puis|so|and|but|well|right|now|also|aussi|euh|um|uh)[\s,]+)+/i;

const FR_SUBJECT = '(?:tu|vous|il|elle|on|ils|elles|nous|je)';
const FRENCH_OPENERS: RegExp[] = [
  /^est[- ]ce qu(?:e\b|')/i,
  /^qu'?est[- ]ce\b/i,
  /^c'est (?:quoi|qui|quand|où|combien)\b/i,
  /^(?:pourquoi|combien|qui|quels?|quelles?|lequel|laquelle|lesquels|lesquelles)\b/i,
  // "comment fait-on", "quand est-ce que", "où est le rapport": the question forms of the three
  // words that also open a plain clause ("quand on a lancé...").
  /^(?:quand|comment|où)\s+(?:en\s+|y\s+)?(?:est[- ]ce|est|sont|êtes|était|va|vont|peut|peuvent|doit|doivent|faut|faire|ça)\b/i,
  // Written with its hyphen only: "comment dire je ne suis pas certaine" is not an inversion.
  new RegExp(`^(?:quand|comment|où)\\s+[\\p{L}']+-(?:t-)?${FR_SUBJECT}\\b`, 'iu'),
  // "comment on va choisir", "comment ça marche": said with a subject, and never "comment dire".
  /^comment\s+(?:on|tu|vous|ça|il|elle|ils|elles)\s+(?:va|vas|allez|vont|fait|fais|faites|font|peut|peux|pouvez|veut|veux|voulez|doit|sait|marche|se)\b/i,
  // Inversion: "peux-tu", "avez vous", "a-t-on", "y a-t-il".
  new RegExp(
    `^(?:y )?(?:peux|peut|pouvez|peuvent|pourrais|pourrait|pourriez|avez|as|ont|est|sont|êtes|es|veux|veut|voulez|sais|sait|savez|dois|doit|devez|faut|vas|va|allez|penses|pensez|crois|croyez|aurais|aurait|auriez|serait|seriez|a)[- ](?:t[- ])?${FR_SUBJECT}\\b`,
    'i',
  ),
];

const EN_BE = "(?:is|are|was|were|can|could|should|would|will|shall|may|might|isn't|aren't|wasn't|weren't|can't|couldn't|shouldn't|wouldn't|won't)";
const EN_DO = "(?:do|does|did|have|has|had|don't|doesn't|didn't|haven't|hasn't)";
const EN_PERSON = '(?:we|you|they|he|she|i|anyone|anybody|someone|somebody|everyone|everybody)';
const EN_THING = '(?:it|there|this|that|these|those|the|our|your|my|their|his|her)';
const ENGLISH_OPENERS: RegExp[] = [
  new RegExp(`^${EN_BE}\\s+(?:${EN_PERSON}|${EN_THING})\\b`, 'i'),
  // "Do it now" and "Have a look" are orders: only a person after do and have.
  new RegExp(`^${EN_DO}\\s+(?:${EN_PERSON}|the|our|your|their)\\b`, 'i'),
  /^(?:does|did|has|hasn't|doesn't|didn't)\s+(?:it|that|this)\b/i,
  /^(?:who|whose|why)\b/i,
  /^(?:what|where|when|how|who)'s\b/i,
  /^(?:what|where|when|how)\s+(?:is|are|was|were|do|does|did|can|could|should|would|will|have|has|had|about|if|happens|happened|else|time|kind|sort|many|much|long|often|far|soon|come)\b/i,
  // "Which team takes over", and not the "which is why..." that carries on a sentence.
  /^which\s+(?!(?:is|are|was|were|means|meant|would|will|can|could|should|has|have|had|makes|made|brings|leads|gives|explains|i|we|you|they|he|she|it)\b)[\p{L}-]+/iu,
];
// The same with a name where the pronoun goes: "Does Marc know", "Can Priya confirm". Case decides.
const EN_NAMED = new RegExp(`^(?:${EN_BE.slice(3, -1)}|${EN_DO.slice(3, -1)})\\s+\\p{Lu}[\\p{L}'-]+\\s+\\p{Ll}`, 'u');

function flatten(text: string): string {
  // NFC: "où" may arrive as "o" + a combining accent, which the patterns would miss.
  return collapseWhitespace(text).normalize('NFC').replace(/[’‘]/g, "'");
}

function wordCount(text: string): number {
  return text.split(' ').filter((w) => WORD_CHAR.test(w)).length;
}

/** The sentences of a passage, each with its closing mark. */
export function sentencesOf(text: string): string[] {
  return flatten(text)
    .split(/(?<=[.?!…]["'»)\]]?)\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => WORD_CHAR.test(sentence));
}

function asksSomething(sentence: string): boolean {
  // "ok?" and "right?" are checks for agreement, not questions to answer.
  if (wordCount(sentence) < 3) return false;
  if (/\?[\s"'»)\]!]*$/.test(sentence)) return true;
  const bare = sentence.replace(/^[^\p{L}\p{N}]+/u, '');
  const start = bare.replace(FILLER, '');
  if (EN_NAMED.test(start.charAt(0).toLowerCase() + start.slice(1))) return true;
  return FRENCH_OPENERS.some((re) => re.test(start)) || ENGLISH_OPENERS.some((re) => re.test(start));
}

/* Where a question begins INSIDE a sentence. A recognizer that hears no pause
   writes no mark, and the question follows what came before in one breath:
   "great and the API connector when will it be ready we need three more
   weeks". Only forms that are a question wherever they stand. */
const INNER: RegExp[] = [
  /(?:\b(?:quand|comment|où|pourquoi|combien|qui)\s+)?\best[- ]ce qu(?:e\b|')/iu,
  /\bqu'?est[- ]ce\b/iu,
  /\b(?:avez|as|peux|peut|pouvez|sais|savez|veux|voulez|dois|devez|penses|pensez|crois|croyez|vas|allez|êtes|es|pourrais|pourriez)[- ](?:tu|vous)\b/iu,
  /\by a[- ]t[- ]il\b/iu,
  /\bcombien de\b/iu,
  /\b(?:when|where|what|how|why|who)\s+(?:will|is|are|do|does|did|can|should|would|could)\s+(?:it|we|you|they|he|she|the|this|that|there)\b/iu,
  /(?:[,;]|\b(?:and|so|but|or|then))\s+(?:do|does|did|can|could|should|will|would|are|is|have|has)\s+(?:we|you|they|it)\b/iu,
];
const CHIP_WORDS = 22;

function firstWords(text: string, count: number): string {
  const words = text.split(' ');
  return words.length <= count ? text : words.slice(0, count).join(' ');
}

/** Where the earliest question form inside `sentence` starts, or -1. */
function innerQuestion(sentence: string): number {
  let at = -1;
  for (const re of INNER) {
    const m = re.exec(sentence);
    if (!m) continue;
    // The clause mark or the conjunction in front of the question is not part of it.
    const lead = /^(?:[,;]|and|so|but|or|then)\s+/i.exec(m[0]);
    const start = m.index + (lead ? lead[0].length : 0);
    if (at === -1 || start < at) at = start;
  }
  return at;
}

/**
 * The questions asked in a transcript segment, in order: its sentences that end in "?" or open
 * the way a question does, and, in a sentence that does neither, what follows a question form
 * in mid-sentence. A long run-on is cut to the question itself where one can be told.
 */
export function questionsIn(text: string): string[] {
  const found: string[] = [];
  for (const sentence of sentencesOf(text)) {
    const inner = innerQuestion(sentence);
    if (asksSomething(sentence)) {
      const long = wordCount(sentence) > CHIP_WORDS;
      found.push(long && inner > 0 ? sentence.slice(inner) : sentence);
    } else if (inner >= 0) {
      const tail = firstWords(sentence.slice(inner), CHIP_WORDS);
      if (wordCount(tail) >= 3) found.push(tail);
    }
  }
  return found;
}

/** The last sentence of a segment, when it is long enough to be a question someone would answer. */
export function lastSentence(text: string): string | null {
  const all = sentencesOf(text);
  const last = all[all.length - 1];
  return last !== undefined && wordCount(last) >= 3 ? last : null;
}

/** True for text that holds a question worth offering as a chip: a sentence of at least three words that ends in "?" or opens the way a French or English question does. */
export function looksLikeQuestion(text: string): boolean {
  return questionsIn(text).length > 0;
}

/** Numbers the material for one answer: linked notes, then vault chunks by score, then transcript excerpts, within `maxTokens`. */
export function buildSources(args: {
  linked: Array<{ title: string; path: string; text: string }>;
  vault: Array<{ path: string; title: string; heading: string; text: string; score: number }>;
  transcript: Excerpt[];
  maxTokens: number;
}): SourceDoc[] {
  const candidates: Array<Omit<SourceDoc, 'n'>> = [];
  const linkedPaths = new Set<string>();
  for (const note of args.linked) {
    if (note.path && linkedPaths.has(note.path)) continue;
    if (note.path) linkedPaths.add(note.path);
    candidates.push({ kind: 'linked', title: note.title, path: note.path, text: note.text });
  }
  const chunks = args.vault
    // The whole note is already there as a linked source.
    .filter((c) => !linkedPaths.has(c.path))
    .sort((a, b) => b.score - a.score);
  for (const c of chunks) {
    const doc: Omit<SourceDoc, 'n'> = {
      kind: 'note',
      title: c.title,
      path: c.path,
      text: c.text,
      score: c.score,
    };
    if (c.heading) doc.heading = c.heading;
    candidates.push(doc);
  }
  for (const x of [...args.transcript].sort((a, b) => b.score - a.score)) {
    candidates.push({ kind: 'transcript', title: 'Transcript', time: x.time, text: x.text, score: x.score });
  }

  const out: SourceDoc[] = [];
  let total = 0;
  for (const candidate of candidates) {
    let text = candidate.text.trim();
    if (!text) continue;
    let cost = estimateTokens(text);
    if (total + cost > args.maxTokens) {
      if (out.length > 0) break;
      // The first source alone is over budget: a shortened note beats no source at all.
      text = truncate(text, Math.max(0, Math.floor(args.maxTokens * 3.3) - 1));
      cost = estimateTokens(text);
      if (!text || cost > args.maxTokens) break;
    }
    out.push({ ...candidate, n: out.length + 1, text });
    total += cost;
  }
  return out;
}

/** Sources the answer actually cites as [n]; all sources when it cites none. */
export function citedSources(answer: string, sources: SourceDoc[]): SourceDoc[] {
  const cited = new Set<number>();
  // NFKC: full-width "［１］" reads as "[1]".
  const text = answer.normalize('NFKC');
  // "[1]", "[1, 3]", "[1-3]", "[1 and 2]"; not the text of a Markdown link "[1](...)".
  for (const match of text.matchAll(/\[(\d{1,3}(?:\s*(?:[,;–-]|and|et)\s*\d{1,3})*)\](?!\()/g)) {
    for (const part of match[1].split(/\s*(?:[,;]|and|et)\s*/)) {
      const range = /^(\d{1,3})\s*[–-]\s*(\d{1,3})$/.exec(part.trim());
      if (range) {
        const from = Number(range[1]);
        const to = Number(range[2]);
        for (let n = from; n <= Math.min(to, from + 20); n++) cited.add(n);
      } else {
        cited.add(Number(part.trim()));
      }
    }
  }
  const hits = sources.filter((s) => cited.has(s.n));
  return hits.length > 0 ? hits : supportingSources(answer, sources);
}

/* Words too common to tie an answer to a source. */
const COMMON = new Set([
  'about', 'after', 'again', 'already', 'because', 'before', 'being', 'could', 'during', 'every',
  'first', 'other', 'should', 'since', 'their', 'there', 'these', 'those', 'through', 'under',
  'until', 'where', 'which', 'while', 'would', 'avant', 'après', 'apres', 'aussi', 'autre', 'avoir',
  'cette', 'comme', 'depuis', 'doivent', 'encore', 'entre', 'leurs', 'notre', 'parce', 'pendant',
  'peut', 'plus', 'pour', 'prévu', 'prevue', 'quand', 'selon', 'seront', 'toutes', 'votre',
  'answer', 'material', 'sources', 'source', 'meeting', 'réunion', 'reunion', 'question',
]);

function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** The words and figures of an answer that can tie it to a source: numbers, names, long words. */
function markers(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const flat = text.normalize('NFKC');
  for (const m of flat.matchAll(/\d{1,3}(?:[ \u00A0\u202F.,]\d{3})+(?!\d)|\d+/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 2 || /\d[ ,.]/.test(m[0])) out.set(digits, 2);
  }
  for (const m of flat.matchAll(/[\p{L}][\p{L}'-]{4,}/gu)) {
    const word = fold(m[0]);
    if (COMMON.has(word)) continue;
    const weight = /^\p{Lu}/u.test(m[0]) && m.index !== 0 ? 2 : 1;
    out.set(word, Math.max(out.get(word) ?? 0, weight));
  }
  return out;
}

/**
 * The sources an answer that cites none actually draws on: those that hold its figures, names
 * and less common words. Listing every source instead would claim eight notes for one sentence
 * taken from the transcript. An answer about the meeting itself, or one that says the material
 * has nothing, shares too little with any source and lists none.
 */
export function supportingSources(answer: string, sources: SourceDoc[]): SourceDoc[] {
  const wanted = markers(answer.replace(WORD_CITATION, ' '));
  WORD_CITATION.lastIndex = 0;
  if (wanted.size === 0) return [];
  const scored = sources.map((source) => {
    const text = fold(source.text.normalize('NFKC')) + ' ' + fold(`${source.title} ${source.heading ?? ''}`);
    const digits = text.replace(/(\d)[ \u00A0\u202F.,](?=\d{3}(?!\d))/g, '$1');
    let score = 0;
    for (const [marker, weight] of wanted) {
      const haystack = /^\d+$/.test(marker) ? digits : text;
      const at = haystack.indexOf(marker);
      if (at === -1) continue;
      if (/^\d+$/.test(marker) && (/\d/.test(haystack[at - 1] ?? '') || /\d/.test(haystack[at + marker.length] ?? ''))) continue;
      score += weight;
    }
    return { source, score };
  });
  const best = Math.max(0, ...scored.map((s) => s.score));
  if (best < 3) return [];
  return scored.filter((s) => s.score >= 3 && s.score * 5 >= best * 3).map((s) => s.source);
}

/** Block appended to the companion's `qa` region. Plain text citations, no wikilinks. */
export function formatInsight(entry: {
  clockTime: string;
  question: string;
  answer: string;
  sources: SourceDoc[];
}): string {
  const question = collapseWhitespace(plainLinks(entry.question));
  const lines = [`### ${entry.clockTime} — ${question}`, '', plainLinks(entry.answer).trim()];
  const labels = [...new Set(entry.sources.map(sourceLabel))];
  if (labels.length > 0) lines.push('', `Sources: ${labels.join('; ')}`);
  return lines.join('\n');
}

export interface QaDeps {
  llm: OllamaClient;
  scheduler: LlmScheduler;
  settings(): GenSettings;
  onUsage(usage: ChatUsage): void;
}

export interface QaInput {
  question: string;
  title: string;
  date: string;
  shorthand: string[];
  transcriptTail: string;
  sources: SourceDoc[];
}

const ANSWER_TOKENS = 400;
/** System text, tags and source headers, in tokens. */
const PROMPT_OVERHEAD = 700;
/* The most the sources of one answer take: eight vault chunks and four excerpts fit well under
   it. The least they get: below it the answer would come from the shorthand alone, so a small
   context cuts the shorthand down to leave this much. */
const QA_SOURCE_TOKENS = 6000;
const MIN_SOURCE_TOKENS = 500;

/* The shorthand as the answer carries it: at most MAX_SHORTHAND_CHARS, and less when the context
   would otherwise leave the sources under MIN_SOURCE_TOKENS. */
function fitShorthand(numCtx: number, question: string, shorthand: string): string {
  const text = truncate(shorthand, MAX_SHORTHAND_CHARS);
  const room = numCtx - ANSWER_TOKENS - PROMPT_OVERHEAD - estimateTokens(question) - MIN_SOURCE_TOKENS;
  return estimateTokens(text) <= room ? text : truncate(text, charsFor(room));
}

/**
 * Tokens the sources of one answer may take: what the context leaves beside the answer, the
 * question and the shorthand as `answerQuestion` sends them, within QA_SOURCE_TOKENS and never
 * under MIN_SOURCE_TOKENS. The budgets follow `numCtx`: at its smallest setting, a fixed 6,000
 * would overflow the context on its own.
 */
export function qaSourceBudget(numCtx: number, question: string, shorthand: string): number {
  const used = estimateTokens(question) + estimateTokens(fitShorthand(numCtx, question, shorthand));
  return Math.max(MIN_SOURCE_TOKENS, Math.min(QA_SOURCE_TOKENS, numCtx - ANSWER_TOKENS - PROMPT_OVERHEAD - used));
}

/** The newest lines that fit: the end of the transcript is where the question came from. */
function keepTail(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const kept: string[] = [];
  let tokens = 0;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = estimateTokens(lines[i]) + 1;
    if (tokens + cost > maxTokens) break;
    kept.unshift(lines[i]);
    tokens += cost;
  }
  return kept.join('\n');
}

/* What a model writes in brackets for material that has no number: "[transcript]",
   "[Transcription, shorthand]". Not a source the answer can link to. */
const WORD_CITATION =
  /\s*\[(?:transcript|transcription|shorthand|notes?|notes rapides|meeting notes|réunion|meeting)(?:\s*[,;]\s*(?:transcript|transcription|shorthand|notes?|notes rapides|meeting notes|réunion|meeting))*\]/giu;

/** "[1, transcript]": the number is a citation, the word is not. */
const MIXED_CITATION =
  /\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\s*[,;]\s*(?:transcript|transcription|shorthand|notes?)(?:\s*[,;]\s*(?:transcript|transcription|shorthand|notes?))*\]/giu;

/**
 * The language to answer a question in. A question is short: it is read the way a line of
 * shorthand is read. With nothing to go on ("Go-live date?", "Trainer name?"), French typing
 * still shows: the space before the question mark, an accent, an elision. Without any of them
 * the question is taken for English: told only to answer "in the language of the question",
 * gemma4:12b answered such questions in the language of the sources, French one time in four.
 */
export function questionLanguage(question: string): Lang | null {
  const decided = shorthandLang(question) ?? detectLang(question);
  if (decided) return decided;
  const flat = question.normalize('NFC').trim();
  if (/\s\?[\s"»)]*$/.test(flat)) return 'fr';
  if (/[àâçéèêëîïôùûœ]/i.test(flat) || /\b(?:l|d|qu|j|n|s|c)['’]\p{L}/iu.test(flat)) return null;
  return /\p{L}/u.test(flat) ? 'en' : null;
}

function tidyAnswer(text: string): string {
  return plainLinks(text)
    .replace(MIXED_CITATION, '[$1]')
    .replace(WORD_CITATION, '')
    .trim()
    .replace(/^(?:answer|réponse)\s*:\s*/i, '');
}

export async function answerQuestion(
  deps: QaDeps,
  input: QaInput,
  onText: (markdown: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const s = deps.settings();
  const notes = input.shorthand.map((line) => line.trim()).filter(Boolean);
  /* A question is short: read it the way a line of shorthand is read. When even that cannot
     tell, the model is asked to answer in the question's own language rather than in the
     language of the notes, which was wrong for one short question in three. */
  const language: Lang | null = questionLanguage(input.question);
  const shorthand = fitShorthand(s.numCtx, input.question, notes.join('\n'));

  const used =
    estimateTokens(shorthand) +
    estimateTokens(input.question) +
    input.sources.reduce((sum, source) => sum + estimateTokens(source.text) + 8, 0);
  const transcriptTail = keepTail(
    input.transcriptTail,
    Math.max(0, s.numCtx - ANSWER_TOKENS - PROMPT_OVERHEAD - used),
  );

  const req: ChatRequest = {
    purpose: 'qa',
    model: s.model,
    messages: qaMessages({
      question: input.question,
      language,
      micLabel: s.micLabel,
      title: input.title,
      date: input.date,
      shorthand,
      transcriptTail,
      sources: input.sources,
    }),
    numCtx: s.numCtx,
    numPredict: ANSWER_TOKENS,
    ...GEN_OPTIONS,
    keepAlive: s.keepAlive ?? GEN_OPTIONS.keepAlive,
  };
  const text = await generate(deps, req, (full) => onText(tidyAnswer(full)), signal);
  const answer = tidyAnswer(text);
  onText(answer);
  return answer;
}
