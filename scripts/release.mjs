import { readFile, writeFile } from 'node:fs/promises';

/* Prepares a release: the version in package.json, manifest.json and versions.json.
 *
 *   node scripts/release.mjs 0.2.0
 *
 * Then commit, tag with the version itself (no "v"), and push the tag: .github/workflows/release.yml
 * builds and publishes it. */

const version = process.argv[2] ?? '';
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: node scripts/release.mjs <x.y.z>');
  process.exit(1);
}

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

const pkg = await readJson('package.json');
const manifest = await readJson('manifest.json');
const versions = await readJson('versions.json');

const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
if (!newer(version, manifest.version)) {
  console.error(`${version} is not after ${manifest.version}, the version in manifest.json.`);
  process.exit(1);
}

pkg.version = version;
manifest.version = version;
// What Obsidian consults when a newer version needs a newer app than the one running.
versions[version] = manifest.minAppVersion;
await writeJson('package.json', pkg);
await writeJson('manifest.json', manifest);
await writeJson('versions.json', versions);

console.log(`Version ${version} (Obsidian ${manifest.minAppVersion} or later). Then:`);
console.log(`  git commit -am "Release ${version}"`);
console.log(`  git tag ${version}`);
console.log(`  git push && git push origin ${version}`);
