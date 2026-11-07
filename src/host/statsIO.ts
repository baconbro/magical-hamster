import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeStats } from '../llm/tokens.ts';
import type { Stats, StatsIO } from '../types.ts';

const FILE_NAME = 'stats.json';

/**
 * Writes `data` beside `path` and renames it into place, so a crash or a quit
 * in the middle leaves the previous file, never half of the new one.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temp = `${path}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

const NO_WEEK = { input: 0, output: 0 };

/**
 * What to write when the file may have changed since this session last read
 * or wrote it: what the file holds now (`disk`), plus what the session has
 * counted since (`current` less `baseline`, the session's own figures at that
 * last read or write). Every vault window writes the same file, so writing
 * `current` as it is would drop whatever another window added meanwhile.
 * A session only ever counts up: a figure below its baseline adds nothing.
 */
export function mergeStats(disk: Stats, baseline: Stats, current: Stats): Stats {
  const sum = (onDisk: number, before: number, now: number): number => onDisk + Math.max(0, now - before);

  const weekly: Stats['weekly'] = {};
  for (const [week, entry] of Object.entries(disk.weekly)) weekly[week] = { ...entry };
  for (const [week, now] of Object.entries(current.weekly)) {
    const before = baseline.weekly[week] ?? NO_WEEK;
    const onDisk = disk.weekly[week];
    // A week the file does not have is started only by tokens of this session's own.
    if (!onDisk && now.input <= before.input && now.output <= before.output) continue;
    const held = onDisk ?? NO_WEEK;
    weekly[week] = {
      input: sum(held.input, before.input, now.input),
      output: sum(held.output, before.output, now.output),
    };
  }

  return {
    input: sum(disk.input, baseline.input, current.input),
    output: sum(disk.output, baseline.output, current.output),
    cached: sum(disk.cached, baseline.cached, current.cached),
    weekly,
    meetings: sum(disk.meetings, baseline.meetings, current.meetings),
    assists: sum(disk.assists, baseline.assists, current.assists),
  };
}

/**
 * Token statistics in `<runtimeDir>/stats.json`: outside the vault, so they
 * are never synced. `runtimeDir` gives the folder already resolved (see
 * `resolveRuntimeDir`): a `~` in it would be taken for a folder of that name.
 *
 * The file is one for the whole device, whatever the vault: with two vault
 * windows open it has two writers. A save therefore reads the file again and
 * adds this session's own part to it (see `mergeStats`). Two saves from two
 * windows in the same few milliseconds can still cost one of them its part.
 */
export function createStatsIO(runtimeDir: () => string): StatsIO {
  // One save at a time, in the order asked: a slow older save must not land on a newer one.
  let chain: Promise<void> = Promise.resolve();
  /* The session's figures when it last read the file or wrote to it; what it
     holds beyond them is its own. Null until then. */
  let baseline: Stats | null = null;

  const read = async (dir: string): Promise<Stats | null> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, FILE_NAME), 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      return parsed as Stats;
    } catch {
      // Missing or corrupt: the counters start again.
      return null;
    }
  };

  return {
    async load(): Promise<Stats | null> {
      const loaded = await read(runtimeDir());
      // Normalized as the session does it: the figures it starts from, zero when there is no file.
      baseline = normalizeStats(loaded);
      return loaded;
    },

    save(stats: Stats): Promise<void> {
      const dir = runtimeDir();
      const run = chain.then(async () => {
        const disk = baseline ? await read(dir) : null;
        /* Nothing to add to (no file, or one that cannot be read), or a
           session that never loaded: its own figures are all there is. */
        const next =
          baseline && disk ? mergeStats(normalizeStats(disk), baseline, normalizeStats(stats)) : stats;
        await mkdir(dir, { recursive: true });
        await writeFileAtomic(join(dir, FILE_NAME), `${JSON.stringify(next, null, 2)}\n`);
        // Only now: after a failed save the next one still carries this part.
        baseline = normalizeStats(stats);
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}
