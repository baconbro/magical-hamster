import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* The command-line scripts, run as the user runs them: against scratch vaults,
   scratch runtime directories and local archives. Nothing here touches the
   network or the real runtime directory. */

const REPO = fileURLToPath(new URL('..', import.meta.url));
const script = (name: string): string => join(REPO, 'scripts', name);

const scratch = mkdtempSync(join(tmpdir(), 'hamster-scripts-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let cases = 0;
function scratchDir(): string {
  cases += 1;
  const dir = join(scratch, `case-${cases}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function write(path: string, text: string | Uint8Array = ''): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** `seconds` of silence as 16 kHz, 16-bit, mono WAV. */
function silence(path: string, seconds: number): string {
  const rate = 16000;
  const dataBytes = rate * 2 * seconds;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  return write(path, wav);
}

describe('setup-speech.mjs, the speech setup of a release', () => {
  function build(): string {
    const dir = scratchDir();
    const out = join(dir, 'setup-speech.mjs');
    const run = spawnSync(process.execPath, [script('build-setup.mjs'), out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return out;
  }

  it('carries the worker files of this repository, unchanged', () => {
    const text = readFileSync(build(), 'utf8');
    const embedded = /^const EMBEDDED_WORKER = (\{.*\});$/m.exec(text);
    assert.ok(embedded, 'the files are embedded');
    const files = JSON.parse(embedded[1]) as Record<string, string>;
    const repo = readdirSync(join(REPO, 'stt')).filter((name) => name.endsWith('.cjs')).sort();
    assert.deepEqual(Object.keys(files).sort(), repo);
    for (const name of repo) assert.equal(files[name], readFileSync(join(REPO, 'stt', name), 'utf8'), name);
  });

  it('runs away from the repository and names itself in its help', () => {
    const run = spawnSync(process.execPath, [build(), '--help'], { encoding: 'utf8', cwd: tmpdir() });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^Usage: node setup-speech\.mjs /);
  });

  it(
    'writes the embedded worker where the repository version copies it',
    { skip: process.platform === 'darwin' && process.arch === 'arm64' ? false : 'the speech setup runs on Apple Silicon only' },
    () => {
      const runtime = join(scratchDir(), 'rt');
      const run = spawnSync(process.execPath, [build(), '--dry-run', '--runtime', runtime], { encoding: 'utf8', cwd: tmpdir() });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, new RegExp(`would write ${runtime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/worker\\.cjs`));
      assert.doesNotMatch(run.stdout, /copy stt\/|fix-sherpa-rpath/);
    },
  );
});

describe('install-plugin', () => {
  /** A folder to run the script from: it takes the build from ./dist. */
  function built(): string {
    const dir = scratchDir();
    write(join(dir, 'dist', 'manifest.json'), JSON.stringify({ id: 'magical-hamster', name: 'Magical Hamster' }));
    for (const file of ['main.js', 'styles.css']) write(join(dir, 'dist', file), `// ${file}\n`);
    return dir;
  }
  const INSTALLED = ['.selfreload', 'main.js', 'manifest.json', 'styles.css'];

  function install(cwd: string, args: string[], env: Record<string, string> = {}) {
    const clean = { ...process.env, ...env };
    if (!('HAMSTER_VAULT' in env)) delete clean.HAMSTER_VAULT;
    if (!('HAMSTER_CONFIG_DIR' in env)) delete clean.HAMSTER_CONFIG_DIR;
    return spawnSync(process.execPath, [script('install-plugin.mjs'), ...args], { cwd, env: clean, encoding: 'utf8' });
  }

  it('installs into .obsidian by default', () => {
    const cwd = built();
    const vault = join(cwd, 'vault');
    mkdirSync(join(vault, '.obsidian'), { recursive: true });
    const run = install(cwd, [vault]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(readdirSync(join(vault, '.obsidian', 'plugins', 'magical-hamster')).sort(), INSTALLED);
  });

  it('says how the new build gets loaded: by itself, or by hand for an older build', () => {
    const cwd = built();
    const vault = join(cwd, 'vault');
    const plugin = join(vault, '.obsidian', 'plugins', 'magical-hamster');
    mkdirSync(join(vault, '.obsidian'), { recursive: true });

    const first = install(cwd, [vault]);
    assert.equal(first.status, 0, first.stderr);
    assert.doesNotMatch(first.stdout, /previous build|by itself/, 'a first install has nothing to replace');

    // The build just installed is a stand-in without the self-reload code: an older build.
    const byHand = install(cwd, [vault]);
    assert.equal(byHand.status, 0, byHand.stderr);
    assert.match(byHand.stdout, /still running the previous build: turn Magical Hamster off and on again/);

    write(join(plugin, 'main.js'), 'console.debug(`magical-hamster:self-reload: watching ${dir}`);');
    const itself = install(cwd, [vault]);
    assert.equal(itself.status, 0, itself.stderr);
    assert.match(itself.stdout, /loads this build by itself/);
    assert.doesNotMatch(itself.stdout, /previous build/);
  });

  it('removes the .hotreload an earlier install left, which would let the Hot Reload plugin in', () => {
    const cwd = built();
    const vault = join(cwd, 'vault');
    const plugin = join(vault, '.obsidian', 'plugins', 'magical-hamster');
    write(join(plugin, '.hotreload'), '');
    const run = install(cwd, [vault]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(readdirSync(plugin).sort(), INSTALLED);
  });

  it('installs into the config folder named as the second argument, not into a leftover .obsidian', () => {
    const cwd = built();
    const vault = join(cwd, 'vault');
    mkdirSync(join(vault, '.obsidian'), { recursive: true });
    mkdirSync(join(vault, '.obsidian-desktop'), { recursive: true });

    const run = install(cwd, [vault, '.obsidian-desktop']);

    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(readdirSync(join(vault, '.obsidian-desktop', 'plugins', 'magical-hamster')).sort(), INSTALLED);
    assert.equal(existsSync(join(vault, '.obsidian', 'plugins')), false, 'the folder this device does not read');
    assert.match(run.stdout, /Installed to .*\.obsidian-desktop\/plugins\/magical-hamster/);
  });

  it('takes the vault and its config folder from the environment', () => {
    const cwd = built();
    const vault = join(cwd, 'vault');
    mkdirSync(join(vault, '.obsidian-desktop'), { recursive: true });

    const run = install(cwd, [], { HAMSTER_VAULT: vault, HAMSTER_CONFIG_DIR: '.obsidian-desktop' });

    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(readdirSync(join(vault, '.obsidian-desktop', 'plugins', 'magical-hamster')).sort(), INSTALLED);
  });

  it('says how to name another config folder when .obsidian is not there', () => {
    const cwd = built();
    const vault = join(cwd, 'vault');
    mkdirSync(join(vault, '.obsidian-desktop'), { recursive: true });

    const run = install(cwd, [vault]);

    assert.equal(run.status, 1);
    assert.match(run.stderr, /\.obsidian is not there/);
    assert.match(run.stderr, /another config folder can name it/);
    assert.match(run.stderr, /HAMSTER_CONFIG_DIR/);
    assert.deepEqual(readdirSync(join(vault, '.obsidian-desktop')), [], 'nothing was copied anywhere');
  });

  it('still refuses a folder that is not a vault', () => {
    const cwd = built();
    const run = install(cwd, [join(cwd, 'nowhere'), '.obsidian-desktop']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /does not look like an Obsidian vault/);
  });

  it('puts the third-party notices next to main.js when the repository has them', () => {
    const cwd = built();
    const vault = join(cwd, 'vault');
    mkdirSync(join(vault, '.obsidian'), { recursive: true });
    // At the root, beside dist/: the file is not part of the build.
    write(join(cwd, 'THIRD_PARTY_NOTICES.md'), '# Third-party notices\n\nMIT License\n');

    const run = install(cwd, [vault]);

    assert.equal(run.status, 0, run.stderr);
    const plugin = join(vault, '.obsidian', 'plugins', 'magical-hamster');
    assert.deepEqual(readdirSync(plugin).sort(), [...INSTALLED, 'THIRD_PARTY_NOTICES.md'].sort());
    assert.equal(readFileSync(join(plugin, 'THIRD_PARTY_NOTICES.md'), 'utf8'), '# Third-party notices\n\nMIT License\n');
  });

  it('looks for the notices where the repository keeps them', () => {
    // The test above runs from a scratch folder: a file renamed in the repository would go unnoticed there.
    assert.equal(existsSync(join(REPO, 'THIRD_PARTY_NOTICES.md')), true);
  });
});

describe('bench-stt against a worker that dies', () => {
  /* A stand-in for the installed worker: it says it is ready, never reads its
     input (so the sender's pipe fills up), and ends the way a crash in native
     code ends a process, by a signal. */
  function dyingRuntime(): string {
    const dir = scratchDir();
    write(
      join(dir, 'worker.cjs'),
      [
        "process.stdout.write(JSON.stringify({ type: 'ready', model: 'stand-in', chunkMs: 560 }) + '\\n');",
        "setTimeout(() => process.kill(process.pid, 'SIGKILL'), 600);",
        '',
      ].join('\n'),
    );
    write(join(dir, 'runtime.json'), JSON.stringify({ node: process.execPath, modelDir: join(dir, 'models', 'm') }));
    return dir;
  }

  /** Runs the bench; `ended` is false when it had to be killed after `limitMs`. */
  function bench(args: string[], limitMs: number) {
    return new Promise<{ ended: boolean; code: number | null; stderr: string; tookMs: number }>((resolve) => {
      const started = performance.now();
      const child = spawn(process.execPath, [script('bench-stt.mjs'), ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (text: string) => {
        stderr += text;
      });
      let ended = true;
      const timer = setTimeout(() => {
        ended = false;
        child.kill('SIGKILL');
      }, limitMs);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ ended, code, stderr, tookMs: performance.now() - started });
      });
    });
  }

  it('stops replaying the recording once the worker was killed by a signal', async () => {
    const runtime = dyingRuntime();
    const wav = silence(join(runtime, 'twenty-seconds.wav'), 20);

    const run = await bench([wav, '--runtime', runtime], 8000);

    assert.ok(run.ended, `still pacing frames to a dead worker after ${Math.round(run.tookMs)} ms\n${run.stderr}`);
    assert.match(run.stderr, /^exit {7}SIGKILL$/m);
    assert.equal(run.code, 1);
  });

  it('does not wait for a dead worker to take more audio with --fast', async () => {
    const runtime = dyingRuntime();
    // Far more than a pipe holds: the sender is waiting for room when the worker dies.
    const wav = silence(join(runtime, 'two-minutes.wav'), 120);

    const run = await bench([wav, '--runtime', runtime, '--fast'], 8000);

    assert.ok(run.ended, `still waiting on the dead worker's input after ${Math.round(run.tookMs)} ms\n${run.stderr}`);
    assert.match(run.stderr, /^exit {7}SIGKILL$/m);
    assert.match(run.stderr, /^finals {5}0$/m, 'the summary is printed');
    assert.equal(run.code, 1);
  });

  it('still runs a healthy worker to the end, paced or not', async () => {
    const dir = scratchDir();
    const wav = silence(join(dir, 'short.wav'), 1);
    for (const mode of [['--fast'], []]) {
      const run = await bench([wav, '--fake', ...mode], 15000);
      assert.ok(run.ended, run.stderr);
      assert.match(run.stderr, /^exit {7}0$/m, run.stderr);
    }
  });
});

describe(
  'setup-stt',
  { skip: process.platform === 'darwin' && process.arch === 'arm64' ? false : 'setup:stt runs on Apple Silicon only' },
  () => {
    const MODEL = 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11';
    // A build the script has no checksum for: not in its table, and nothing says what it should be.
    const UNPINNED = 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-07-01';
    const MODEL_FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'];
    // A library that loads and hears nothing, which is all a second of silence asks of it.
    const LOADING_LIBRARY = [
      'class OnlineRecognizer {',
      '  createStream() { return { acceptWaveform() {}, inputFinished() {}, setOption() {} }; }',
      '  isReady() { return false; }',
      '  decode() {}',
      '  isEndpoint() { return false; }',
      '  reset() {}',
      "  getResult() { return { text: '' }; }",
      '}',
      "module.exports = { OnlineRecognizer, version: '1.13.8' };",
      '',
    ].join('\n');

    /**
     * A runtime directory in which the speech library looks installed, so the
     * npm step is skipped. `library` is the package's main file: left out, the
     * package cannot be loaded at all.
     */
    function runtimeWith(library?: string): string {
      const dir = join(scratchDir(), 'runtime');
      const sherpa = join(dir, 'node_modules', 'sherpa-onnx-node');
      write(join(sherpa, 'package.json'), JSON.stringify({ name: 'sherpa-onnx-node', version: '1.13.8', main: 'index.js' }));
      if (library !== undefined) write(join(sherpa, 'index.js'), library);
      write(join(dir, 'node_modules', 'sherpa-onnx-darwin-arm64', 'sherpa-onnx.node'), 'not a real addon');
      return dir;
    }

    /**
     * A .tar.bz2 named `name` holding the given files (path inside the archive -> content).
     * `prepare` may add to the tree before it is packed.
     */
    function archive(name: string, files: Record<string, string>, prepare?: (tree: string) => void): string {
      const dir = scratchDir();
      const tree = join(dir, 'tree');
      mkdirSync(tree);
      for (const [path, text] of Object.entries(files)) write(join(tree, path), text);
      prepare?.(tree);
      const file = join(dir, name);
      const tar = spawnSync('tar', ['cjf', file, '-C', tree, ...readdirSync(tree)], { encoding: 'utf8' });
      assert.equal(tar.status, 0, tar.stderr);
      return file;
    }

    const modelFiles = (dir: string): Record<string, string> =>
      Object.fromEntries(MODEL_FILES.map((name) => [`${dir}/${name}`, 'placeholder']));

    const sha256Of = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

    function setup(args: string[]) {
      return spawnSync(process.execPath, [script('setup-stt.mjs'), ...args], { encoding: 'utf8' });
    }

    it('refuses a --model-url whose file name holds an encoded slash, before touching anything', () => {
      // Nested, so that even the path the name used to lead to stays inside the scratch directory.
      const base = scratchDir();
      const runtime = join(base, 'a', 'b', 'runtime');
      const outside = write(join(base, 'a', 'b', 'escaped-560ms-int8.tar.bz2.part'), 'not ours to delete');
      const url = `${pathToFileURL(join(base, 'url')).href}/x%2F..%2F..%2F..%2Fescaped-560ms-int8.tar.bz2`;

      for (const mode of [['--dry-run'], []]) {
        const run = setup([...mode, '--runtime', runtime, '--model-url', url]);
        assert.equal(run.status, 1, run.stdout);
        assert.match(run.stderr, /--model-url must end in a plain <model>\.tar\.bz2 file name/);
        assert.doesNotMatch(run.stdout, /escaped/);
      }
      assert.equal(readFileSync(outside, 'utf8'), 'not ours to delete');
      assert.equal(existsSync(runtime), false, 'stopped while reading its arguments');
    });

    it('refuses other names that are not a plain file name, and still takes an ordinary one', () => {
      const runtime = join(scratchDir(), 'runtime');
      for (const name of ['.hidden-560ms-int8.tar.bz2', 'a%00b-560ms-int8.tar.bz2', 'a%5Cb-560ms-int8.tar.bz2', 'a b-560ms-int8.tar.bz2']) {
        const run = setup(['--dry-run', '--runtime', runtime, '--model-url', `file:///tmp/${name}`]);
        assert.equal(run.status, 1, name);
        assert.match(run.stderr, /plain <model>\.tar\.bz2 file name/, name);
      }
      const run = setup(['--dry-run', '--runtime', runtime, '--model-url', `file:///tmp/${MODEL}.tar.bz2`]);
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, new RegExp(`"model": "${MODEL.replaceAll('.', '\\.')}"`));
      assert.match(run.stdout, /would check its sha256 against the checksum pinned in the script/);
    });

    it('does not start a download nothing vouches for, and says what would', () => {
      const runtime = join(scratchDir(), 'runtime');
      const url = `file:///tmp/${UNPINNED}.tar.bz2`;

      const unknown = setup(['--dry-run', '--runtime', runtime, '--model-url', url]);
      assert.equal(unknown.status, 1, unknown.stdout);
      assert.match(unknown.stderr, new RegExp(`no checksum is known for ${UNPINNED.replaceAll('.', '\\.')}\\.tar\\.bz2\\. Pass --sha256 <hex>`));
      assert.match(unknown.stderr, /or --no-verify/);
      assert.doesNotMatch(unknown.stdout, /would download/);

      const vouched = setup(['--dry-run', '--runtime', runtime, '--model-url', url, '--sha256', 'a'.repeat(64)]);
      assert.equal(vouched.status, 0, vouched.stderr);
      assert.match(vouched.stdout, /would check its sha256 against --sha256/);

      const waived = setup(['--dry-run', '--runtime', runtime, '--model-url', url, '--no-verify']);
      assert.equal(waived.status, 0, waived.stderr);
      assert.match(waived.stdout, /would NOT check its sha256 \(--no-verify\)/);
      assert.equal(existsSync(runtime), false, 'dry runs');
    });

    it('deletes a download that does not match --sha256, and records nothing', () => {
      const runtime = runtimeWith(LOADING_LIBRARY);
      const models = join(runtime, 'models');
      const file = archive(`${UNPINNED}.tar.bz2`, modelFiles(UNPINNED));
      const right = sha256Of(file);
      const wrong = right.replace(/^./, right.startsWith('0') ? '1' : '0');

      const run = setup(['--runtime', runtime, '--model-url', pathToFileURL(file).href, '--sha256', wrong]);

      assert.equal(run.status, 1, run.stdout);
      assert.match(run.stderr, /the download does not match --sha256/);
      assert.ok(run.stderr.includes(`expected ${wrong}, got ${right}`), run.stderr);
      assert.deepEqual(readdirSync(models), [], 'the .part is deleted and nothing was extracted');
      assert.equal(existsSync(join(runtime, 'runtime.json')), false);
    });

    it('takes a download that matches --sha256 and says what it was verified against', () => {
      const runtime = runtimeWith(LOADING_LIBRARY);
      const file = archive(`${UNPINNED}.tar.bz2`, modelFiles(UNPINNED));
      const right = sha256Of(file);

      const run = setup(['--runtime', runtime, '--model-url', pathToFileURL(file).href, '--sha256', right.toUpperCase()]);

      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
      assert.match(run.stdout, /verified against --sha256/);
      assert.doesNotMatch(run.stdout, /NOT verified/);
      const record = JSON.parse(readFileSync(join(runtime, 'runtime.json'), 'utf8')) as Record<string, unknown>;
      assert.equal(record.sha256, right);
      assert.equal(readFileSync(join(runtime, 'models', `${UNPINNED}.sha256`), 'utf8'), `${right}  ${UNPINNED}.tar.bz2\n`);
    });

    it('checks an archive it knows against its pin, --model-url or not', () => {
      // The real archive's name, not its content: the pin cannot match.
      const runtime = runtimeWith(LOADING_LIBRARY);
      const file = archive(`${MODEL}.tar.bz2`, modelFiles(MODEL));

      const run = setup(['--runtime', runtime, '--model-url', pathToFileURL(file).href]);

      assert.equal(run.status, 1, run.stdout);
      assert.match(run.stderr, /the download does not match the checksum pinned in the script: expected c6bf5e0d/);
      assert.deepEqual(readdirSync(join(runtime, 'models')), []);
    });

    it('refuses an archive that holds a link', () => {
      const runtime = runtimeWith(LOADING_LIBRARY);
      const models = join(runtime, 'models');
      const linked = archive(`${MODEL}.tar.bz2`, modelFiles(MODEL), (tree) => {
        symlinkSync('/nowhere/outside', join(tree, MODEL, 'README.md'));
      });

      const run = setup(['--runtime', runtime, '--model-url', pathToFileURL(linked).href, '--no-verify']);

      assert.equal(run.status, 1, run.stdout);
      assert.match(run.stderr, new RegExp(`the archive holds a link or special file: ${MODEL.replaceAll('.', '\\.')}/README\\.md`));
      assert.deepEqual(readdirSync(models), [], 'no staging directory and no download');
      assert.equal(existsSync(join(runtime, 'runtime.json')), false);
    });

    it('does not install into a folder that holds another project', () => {
      const runtime = join(scratchDir(), 'runtime');
      write(join(runtime, 'package.json'), JSON.stringify({ name: 'someone-elses-project', version: '3.0.0' }));

      const run = setup(['--dry-run', '--runtime', runtime]);

      assert.equal(run.status, 1, run.stdout);
      assert.match(run.stderr, /holds another project \(someone-elses-project\)\. Choose another folder with --runtime\./);
      assert.doesNotMatch(run.stdout, /npm install/);
      assert.deepEqual(readdirSync(runtime), ['package.json']);
    });

    it('installs the library at an exact version with npm scripts off', () => {
      const runtime = join(scratchDir(), 'runtime');
      const run = setup(['--dry-run', '--runtime', runtime]);
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /would run in .*: .*npm install sherpa-onnx-node@1\.13\.8 --save-exact --ignore-scripts --no-audit --no-fund$/m);
      assert.match(run.stdout, /would download it with curl -L --fail --proto =https,file --proto-redir =https /);
      assert.match(run.stdout, /would check its sha256 against the checksum GitHub publishes, or the one pinned in the script/);
    });

    it('leaves nothing in models/ when the archive is not the model', () => {
      const runtime = runtimeWith();
      const models = join(runtime, 'models');
      const twoFolders = archive(`${MODEL}.tar.bz2`, { 'one/readme.txt': 'x', 'two/readme.txt': 'y' });
      const incomplete = archive(`${MODEL}.tar.bz2`, { [`${MODEL}/tokens.txt`]: 'x' });

      for (const [file, message] of [
        [twoFolders, /the archive did not contain the expected directory/],
        [incomplete, /the archive is missing model files/],
        [twoFolders, /the archive did not contain the expected directory/],
      ] as const) {
        const run = setup(['--runtime', runtime, '--model-url', pathToFileURL(file).href, '--no-verify']);
        assert.equal(run.status, 1, run.stdout);
        assert.match(run.stderr, message);
        assert.deepEqual(readdirSync(models), [], 'no staging directory and no partial download');
      }
      assert.equal(existsSync(join(runtime, 'runtime.json')), false);
    });

    it('clears what an interrupted extraction left behind, whatever it was called', () => {
      const runtime = runtimeWith();
      const models = join(runtime, 'models');
      // The process-numbered name of earlier versions, and the name used now.
      write(join(models, '.extract-65424', MODEL, 'encoder.int8.onnx'), 'half of a model');
      write(join(models, `.extract-${MODEL}.tar.bz2`, MODEL, 'encoder.int8.onnx'), 'half of a model');
      write(join(models, 'notes.txt'), 'not ours');
      const notTheModel = archive(`${MODEL}.tar.bz2`, { 'one/readme.txt': 'x', 'two/readme.txt': 'y' });

      const run = setup(['--runtime', runtime, '--model-url', pathToFileURL(notTheModel).href, '--no-verify']);

      assert.equal(run.status, 1, run.stdout);
      assert.deepEqual(readdirSync(models), ['notes.txt']);
    });

    it('does not record a runtime whose library cannot load, test recordings or not', () => {
      const runtime = runtimeWith();
      const noRecordings = archive(`${MODEL}.tar.bz2`, modelFiles(MODEL));

      const run = setup(['--runtime', runtime, '--model-url', pathToFileURL(noRecordings).href, '--no-verify']);

      assert.equal(run.status, 1, run.stdout);
      assert.match(run.stdout, /came without test recordings/);
      assert.match(run.stderr, /the speech library or the model did not load \(exit code 3\)/);
      assert.match(run.stderr, /Nothing was recorded in runtime\.json/);
      assert.equal(existsSync(join(runtime, 'runtime.json')), false);
      assert.equal(existsSync(join(runtime, '.self-test-silence.wav')), false, 'the silence it played is removed');
      assert.doesNotMatch(run.stdout, /The speech runtime is ready/);
    });

    it('records a runtime that loads when the model came without test recordings', () => {
      const runtime = runtimeWith(LOADING_LIBRARY);
      const noRecordings = archive(`${MODEL}.tar.bz2`, modelFiles(MODEL));

      const run = setup(['--runtime', runtime, '--model-url', pathToFileURL(noRecordings).href, '--no-verify']);

      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
      assert.match(run.stdout, /NOT verified \(--no-verify\)/);
      assert.match(run.stdout, /The speech library and the model loaded\. Nothing was transcribed\./);
      assert.match(run.stdout, /0 segment\(s\) from 1 s of audio/);
      const record = JSON.parse(readFileSync(join(runtime, 'runtime.json'), 'utf8')) as Record<string, unknown>;
      assert.equal(record.model, MODEL);
      assert.equal(record.chunkMs, 560);
      assert.equal(record.sha256, sha256Of(noRecordings), 'recorded even when it was not checked');
      assert.equal(record.sherpaVersion, '1.13.8');
      assert.equal(existsSync(join(runtime, '.self-test-silence.wav')), false);
      assert.deepEqual(readdirSync(join(runtime, 'models')).sort(), [MODEL, `${MODEL}.sha256`]);
      assert.deepEqual(
        readdirSync(runtime).filter((name) => name.endsWith('.tmp')),
        [],
        'runtime.json is renamed into place',
      );

      // A runtime installed elsewhere than the default is the one thing left to set in the plugin.
      const closing = run.stdout.slice(run.stdout.indexOf('The speech runtime is ready.'));
      assert.ok(closing.includes(`runs the speech worker with the Node recorded in runtime.json: ${String(record.node)}`), closing);
      assert.ok(closing.includes(`  Runtime folder  ${runtime}`), closing);
      assert.doesNotMatch(closing, /Node path|Runtime directory/);
    });

    it('names no setting when the runtime goes where the plugin looks by itself', () => {
      // A home of its own: the default folder is then inside the scratch directory, and a dry run writes nothing.
      const home = scratchDir();
      const standard = join(home, 'Library', 'Application Support', 'magical-hamster');
      const dry = (args: string[]) =>
        spawnSync(process.execPath, [script('setup-stt.mjs'), '--dry-run', ...args], {
          encoding: 'utf8',
          env: { ...process.env, HOME: home },
        });

      for (const args of [[], ['--runtime', `${standard}/`]]) {
        const run = dry(args);
        assert.equal(run.status, 0, run.stderr);
        const closing = run.stdout.slice(run.stdout.indexOf('Dry run: nothing was changed.'));
        assert.match(closing, /Once installed, the plugin runs the speech worker with the Node recorded in runtime\.json: \S/);
        assert.match(closing, /It finds this folder by itself: there is nothing to set in Obsidian\./);
        assert.doesNotMatch(closing, /Runtime folder|Node path|Runtime directory/);
      }
      assert.deepEqual(readdirSync(home), [], 'a dry run');

      const elsewhere = join(scratchDir(), 'runtime');
      const run = dry(['--runtime', elsewhere]);
      assert.equal(run.status, 0, run.stderr);
      assert.ok(run.stdout.includes(`It looks for the runtime in ${standard}, not here.`), run.stdout);
      assert.ok(run.stdout.includes(`  Runtime folder  ${elsewhere}`), run.stdout);
      assert.doesNotMatch(run.stdout, /Node path/);
    });
  },
);
