import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it, mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as setup from '../scripts/setup-stt.mjs';

/* The speech setup's helpers, imported: what the script decides before it
   touches the network or the disk, on any platform. The script as the user
   runs it is in scripts.test.ts, on Apple Silicon only. */

const REPO = fileURLToPath(new URL('..', import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), 'hamster-setup-stt-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let cases = 0;
function scratchDir(): string {
  cases += 1;
  const dir = join(scratch, `case-${cases}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const HEX64 = /^[0-9a-f]{64}$/;
const NAME_560 = setup.assetName(560);
const PIN_560 = setup.KNOWN_SHA256[NAME_560] as string;
const OTHER_HASH = '1'.repeat(64);
const USER_HASH = '2'.repeat(64);
const NO_OPTS = { modelUrl: '', sha256: '', noVerify: false };

/** A release asset as GitHub's API lists it. */
function ghAsset(name: string, digest?: string) {
  return {
    name,
    browser_download_url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${name}`,
    size: 475_271_763,
    ...(digest ? { digest: `sha256:${digest}` } : {}),
  };
}

describe('the pinned checksums', () => {
  it('cover exactly the builds of MODEL_DATE, one per chunk size, as 64 lowercase hex digits', () => {
    const expected = setup.CHUNKS.map((chunkMs: number) => `${setup.MODEL_PREFIX}-${chunkMs}ms-int8-${setup.MODEL_DATE}.tar.bz2`);
    assert.deepEqual(Object.keys(setup.KNOWN_SHA256).sort(), [...expected].sort());
    assert.equal(expected.length, 5);
    for (const [name, hash] of Object.entries(setup.KNOWN_SHA256)) assert.match(String(hash), HEX64, name);
    assert.equal(new Set(Object.values(setup.KNOWN_SHA256)).size, 5, 'five different archives, five different hashes');
  });

  it('are the ones protocol/segments.md records', () => {
    const table = readFileSync(join(REPO, 'protocol', 'segments.md'), 'utf8');
    for (const [name, hash] of Object.entries(setup.KNOWN_SHA256)) {
      assert.ok(table.includes(`| \`${name}\` |`), `${name} is in the table`);
      assert.ok(table.includes(`\`${String(hash)}\``), `${name}'s hash is in the table`);
    }
  });
});

describe('pickAsset', () => {
  it('takes the newest build of the chunk size and parses the sha256: digest GitHub gives', () => {
    const older = setup.assetName(560, '2026-05-01');
    const newer = setup.assetName(560, '2026-08-01');
    const assets = [
      ghAsset(newer, OTHER_HASH),
      ghAsset(older, '3'.repeat(64)),
      ghAsset(setup.assetName(1120), '4'.repeat(64)),
      { name: 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-09-01.txt' },
      { name: `${newer}.sha256` },
    ];
    const asset = setup.pickAsset(assets, 560);
    assert.ok(asset);
    assert.equal(asset.name, newer);
    assert.equal(asset.url, `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${newer}`);
    assert.equal(asset.size, 475_271_763);
    assert.equal(asset.sha256, OTHER_HASH);
    assert.equal(asset.source, 'GitHub');
    assert.equal(asset.chunkMs, 560);
  });

  it('falls back to the pin when the asset has no digest, and to nothing when it is not pinned either', () => {
    const pinned = setup.pickAsset([ghAsset(NAME_560)], 560);
    assert.ok(pinned);
    assert.equal(pinned.sha256, PIN_560);
    assert.equal(pinned.source, 'the script');

    const unpinned = setup.pickAsset([ghAsset(setup.assetName(560, '2026-08-01'))], 560);
    assert.ok(unpinned);
    assert.equal(unpinned.sha256, null);
    assert.equal(unpinned.source, null);

    const withDigest = setup.pickAsset([ghAsset(NAME_560, OTHER_HASH)], 560);
    assert.ok(withDigest);
    assert.equal(withDigest.sha256, OTHER_HASH, 'what GitHub says today, not the pin');
    assert.equal(withDigest.source, 'GitHub');
  });

  it('is null when the release has no build of that chunk size', () => {
    assert.equal(setup.pickAsset([ghAsset(setup.assetName(1120))], 560), null);
    assert.equal(setup.pickAsset([], 560), null);
  });
});

describe('patternAsset', () => {
  it('names the build of MODEL_DATE and carries its pin', () => {
    for (const chunkMs of setup.CHUNKS as number[]) {
      const asset = setup.patternAsset(chunkMs);
      assert.equal(asset.name, setup.assetName(chunkMs));
      assert.equal(asset.url, `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${asset.name}`);
      assert.equal(asset.sha256, setup.KNOWN_SHA256[asset.name]);
      assert.equal(asset.source, 'the script');
      assert.equal(asset.chunkMs, chunkMs);
    }
  });
});

describe('checksumFor', () => {
  const github = { name: NAME_560, url: 'https://example.invalid/a', size: null, sha256: OTHER_HASH, source: 'GitHub', chunkMs: 560 };
  const fromUrl = { name: NAME_560, url: 'file:///tmp/a.tar.bz2', size: null, sha256: null, source: null, chunkMs: 560 };
  const unknown = { ...fromUrl, name: setup.assetName(560, '2026-08-01') };

  it('prefers --sha256, then the digest the asset came with, then the pin by name, then nothing', () => {
    assert.deepEqual(setup.checksumFor(github, { ...NO_OPTS, sha256: USER_HASH }), { sha256: USER_HASH, source: '--sha256' });
    assert.deepEqual(setup.checksumFor(github, NO_OPTS), { sha256: OTHER_HASH, source: 'GitHub' });
    assert.deepEqual(setup.checksumFor(fromUrl, NO_OPTS), { sha256: PIN_560, source: 'the script' });
    assert.equal(setup.checksumFor(unknown, NO_OPTS), null);
    assert.deepEqual(setup.checksumFor(unknown, { ...NO_OPTS, sha256: USER_HASH }), { sha256: USER_HASH, source: '--sha256' });
  });

  it('keeps the source of a pinned asset the release listed without a digest', () => {
    const asset = setup.pickAsset([ghAsset(NAME_560)], 560);
    assert.ok(asset);
    assert.deepEqual(setup.checksumFor(asset, NO_OPTS), { sha256: PIN_560, source: 'the script' });
  });
});

describe('resolveAsset', () => {
  it('takes the pinned pattern asset when the release API cannot be asked', async () => {
    const log = mock.method(console, 'log', () => {});
    try {
      const asset = await setup.resolveAsset(560, NO_OPTS, async () => {
        throw new Error('fetch failed');
      });
      assert.deepEqual(asset, setup.patternAsset(560));
      assert.equal(asset.sha256, PIN_560);
      const said = log.mock.calls.map((call) => String(call.arguments[0]));
      assert.ok(said.some((line) => line.includes("GitHub's release API did not answer (fetch failed)")), said.join('\n'));
    } finally {
      log.mock.restore();
    }
  });

  it('takes the archive --model-url names, with no checksum of its own', async () => {
    const url = 'file:///Users/someone/Downloads/' + NAME_560;
    const asset = await setup.resolveAsset(560, { ...NO_OPTS, modelUrl: url, chunkMs: 560 }, async () => {
      throw new Error('must not be asked');
    });
    assert.equal(asset.name, NAME_560);
    assert.equal(asset.url, url);
    assert.equal(asset.sha256, null);
    assert.equal(asset.source, null);
  });

  it('takes the 1120 ms build when the release has no build of the chunk size asked for', async () => {
    const log = mock.method(console, 'log', () => {});
    try {
      const asset = await setup.resolveAsset(560, NO_OPTS, async () => [ghAsset(setup.assetName(1120), OTHER_HASH)]);
      assert.equal(asset.chunkMs, 1120);
      assert.equal(asset.sha256, OTHER_HASH);
    } finally {
      log.mock.restore();
    }
  });
});

describe('parseArgs', () => {
  it('takes --sha256 in either case and --no-verify, and refuses what is not a sha256', () => {
    const upper = setup.parseArgs(['--sha256', USER_HASH.toUpperCase()]);
    assert.equal(upper.sha256, USER_HASH);
    assert.equal(upper.noVerify, false);
    assert.equal(setup.parseArgs(['--no-verify']).noVerify, true);
    assert.throws(() => setup.parseArgs(['--sha256', 'abc']), { name: 'SetupStop', message: /64 hex/ });
    assert.throws(() => setup.parseArgs(['--sha256', `${USER_HASH}0`]), { name: 'SetupStop', message: /64 hex/ });
    assert.throws(() => setup.parseArgs(['--sha256']), { name: 'SetupStop', message: /needs a value/ });
    assert.throws(() => setup.parseArgs(['--sha256', USER_HASH, '--no-verify']), { name: 'SetupStop', message: /contradict/ });
  });

  it('still reads the chunk size out of a --model-url', () => {
    const opts = setup.parseArgs(['--model-url', `file:///tmp/${setup.assetName(1120)}`]);
    assert.equal(opts.chunkMs, 1120);
    assert.throws(() => setup.parseArgs(['--chunk-ms', '560', '--model-url', `file:///tmp/${setup.assetName(1120)}`]), {
      name: 'SetupStop',
      message: /1120 ms build but --chunk-ms says 560/,
    });
  });
});

describe('the speech library', () => {
  it('is asked for at an exact version, and an installed 1.x from there on is kept', () => {
    assert.equal(setup.SHERPA_VERSION, '1.13.8');
    assert.equal(setup.SHERPA_SPEC, 'sherpa-onnx-node@1.13.8');
    assert.equal(setup.sherpaUsable('1.13.8'), true);
    assert.equal(setup.sherpaUsable('1.14.0'), true);
    assert.equal(setup.sherpaUsable('1.13.7'), false);
    assert.equal(setup.sherpaUsable('1.9.30'), false);
    assert.equal(setup.sherpaUsable('2.0.1'), false, 'another major is not what the worker was written against');
    assert.equal(setup.versionAtLeast('22.23.4', [22]), true);
    assert.equal(setup.versionAtLeast('20.19.0', [22]), false);
  });

  it('is not installed into someone else’s project', () => {
    const ours = scratchDir();
    writeFileSync(join(ours, 'package.json'), JSON.stringify({ name: setup.RUNTIME_NAME, private: true }));
    assert.equal(setup.otherProjectIn(ours), null);
    assert.equal(setup.otherProjectIn(join(ours, 'not-yet')), null, 'a folder the setup will create');

    const theirs = scratchDir();
    writeFileSync(join(theirs, 'package.json'), JSON.stringify({ name: 'someone-elses-project', version: '3.0.0' }));
    assert.equal(setup.otherProjectIn(theirs), 'someone-elses-project');

    const nameless = scratchDir();
    writeFileSync(join(nameless, 'package.json'), '{}');
    assert.equal(setup.otherProjectIn(nameless), '(unnamed)');
  });
});

describe('the download', () => {
  it('is fetched over HTTPS or from a file, with redirects to HTTPS only, and given up when it stalls', () => {
    const args = setup.curlArgs('https://github.com/x/y.tar.bz2', '/tmp/y.part');
    assert.deepEqual(args.slice(-3), ['-o', '/tmp/y.part', 'https://github.com/x/y.tar.bz2']);
    assert.deepEqual(args.slice(0, 6), ['-L', '--fail', '--proto', '=https,file', '--proto-redir', '=https']);
    for (const pair of [
      ['--connect-timeout', '30'],
      ['--retry', '3'],
      ['--retry-delay', '2'],
      ['--speed-limit', '1024'],
      ['--speed-time', '60'],
    ]) {
      const at = args.indexOf(pair[0]);
      assert.ok(at > 0, pair[0]);
      assert.equal(args[at + 1], pair[1], pair[0]);
    }
    assert.ok(args.includes('--progress-bar'));
    assert.equal(setup.curlArgs('file:///Users/me/y.tar.bz2', '/tmp/y.part')[3], '=https,file');
  });

  it('allows plain HTTP only for an address that asks for it', () => {
    assert.equal(setup.curlArgs('http://mirror.example/y.tar.bz2', '/tmp/y.part')[3], '=https,file,http');
    assert.equal(setup.curlArgs('http://mirror.example/y.tar.bz2', '/tmp/y.part')[5], '=https', 'but a redirect still has to be HTTPS');
  });

  it('is extracted with the system tar on a Mac', () => {
    const tar = setup.tarCommand();
    if (process.platform === 'darwin' && existsSync('/usr/bin/tar')) assert.equal(tar, '/usr/bin/tar');
    else assert.equal(tar, 'tar');
  });

  it('is refused when the archive holds a link or anything else that is not a plain file', () => {
    const clean = scratchDir();
    mkdirSync(join(clean, 'model', 'test_wavs'), { recursive: true });
    writeFileSync(join(clean, 'model', 'tokens.txt'), '<blk> 0\n');
    writeFileSync(join(clean, 'model', 'test_wavs', 'fr.wav'), '');
    assert.equal(setup.findSpecialEntry(clean), null);

    const linked = scratchDir();
    mkdirSync(join(linked, 'model', 'test_wavs'), { recursive: true });
    writeFileSync(join(linked, 'model', 'tokens.txt'), '<blk> 0\n');
    symlinkSync('/nowhere/outside', join(linked, 'model', 'test_wavs', 'fr.wav'));
    assert.equal(setup.findSpecialEntry(linked), join('model', 'test_wavs', 'fr.wav'));

    const linkedDir = scratchDir();
    mkdirSync(join(linkedDir, 'model'));
    symlinkSync(clean, join(linkedDir, 'model', 'test_wavs'));
    assert.equal(setup.findSpecialEntry(linkedDir), join('model', 'test_wavs'), 'a linked directory is not walked into');
  });
});

describe('writeFileAtomicSync', () => {
  it('leaves the file whole and no temporary beside it', () => {
    const dir = scratchDir();
    const file = join(dir, 'runtime.json');
    setup.writeFileAtomicSync(file, '{"first":true}\n');
    setup.writeFileAtomicSync(file, '{"second":true}\n');
    assert.equal(readFileSync(file, 'utf8'), '{"second":true}\n');
    assert.deepEqual(readdirSync(dir), ['runtime.json']);
  });

  it('removes its temporary when the file cannot be put in place, and leaves what was there', () => {
    const dir = scratchDir();
    // A directory where the file should go: the rename fails, the write before it did not.
    mkdirSync(join(dir, 'runtime.json'));
    writeFileSync(join(dir, 'runtime.json', 'keep'), '');
    assert.throws(() => setup.writeFileAtomicSync(join(dir, 'runtime.json'), '{}'));
    assert.deepEqual(readdirSync(dir), ['runtime.json']);
    assert.deepEqual(readdirSync(join(dir, 'runtime.json')), ['keep']);
  });
});

describe('the release build of the script', () => {
  it('exports the same helpers, with the same pins', async () => {
    const out = join(scratchDir(), 'setup-speech.mjs');
    const build = spawnSync(process.execPath, [join(REPO, 'scripts', 'build-setup.mjs'), out], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);

    // Imported, not run: the setup runs only as the script Node was started with.
    const built = (await import(pathToFileURL(out).href)) as typeof setup;
    assert.deepEqual(Object.keys(built).sort(), Object.keys(setup).sort());
    assert.deepEqual(built.KNOWN_SHA256, setup.KNOWN_SHA256);
    assert.equal(built.SHERPA_SPEC, setup.SHERPA_SPEC);
    assert.deepEqual(built.checksumFor(built.patternAsset(560), NO_OPTS), { sha256: PIN_560, source: 'the script' });
    assert.equal(existsSync(join(scratch, 'runtime.json')), false, 'importing it set nothing up');
  });
});
