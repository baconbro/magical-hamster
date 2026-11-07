/* Numbers as the speech recognizer writes them, in words: "cinquante quatre pour
   cent", "deux mille vingt six", "eighteen thousand four hundred". Left as words,
   every model downstream converts them again, and not always right: gemma4:12b
   summarized "soixante dix pour cent" as 60 %. Turned into digits once, when the
   final arrives, the transcript, the excerpts, the summary and the answers all
   carry the same figure.

   French and English, written with spaces or hyphens. Conservative where a word
   is also something else: a lone "un", "une" or "one" is an article or a
   pronoun, "neuf" also means new, "cent" also is a coin, and "deux trois" is
   "two or three", not five. */

const UNITS: Record<string, number> = {
  zéro: 0, zero: 0,
  un: 1, une: 1, one: 1,
  deux: 2, two: 2,
  trois: 3, three: 3,
  quatre: 4, four: 4,
  cinq: 5, five: 5,
  six: 6,
  sept: 7, seven: 7,
  huit: 8, eight: 8,
  neuf: 9, nine: 9,
};

const TEENS: Record<string, number> = {
  dix: 10, ten: 10,
  onze: 11, eleven: 11,
  douze: 12, twelve: 12,
  treize: 13, thirteen: 13,
  quatorze: 14, fourteen: 14,
  quinze: 15, fifteen: 15,
  seize: 16, sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  vingt: 20, vingts: 20, twenty: 20,
  trente: 30, thirty: 30,
  quarante: 40, forty: 40,
  cinquante: 50, fifty: 50,
  soixante: 60, sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const SCALES: Record<string, number> = {
  cent: 100, cents: 100, hundred: 100,
  mille: 1000, thousand: 1000,
  million: 1_000_000, millions: 1_000_000,
  milliard: 1_000_000_000, milliards: 1_000_000_000, billion: 1_000_000_000,
};

/* Words after a lone "neuf" that make it the number: "le neuf novembre", "neuf heures". */
const COUNTED =
  /^(?:janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre|heures?|h|minutes?|jours?|semaines?|mois|ans?|années?|annees?|personnes?|postes?|pour|%|mille|cents?)$/i;

const WORD = /[\p{L}]+(?:-[\p{L}]+)*|\d+(?:[.,]\d+)?|[^\s\p{L}\d]+|\s+/gu;

/* Stands for a token that is not a word (a digit, a comma, a full stop): no number reads across
   it. "Il y en a vingt. Deux sont partis." is 20 and 2, not 22. */
const STOP = '\u0000';

const ENGLISH = new Set([
  'zero', 'one', 'two', 'three', 'four', 'five', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty',
  'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand', 'billion',
]);

interface Word {
  text: string;
  /** Index of the token the word comes from. */
  token: number;
  /** Place of the word in a hyphenated token, and how many words that token has. */
  piece: number;
  pieces: number;
}

interface Run {
  first: number;
  last: number;
  value: string;
  /** True when the run is one ambiguous word that must stay a word. */
  ambiguous: boolean;
}

function kindOf(word: string): 'unit' | 'teen' | 'ten' | 'scale' | null {
  if (word in UNITS) return 'unit';
  if (word in TEENS) return 'teen';
  if (word in TENS) return 'ten';
  if (word in SCALES) return 'scale';
  return null;
}

/** The parts of a token: "quatre-vingt-dix" is three number words, "rendez-vous" none. */
function parts(token: string): string[] | null {
  const pieces = token.toLowerCase().split('-');
  return pieces.length > 1 && pieces.every((piece) => kindOf(piece) !== null || piece === 'et') ? pieces : null;
}

/**
 * Reads number words from `words[from]` on. Returns the value, how many words it used, or null
 * when the words do not start a number.
 */
function readNumber(words: string[], from: number): { value: number; used: number } | null {
  let total = 0;
  let current = 0;
  // What the last word was, to refuse "deux trois" and to read "quatre vingt" as 80.
  let last: 'unit' | 'teen' | 'ten' | 'scale' | 'and' | null = null;
  let lastUnit = 0;
  let lastTeen = 0;
  let lastScale = 0;
  let used = 0;
  for (let i = from; i < words.length; i++) {
    const word = words[i];
    const next = words[i + 1];
    // "vingt et un", "soixante et onze": "et" joins only those. "Deux et trois" is a range.
    if (word === 'et') {
      if (last === 'ten' && current % 10 === 0 && (next === 'un' || next === 'une' || next === 'onze')) {
        last = 'and';
        continue;
      }
      break;
    }
    // "two hundred and five": "and" only after a scale, before a number that takes no scale of its
    // own. "Between one hundred and two hundred" is two numbers, and so is "four and five".
    if (word === 'and') {
      const after = words[i + 2];
      // A larger scale after the next word still belongs: "one hundred and three thousand" is
      // 103,000. The same scale again starts a second number: "one hundred and two hundred".
      const larger = after !== undefined && kindOf(after) === 'scale' && SCALES[after] > lastScale;
      const joins =
        last === 'scale' &&
        next !== undefined &&
        kindOf(next) !== null &&
        kindOf(next) !== 'scale' &&
        (after === undefined || kindOf(after) !== 'scale' || larger);
      if (joins) {
        last = 'and';
        continue;
      }
      break;
    }
    const kind = kindOf(word);
    if (kind === null) break;
    if (kind === 'unit') {
      const n = UNITS[word];
      // A unit right after a unit or a teen starts another number: "deux trois" is 2 and 3.
      // Except after "dix": "dix-sept", "soixante-dix-neuf", "quatre-vingt-dix-huit".
      const afterDix = last === 'teen' && lastTeen === 10 && n >= 7;
      if (last === 'unit' || (last === 'teen' && !afterDix)) break;
      if (last === 'ten' && current % 10 !== 0) break;
      current += n;
      lastUnit = n;
    } else if (kind === 'teen') {
      const n = TEENS[word];
      if (last === 'unit' || last === 'teen') break;
      // "soixante dix" is 70, "quatre vingt dix" 90; "vingt dix" is not a number.
      if (last === 'ten' && current % 100 !== 60 && current % 100 !== 80) break;
      current += n;
      lastTeen = n;
    } else if (kind === 'ten') {
      const n = TENS[word];
      if (n === 20 && last === 'unit' && lastUnit === 4 && (word === 'vingt' || word === 'vingts')) {
        // "quatre vingt(s)": four twenties.
        current += 80 - 4;
      } else {
        if (last === 'ten' || last === 'teen' || last === 'unit') break;
        current += n;
      }
    } else {
      const scale = SCALES[word];
      // "trois virgule cinq millions": the decimals end before the scale, which stays a word.
      if (scale >= 1000 && (words[from - 1] === 'virgule' || words[from - 1] === 'point')) break;
      // "fifty cents", "two cents": the coin, not a hundred.
      if ((word === 'cent' || word === 'cents') && i > from && ENGLISH.has(words[i - 1])) break;
      lastScale = scale;
      if (scale === 100) {
        if (current % 100 !== current && current !== 0) break;
        current = (current === 0 ? 1 : current) * 100;
      } else {
        total += (current === 0 ? 1 : current) * scale;
        current = 0;
      }
    }
    last = kind;
    used = i - from + 1;
  }
  if (used === 0) return null;
  return { value: total + current, used };
}

/* The digits after "virgule" or "point": "trois virgule zéro cinq" is 3,05, "three point one
   four" 3.14, and "trois virgule vingt cinq" 3,25. Null when no number follows. */
function readFraction(words: string[], from: number): { digits: string; used: number } | null {
  const single: string[] = [];
  for (let i = from; i < words.length && words[i] in UNITS; i++) single.push(String(UNITS[words[i]]));
  if (single.length > 1) return { digits: single.join(''), used: single.length };
  const read = readNumber(words, from);
  return read ? { digits: String(read.value), used: read.used } : null;
}

/** The text with the numbers said in words written in digits. */
export function spokenNumbersToDigits(text: string): string {
  const tokens = text.match(WORD) ?? [];
  const words: Word[] = [];
  tokens.forEach((token, index) => {
    if (/^\s+$/.test(token)) return;
    if (!/\p{L}/u.test(token)) {
      words.push({ text: STOP, token: index, piece: 0, pieces: 1 });
      return;
    }
    const pieces = parts(token) ?? [token.toLowerCase()];
    pieces.forEach((piece, at) => words.push({ text: piece, token: index, piece: at, pieces: pieces.length }));
  });
  const texts = words.map((w) => w.text);

  const runs: Run[] = [];
  for (let i = 0; i < words.length; ) {
    const found = readNumber(texts, i);
    if (!found) {
      i += 1;
      continue;
    }
    let used = found.used;
    let value = String(found.value);
    const mark = texts[i + used];
    if (mark === 'virgule' || mark === 'point') {
      const fraction = readFraction(texts, i + used + 1);
      if (fraction) {
        value = `${value}${mark === 'virgule' ? ',' : '.'}${fraction.digits}`;
        used += 1 + fraction.used;
      }
    }
    const first = texts[i];
    const next = texts[i + used] ?? '';
    const lone = used === 1;
    const original = tokens[words[i].token];
    const ambiguous =
      lone &&
      (first === 'un' ||
        first === 'une' ||
        first === 'one' ||
        first === 'zero' ||
        first === 'zéro' ||
        // "million" alone stays a word: "2,4 millions", "a million", "a hundred".
        first in SCALES ||
        // "neuf" also means new, "seize" is also to seize, "Sept" also is September.
        ((first === 'neuf' || first === 'seize') && !COUNTED.test(next)) ||
        (first === 'sept' && /^S/.test(original)));
    runs.push({ first: i, last: i + used - 1, value, ambiguous });
    i += used;
  }

  const out = [...tokens];
  for (const run of runs) {
    if (run.ambiguous) continue;
    const start = words[run.first];
    const end = words[run.last];
    // Only whole tokens: "trois-rivières" stays, and so does "deux-trois" (two or three).
    if (start.piece !== 0 || end.piece !== end.pieces - 1) continue;
    out[start.token] = run.value;
    // The tokens in between, spaces included, are folded into the number.
    for (let t = start.token + 1; t <= end.token; t++) out[t] = '';
  }
  return out
    .join('')
    .replace(/(\d)\s+(?:pour\s*cent|pour-cent|percent|per\s+cent)\b/giu, '$1 %')
    .replace(/[ \t]{2,}/g, ' ');
}
