import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/* Creates a small synthetic vault for trying the plugin without touching a
 * real one. Everything in it is invented; it only copies the SHAPE of a
 * PARA-style vault: dailies in "00 Inbox", an entity registry, meeting
 * headings with wikilinks, and heading-less "1:1 Name" blocks.
 *
 *   pnpm dev:vault            create ./dev-vault (keeps existing notes)
 *   pnpm install:plugin ./dev-vault
 *
 * Then in Obsidian: "Open folder as vault", choose dev-vault, and turn on
 * community plugins when asked.
 */

const root = resolve(process.argv[2] ?? 'dev-vault');

const today = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

const files = {
  '.obsidian/app.json': JSON.stringify({ newFileLocation: 'folder', newFileFolderPath: '00 Inbox' }, null, 2),
  '.obsidian/daily-notes.json': JSON.stringify({ folder: '00 Inbox' }, null, 2),
  '.obsidian/community-plugins.json': JSON.stringify(['magical-hamster'], null, 2),
  /* The plugin's settings for this vault's layout; the plugin's own defaults are for a vault it
     knows nothing of. Only these are stored: the rest follow the defaults. */
  '.obsidian/plugins/magical-hamster/data.json': JSON.stringify(
    {
      companionFolder: '00 Inbox',
      entitiesPath: '40 Resources/_entities.md',
      softMarkerPattern: '^(1:1|Ad ?Hoc|Prep|Steering|Rencontre)\\b',
      companionProperties: 'area: work\nstatus: active',
    },
    null,
    2,
  ),

  [`00 Inbox/${today}.md`]: `### 1:1 [[Jane Example]]

budget Q1 -> 2 options, Jane veut la B
hiring: PCO backfill, posting d'ici vendredi
- [ ] send the capacity plan to Jane

#### Risks
vendor contract pas signé, impact sur le kick-off

### [[Steering Board]]

dry run mardi
slides: garder 6 max

### Work

1:1 Sam

onboarding ok, needs access to the tracker

next step: shadow the intake meeting

Rencontre avec Alex et Maria

revue du backlog, 3 items bloqués
`,

  '40 Resources/_entities.md': `---
type: registry
area: work
status: active
---

# Entity registry

## Projects (active portfolio)

| canonical | wikilink | aliases | folder | area | active |
|---|---|---|---|---|---|
| Customer Portal Renewal | \`[[CPR]]\` | portal renewal, customer portal | \`10 Work/Projects/CPR.md\` | work | y |
| Identity Platform | \`[[IDP]]\` | identity, sso project | \`10 Work/Projects/IDP.md\` | work | y |

## People

| canonical | wikilink | aliases | role | area | active |
|---|---|---|---|---|---|
| Jane Example | \`[[Jane Example]]\` | Jane, the boss | Manager | work | y |
| Sam Rivera | \`[[Sam Rivera]]\` | Sam | Coordinator | work | y |
| Alex Tremblay | \`[[Alex Tremblay]]\` | Alex | Analyst | work | y |

## Governance bodies

| canonical       | wikilink             | aliases                | cadence | area | active |
| --------------- | -------------------- | ---------------------- | ------- | ---- | ------ |
| Steering Board  | \`[[Steering Board]]\` | SB, steering committee | weekly  | work | y      |
`,

  '10 Work/People/Jane Example.md': `---
type: person
area: work
status: active
---

# Jane Example

Manager. Prefers written updates before the 1:1.

## Priorities this quarter

- Budget for Q1: two options on the table, B keeps the vendor.
- Backfill for the coordinator role.
`,

  '10 Work/Projects/CPR.md': `---
type: project
area: work
status: active
---

# Customer Portal Renewal

Kick-off depends on the vendor contract. Target go-live is the end of Q2.

## Risks

- Vendor contract not signed.
- Single integration engineer.
`,

  'README.md': `# Dev vault

A synthetic vault for trying Magical Hamster. Nothing here is real.

1. \`pnpm install:plugin ./dev-vault\` from the repository.
2. In Obsidian: Open folder as vault, choose this folder, turn on community plugins.
3. Open today's note in \`00 Inbox\`, put the cursor under a meeting heading, and open the Magical Hamster sidebar.
`,
};

let created = 0;
for (const [rel, content] of Object.entries(files)) {
  const path = join(root, rel);
  await mkdir(join(path, '..'), { recursive: true });
  try {
    await stat(path);
  } catch {
    await writeFile(path, content);
    created += 1;
  }
}

/* The plugin list must name the plugin even when the file already existed. */
const pluginsPath = join(root, '.obsidian/community-plugins.json');
const enabled = JSON.parse(await readFile(pluginsPath, 'utf8'));
if (!enabled.includes('magical-hamster')) {
  enabled.push('magical-hamster');
  await writeFile(pluginsPath, JSON.stringify(enabled, null, 2));
}

console.log(`${root}: ${created} file(s) created, today's note is 00 Inbox/${today}.md`);
console.log('Next: pnpm install:plugin ./dev-vault, then open the folder as a vault in Obsidian.');
