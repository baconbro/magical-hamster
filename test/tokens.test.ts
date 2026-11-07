import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addEmbedTokens,
  addMeeting,
  addUsage,
  isoWeekKey,
  normalizeStats,
  savedDollars,
  tokensPerSecond,
  totalTokens,
  weeklySeries,
} from '../src/llm/tokens.ts';
import type { ChatUsage, Stats } from '../src/types.ts';

const EMPTY: Stats = { input: 0, output: 0, cached: 0, weekly: {}, meetings: 0, assists: 0 };

function usage(patch: Partial<ChatUsage> = {}): ChatUsage {
  return {
    model: 'gemma4:12b',
    promptTokens: 1000,
    cachedTokens: 0,
    outputTokens: 100,
    totalMs: 4000,
    loadMs: 0,
    promptMs: 1250,
    evalMs: 2500,
    ...patch,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/* Dates are built from local calendar fields so the tests hold in any time zone. */

test('isoWeekKey: the Monday of the week, local time', () => {
  assert.equal(isoWeekKey(new Date(2026, 9, 5, 0, 0, 0)), '2026-10-05', 'a Monday at midnight is its own week');
  assert.equal(isoWeekKey(new Date(2026, 9, 7, 15, 30)), '2026-10-05');
  assert.equal(isoWeekKey(new Date(2026, 9, 10, 9, 0)), '2026-10-05', 'Saturday');
});

test('isoWeekKey: a Sunday belongs to the week that started six days earlier', () => {
  assert.equal(isoWeekKey(new Date(2026, 9, 11, 0, 0, 1)), '2026-10-05');
  assert.equal(isoWeekKey(new Date(2026, 9, 11, 23, 59, 59)), '2026-10-05');
  assert.equal(isoWeekKey(new Date(2026, 9, 12, 0, 0, 0)), '2026-10-12', 'the next Monday starts a new week');
});

test('isoWeekKey: across a year boundary', () => {
  // 1 January 2026 is a Thursday; its week started in 2025.
  assert.equal(isoWeekKey(new Date(2026, 0, 1, 12)), '2025-12-29');
  assert.equal(isoWeekKey(new Date(2025, 11, 31, 12)), '2025-12-29');
  assert.equal(isoWeekKey(new Date(2026, 0, 4, 23, 59)), '2025-12-29', 'the Sunday that closes it');
  assert.equal(isoWeekKey(new Date(2026, 0, 5, 0, 0)), '2026-01-05');
  // 1 January 2028 is a Saturday, in a leap year's first week.
  assert.equal(isoWeekKey(new Date(2028, 0, 1, 12)), '2027-12-27');
});

test('isoWeekKey: across a month boundary and a daylight-saving change', () => {
  assert.equal(isoWeekKey(new Date(2026, 10, 1, 12)), '2026-10-26', 'Sunday 1 November');
  // Clocks change on 8 March and 1 November 2026 in North America; the keys must not shift.
  assert.equal(isoWeekKey(new Date(2026, 2, 8, 12)), '2026-03-02');
  assert.equal(isoWeekKey(new Date(2026, 2, 9, 0, 30)), '2026-03-09');
});

test('addUsage: adds to the totals and to the week, and counts an assist', () => {
  const when = new Date(2026, 9, 7, 10);
  const once = addUsage(EMPTY, usage({ cachedTokens: 400 }), when);
  assert.deepEqual(once, {
    input: 1000,
    output: 100,
    cached: 400,
    weekly: { '2026-10-05': { input: 1000, output: 100 } },
    meetings: 0,
    assists: 1,
  });

  const twice = addUsage(once, usage({ promptTokens: 50, outputTokens: 5 }), new Date(2026, 9, 9, 10), false);
  assert.deepEqual(twice.weekly, { '2026-10-05': { input: 1050, output: 105 } });
  assert.equal(twice.assists, 1, 'countAssist false leaves assists alone');
  assert.equal(twice.cached, 400);

  const nextWeek = addUsage(twice, usage(), new Date(2026, 9, 12, 8));
  assert.deepEqual(Object.keys(nextWeek.weekly).sort(), ['2026-10-05', '2026-10-12']);
  assert.equal(nextWeek.assists, 2);
  assert.equal(totalTokens(nextWeek), 1050 + 105 + 1100);
});

test('the stats passed in are never modified', () => {
  const start = deepFreeze<Stats>({
    input: 10,
    output: 5,
    cached: 1,
    weekly: { '2026-10-05': { input: 10, output: 5 } },
    meetings: 2,
    assists: 3,
  });
  const snapshot = JSON.stringify(start);
  const when = new Date(2026, 9, 6);

  const a = addUsage(start, usage(), when);
  const b = addEmbedTokens(start, 300, when);
  const c = addMeeting(start);
  const d = normalizeStats(start);

  assert.equal(JSON.stringify(start), snapshot);
  for (const next of [a, b, c, d]) assert.notEqual(next, start);
  assert.notEqual(a.weekly, start.weekly);
  assert.notEqual(a.weekly['2026-10-05'], start.weekly['2026-10-05']);
  assert.notEqual(b.weekly, start.weekly);
  assert.notEqual(d.weekly, start.weekly);
  assert.deepEqual(a.weekly['2026-10-05'], { input: 1010, output: 105 });
});

test('addEmbedTokens: counts toward input only', () => {
  const stats = addEmbedTokens(EMPTY, 6400, new Date(2026, 9, 10));
  assert.deepEqual(stats, {
    input: 6400,
    output: 0,
    cached: 0,
    weekly: { '2026-10-05': { input: 6400, output: 0 } },
    meetings: 0,
    assists: 0,
  });
  assert.deepEqual(addEmbedTokens(stats, Number.NaN, new Date(2026, 9, 10)).input, 6400);
  assert.deepEqual(addEmbedTokens(stats, -5, new Date(2026, 9, 10)).input, 6400);
});

test('addMeeting, totalTokens and savedDollars', () => {
  const stats = addMeeting(addMeeting({ ...EMPTY, input: 1_500_000, output: 500_000 }));
  assert.equal(stats.meetings, 2);
  assert.equal(totalTokens(stats), 2_000_000);
  assert.equal(savedDollars(stats, 0.002), 4);
  assert.equal(savedDollars(EMPTY, 0.002), 0);
  assert.equal(savedDollars(stats, 0), 0);
  assert.equal(savedDollars(stats, Number.NaN), 0);
  assert.equal(savedDollars(stats, -1), 0);
});

test('weeklySeries: oldest first, zero-filled, ending with the current week', () => {
  const stats: Stats = {
    ...EMPTY,
    weekly: {
      '2026-10-05': { input: 700, output: 70 },
      '2026-09-21': { input: 300, output: 30 },
      '2026-08-03': { input: 9999, output: 9999 },
    },
  };
  const today = new Date(2026, 9, 10, 18);
  assert.deepEqual(weeklySeries(stats, 4, today), [
    { week: '2026-09-14', input: 0, output: 0, total: 0 },
    { week: '2026-09-21', input: 300, output: 30, total: 330 },
    { week: '2026-09-28', input: 0, output: 0, total: 0 },
    { week: '2026-10-05', input: 700, output: 70, total: 770 },
  ]);
  assert.deepEqual(weeklySeries(EMPTY, 2, today), [
    { week: '2026-09-28', input: 0, output: 0, total: 0 },
    { week: '2026-10-05', input: 0, output: 0, total: 0 },
  ]);
  assert.deepEqual(weeklySeries(stats, 0, today), []);
  assert.deepEqual(weeklySeries(stats, -3, today), []);
});

test('weeklySeries: steps by calendar weeks across a year end and a clock change', () => {
  const series = weeklySeries(EMPTY, 12, new Date(2026, 0, 8));
  assert.equal(series.length, 12);
  assert.deepEqual(
    series.slice(-3).map((w) => w.week),
    ['2025-12-22', '2025-12-29', '2026-01-05'],
  );
  assert.equal(series[0]?.week, '2025-10-20');
  for (const { week } of series) {
    const [y, m, d] = week.split('-').map(Number) as [number, number, number];
    assert.equal(new Date(y, m - 1, d).getDay(), 1, `${week} is a Monday`);
  }
});

test('weeklySeries: a week count that is not a finite number gives an empty series', () => {
  const today = new Date(2026, 9, 10);
  // Infinity used to loop until the process ran out of memory.
  assert.deepEqual(weeklySeries(EMPTY, Number.POSITIVE_INFINITY, today), []);
  assert.deepEqual(weeklySeries(EMPTY, Number.NaN, today), []);
  assert.equal(weeklySeries(EMPTY, 2.9, today).length, 2);
});

test('isoWeekKey and weeklySeries: every day of four years lands on consecutive Mondays', () => {
  let previous = '';
  for (let d = new Date(2025, 0, 1, 12); d.getFullYear() < 2029; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12)) {
    for (const hour of [0, 2, 23]) {
      const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 30);
      const key = isoWeekKey(at);
      const [y, m, day] = key.split('-').map(Number) as [number, number, number];
      const monday = new Date(y, m - 1, day, 12);
      assert.equal(monday.getDay(), 1, `${key} is a Monday`);
      const back = Math.round((d.getTime() - monday.getTime()) / 86_400_000);
      assert.ok(back >= 0 && back <= 6, `${key} is within the week of ${at.toString()}`);
    }
    const [older, current] = weeklySeries(EMPTY, 2, d);
    assert.equal(current?.week, isoWeekKey(d));
    if (d.getDay() === 1 && previous) assert.equal(older?.week, previous, 'the series steps back exactly one week');
    if (d.getDay() === 1) previous = isoWeekKey(d);
  }
});

test('normalizeStats: garbage becomes empty stats', () => {
  for (const raw of [null, undefined, 42, 'stats', true, [], [1, 2, 3], () => 1]) {
    assert.deepEqual(normalizeStats(raw), EMPTY);
  }
  assert.deepEqual(normalizeStats({}), EMPTY);
});

test('normalizeStats: keeps what is valid and drops the rest', () => {
  const raw = {
    input: 1200.9,
    output: '300',
    cached: -4,
    meetings: Number.NaN,
    assists: Number.POSITIVE_INFINITY,
    extra: 'ignored',
    weekly: {
      '2026-10-05': { input: 100, output: 20, noise: true },
      '2026-09-28': { input: 'many', output: null },
      '2026-09-21': null,
      '2026-09-14': 7,
      'last week': { input: 1, output: 1 },
      '2026-9-7': { input: 1, output: 1 },
    },
  };
  assert.deepEqual(normalizeStats(raw), {
    input: 1200,
    output: 0,
    cached: 0,
    weekly: {
      '2026-10-05': { input: 100, output: 20 },
      '2026-09-28': { input: 0, output: 0 },
    },
    meetings: 0,
    assists: 0,
  });
  assert.deepEqual(normalizeStats({ input: 5, weekly: 'nope' }).weekly, {});
  assert.deepEqual(normalizeStats({ input: 5, weekly: [{ input: 1, output: 1 }] }).weekly, {});
});

test('normalizeStats: valid stats round-trip through JSON', () => {
  const stats = addMeeting(addUsage(EMPTY, usage({ cachedTokens: 12 }), new Date(2026, 9, 7)));
  assert.deepEqual(normalizeStats(JSON.parse(JSON.stringify(stats))), stats);
});

test('tokensPerSecond: speeds, and 0 when a duration is 0', () => {
  assert.deepEqual(tokensPerSecond(usage()), { prompt: 800, output: 40 });
  assert.deepEqual(tokensPerSecond(usage({ promptMs: 0, evalMs: 0 })), { prompt: 0, output: 0 });
  assert.deepEqual(tokensPerSecond(usage({ promptMs: 0 })), { prompt: 0, output: 40 });
  assert.deepEqual(tokensPerSecond(usage({ evalMs: 0 })), { prompt: 800, output: 0 });
});

test('tokensPerSecond: the cached prefix does not inflate the prompt speed', () => {
  // 900 of 1000 prompt tokens came from the cache; only 100 were evaluated in 125 ms.
  assert.deepEqual(tokensPerSecond(usage({ cachedTokens: 900, promptMs: 125 })), { prompt: 800, output: 40 });
  assert.equal(tokensPerSecond(usage({ cachedTokens: 1000, promptMs: 5 })).prompt, 0);
  assert.equal(tokensPerSecond(usage({ cachedTokens: 2000, promptMs: 5 })).prompt, 0);
});
