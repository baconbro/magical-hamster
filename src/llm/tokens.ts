import type { ChatUsage, Stats } from '../types.ts';
import { isoDate } from '../util/text.ts';

/* The "tokens saved" figure: tokens processed on-device instead of by a paid
   API. Every function returns a new Stats; the input is never modified. */

const WEEK_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Local midnight of the Monday of `d`'s week. */
function mondayOf(d: Date): Date {
  const sinceMonday = (d.getDay() + 6) % 7;
  // Built from calendar fields, not by subtracting milliseconds: a week that
  // contains a daylight-saving change is not 7 x 24 hours long.
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - sinceMonday);
}

/** Monday of `d`'s week, local time, YYYY-MM-DD. */
export function isoWeekKey(d: Date): string {
  return isoDate(mondayOf(d));
}

function amount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function addToWeek(stats: Stats, when: Date, input: number, output: number): Stats['weekly'] {
  const key = isoWeekKey(when);
  const week = stats.weekly[key] ?? { input: 0, output: 0 };
  return { ...stats.weekly, [key]: { input: week.input + input, output: week.output + output } };
}

/** Adds one generation. Pass `countAssist` false for the extra calls behind a single assist
    (a warm-up, the map steps of a long summary). */
export function addUsage(stats: Stats, usage: ChatUsage, when: Date, countAssist = true): Stats {
  const input = amount(usage.promptTokens);
  const output = amount(usage.outputTokens);
  return {
    ...stats,
    input: stats.input + input,
    output: stats.output + output,
    cached: stats.cached + amount(usage.cachedTokens),
    weekly: addToWeek(stats, when, input, output),
    assists: stats.assists + (countAssist ? 1 : 0),
  };
}

/** Embedding tokens count toward input: a paid API bills them the same way. */
export function addEmbedTokens(stats: Stats, tokens: number, when: Date): Stats {
  const input = amount(tokens);
  return { ...stats, input: stats.input + input, weekly: addToWeek(stats, when, input, 0) };
}

export function addMeeting(stats: Stats): Stats {
  return { ...stats, meetings: stats.meetings + 1 };
}

export function totalTokens(stats: Stats): number {
  return stats.input + stats.output;
}

export function savedDollars(stats: Stats, costPer1k: number): number {
  if (!Number.isFinite(costPer1k) || costPer1k <= 0) return 0;
  return (totalTokens(stats) / 1000) * costPer1k;
}

/** The last `weeks` weeks, oldest first, zero-filled, ending with today's week. */
export function weeklySeries(
  stats: Stats,
  weeks: number,
  today: Date,
): Array<{ week: string; input: number; output: number; total: number }> {
  const monday = mondayOf(today);
  const series: Array<{ week: string; input: number; output: number; total: number }> = [];
  // Infinity would never count down to zero.
  const count = Number.isFinite(weeks) ? Math.floor(weeks) : 0;
  for (let back = count - 1; back >= 0; back -= 1) {
    const start = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7 * back);
    const week = isoDate(start);
    const entry = stats.weekly[week];
    const input = entry?.input ?? 0;
    const output = entry?.output ?? 0;
    series.push({ week, input, output, total: input + output });
  }
  return series;
}

/** Stats from whatever was on disk: an older version, a hand edit, or nothing at all. */
export function normalizeStats(raw: unknown): Stats {
  const source: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const weekly: Stats['weekly'] = {};
  const rawWeekly = source.weekly;
  if (typeof rawWeekly === 'object' && rawWeekly !== null && !Array.isArray(rawWeekly)) {
    for (const [key, value] of Object.entries(rawWeekly as Record<string, unknown>)) {
      if (!WEEK_KEY.test(key) || typeof value !== 'object' || value === null) continue;
      const entry = value as Record<string, unknown>;
      weekly[key] = { input: amount(entry.input), output: amount(entry.output) };
    }
  }

  return {
    input: amount(source.input),
    output: amount(source.output),
    cached: amount(source.cached),
    weekly,
    meetings: amount(source.meetings),
    assists: amount(source.assists),
  };
}

/**
 * Speeds of one generation, in tokens per second; 0 when the duration is 0.
 * The prompt speed counts only the tokens that were evaluated: Ollama's prompt
 * count includes the cached prefix, which costs no time.
 */
export function tokensPerSecond(usage: ChatUsage): { prompt: number; output: number } {
  const evaluated = Math.max(0, usage.promptTokens - usage.cachedTokens);
  return {
    prompt: usage.promptMs > 0 ? evaluated / (usage.promptMs / 1000) : 0,
    output: usage.evalMs > 0 ? usage.outputTokens / (usage.evalMs / 1000) : 0,
  };
}
