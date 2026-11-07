import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FileSystemAdapter } from 'obsidian';
import type { App } from 'obsidian';
import type { VaultIndexIO } from '../types.ts';
import { shortHash } from '../util/hash.ts';
import { writeFileAtomic } from './statsIO.ts';

const INDEX_FILE = 'index.json';
const VECTORS_FILE = 'vectors.bin';
const SLUG_MAX_LENGTH = 40;

/**
 * The directory name of one vault's index: readable (the vault's name) and
 * unique (a hash of where the vault is), so two vaults with the same name do
 * not share an index.
 */
export function indexDirName(vaultName: string, basePath: string): string {
  const slug = vaultName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, '');
  return `${slug || 'vault'}-${shortHash(basePath).slice(0, 8)}`;
}

/** '' for the whole vault, otherwise the folder with one trailing slash. */
function folderPrefix(folder: string): string {
  const trimmed = folder.trim().replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '' : `${trimmed}/`;
}

/** True when `path` is in one of `folders` ('' or '/' selects everything) and outside the config folder. */
export function inFolders(path: string, folders: string[], configDir: string): boolean {
  if (path === configDir || path.startsWith(`${configDir}/`)) return false;
  return folders.some((folder) => {
    const prefix = folderPrefix(folder);
    return prefix === '' || path.startsWith(prefix);
  });
}

/**
 * File access for the knowledge index: notes are read through Obsidian, the
 * index itself lives under the runtime directory, outside the vault (it is
 * large, rebuilt from the notes, and has no business being synced).
 * `runtimeDir` gives that directory already resolved (see `resolveRuntimeDir`).
 */
export function createVaultIndexIO(app: App, runtimeDir: () => string): VaultIndexIO {
  const { vault } = app;

  const indexDir = (): string => {
    const { adapter } = vault;
    const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : vault.getName();
    return join(runtimeDir(), 'index', indexDirName(vault.getName(), basePath));
  };

  let saving: Promise<void> = Promise.resolve();

  return {
    async listMarkdown(folders) {
      return vault
        .getMarkdownFiles()
        .filter((file) => inFolders(file.path, folders, vault.configDir))
        .map((file) => ({ path: file.path, mtime: file.stat.mtime }));
    },

    async read(path) {
      const file = vault.getFileByPath(path);
      if (!file) throw new Error(`${path} is not in the vault.`);
      return vault.cachedRead(file);
    },

    async load() {
      const dir = indexDir();
      /* A save cut short (Obsidian killed, the plugin unloaded with a save under way) leaves the
         temporary file it was writing, and writeFileAtomic removes it only when the write itself
         fails. Swept here, before the index is read: nothing else ever looks at the folder.
         Another window of the same vault saving at this very moment would lose that save and
         make it again, since its index stays dirty. */
      try {
        for (const name of await readdir(dir)) {
          if (name.endsWith('.tmp')) await rm(join(dir, name), { force: true }).catch(() => undefined);
        }
      } catch {
        // No folder yet: no index either.
      }
      try {
        const [index, vectors] = await Promise.all([
          readFile(join(dir, INDEX_FILE), 'utf8'),
          readFile(join(dir, VECTORS_FILE)),
        ]);
        return {
          index,
          vectors: new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength),
        };
      } catch {
        // No index yet, or half of one: the caller builds it again.
        return null;
      }
    },

    save(index, vectors) {
      const dir = indexDir();
      const run = saving.then(async () => {
        await mkdir(dir, { recursive: true });
        /* Two renames cannot be one step. Vectors go first, and both files
           carry the id of their save: a quit or a crash between the two leaves
           a pair of two saves, which the index refuses on load and rebuilds. */
        await writeFileAtomic(join(dir, VECTORS_FILE), vectors);
        await writeFileAtomic(join(dir, INDEX_FILE), index);
      });
      saving = run.catch(() => undefined);
      return run;
    },
  };
}
