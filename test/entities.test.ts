import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { classifyHeading, entityNames, findEntity, parseEntities } from '../src/editor/entities.ts';
import { listSections, wikilinks } from '../src/editor/sectionAt.ts';
import type { Entity } from '../src/types.ts';

/* A synthetic registry with the shape of the real one: `## ` sections, one
   table each, some padded, one without a delimiter row. */
const REGISTRY = [
  '---',
  'type: registry',
  '---',
  '# Entity registry',
  '',
  'Read by tools | do not rename the columns.',
  '',
  '## Projects (active portfolio)',
  '| canonical | wikilink | aliases | folder | area | active |',
  '|---|---|---|---|---|---|',
  '| Identity & Access Management | `[[IAM]]` | identity & access mgmt, identity access | `10 Work/Projects/IAM.md` | work | y |',
  '| Research & Development | `[[R&D]]` | | `10 Work/Projects/R&D.md` | work | y |',
  '| Legacy Portal | `[[Legacy Portal]]` | portal | `90 Archive/Legacy Portal.md` | work | n |',
  '',
  '## People',
  '| canonical | wikilink | aliases | role | area | active |',
  '| Jane Example | `[[Jane Example]]` | Jane, the boss | Manager | work | y |',
  '| Sam Placeholder | `[[Sam Placeholder]]` | Sam | Analyst | work | yes |',
  '',
  '## Governance bodies',
  '| canonical               | wikilink            | aliases                 | cadence | area | active |',
  '| ----------------------- | ------------------- | ----------------------- | ------- | ---- | ------ |',
  '| Steering Board          | `[[Steering Board]]`| SB, steering committee  | weekly  | work | y      |',
  '| Office of Governance       | `[[OGOV]]`          | —                       | monthly | work | TRUE   |',
  '',
  '## Systems & external references',
  '| canonical | wikilink | aliases |',
  '|---|---|---|',
  '| Ticket Tracker | | tracker; TT |',
  '',
  '## Career / strategic concepts',
  '| wikilink | canonical | active |',
  '|:--|:-:|--:|',
  '| `[[Concepts/Outcome Ownership\\|ownership]]` | Outcome ownership | y |',
  '',
].join('\n');

const ENTITIES = parseEntities(REGISTRY);
const byName = (name: string): Entity => {
  const entity = ENTITIES.find((e) => e.name === name);
  assert.ok(entity, `no entity named ${name}`);
  return entity;
};

describe('parseEntities', () => {
  test('reads every row of every table', () => {
    assert.deepEqual(
      ENTITIES.map((e) => [e.name, e.kind]),
      [
        ['Identity & Access Management', 'project'],
        ['Research & Development', 'project'],
        ['Legacy Portal', 'project'],
        ['Jane Example', 'person'],
        ['Sam Placeholder', 'person'],
        ['Steering Board', 'governance'],
        ['Office of Governance', 'governance'],
        ['Ticket Tracker', 'other'],
        ['Outcome ownership', 'other'],
      ],
    );
  });

  test('a project row', () => {
    assert.deepEqual(byName('Identity & Access Management'), {
      name: 'Identity & Access Management',
      link: 'IAM',
      aliases: ['identity & access mgmt', 'identity access'],
      kind: 'project',
      active: true,
    });
    assert.deepEqual(byName('Research & Development').aliases, []);
    assert.equal(byName('Research & Development').link, 'R&D');
  });

  test('a people table without a delimiter row', () => {
    assert.deepEqual(byName('Jane Example'), {
      name: 'Jane Example',
      link: 'Jane Example',
      aliases: ['Jane', 'the boss'],
      kind: 'person',
      active: true,
    });
  });

  test('padded cells', () => {
    assert.deepEqual(byName('Steering Board'), {
      name: 'Steering Board',
      link: 'Steering Board',
      aliases: ['SB', 'steering committee'],
      kind: 'governance',
      active: true,
    });
    // A dash stands for "none".
    assert.deepEqual(byName('Office of Governance').aliases, []);
    assert.equal(byName('Office of Governance').link, 'OGOV');
  });

  test('active is y, yes or true in any case; anything else is inactive', () => {
    assert.equal(byName('Legacy Portal').active, false);
    assert.equal(byName('Sam Placeholder').active, true);
    assert.equal(byName('Office of Governance').active, true);
    const [blank, no] = parseEntities('## People\n| canonical | active |\n| A One |  |\n| B Two | no |');
    assert.equal(blank.active, false);
    assert.equal(no.active, false);
  });

  test('a missing active column means active', () => {
    assert.equal(byName('Ticket Tracker').active, true);
  });

  test('an empty wikilink cell falls back to the name', () => {
    assert.deepEqual(byName('Ticket Tracker'), {
      name: 'Ticket Tracker',
      link: 'Ticket Tracker',
      aliases: ['tracker', 'TT'],
      kind: 'other',
      active: true,
    });
  });

  test('columns are found by header name, not position', () => {
    assert.deepEqual(byName('Outcome ownership'), {
      name: 'Outcome ownership',
      // Backticks, brackets and the alias are gone; the escaped pipe did not split the cell.
      link: 'Concepts/Outcome Ownership',
      aliases: [],
      kind: 'other',
      active: true,
    });
  });

  test('sections are classified by the start of their heading, in any case', () => {
    const kinds = parseEntities(
      [
        '## PROJECTS',
        '| canonical |',
        '| P |',
        '## people (team)',
        '| canonical |',
        '| Q |',
        '## Governance',
        '| canonical |',
        '| R |',
        '## Other people',
        '| canonical |',
        '| S |',
      ].join('\n'),
    ).map((e) => [e.name, e.kind]);
    assert.deepEqual(kinds, [
      ['P', 'project'],
      ['Q', 'person'],
      ['R', 'governance'],
      ['S', 'other'],
    ]);
  });

  test('a ### inside a section keeps its kind; tables need a known header', () => {
    const entities = parseEntities(
      [
        '## People',
        '### Direct reports',
        '| canonical | wikilink |',
        '|---|---|',
        '| Alex Sample | [[Alex Sample]] |',
        '',
        '| Robin Sample | [[Robin Sample\\|Robin]] |',
        '',
        '## Notes',
        '| day | what |',
        '|---|---|',
        '| Monday | nothing to see |',
      ].join('\n'),
    );
    assert.deepEqual(
      entities.map((e) => [e.name, e.link, e.kind]),
      [
        ['Alex Sample', 'Alex Sample', 'person'],
        // A table continued after a blank line reuses the header of its section.
        ['Robin Sample', 'Robin Sample', 'person'],
      ],
    );
  });

  test('another table in the same section, with columns of its own, is not read as entities', () => {
    const entities = parseEntities(
      [
        '## Governance bodies',
        '| canonical | wikilink | aliases | active |',
        '|---|---|---|---|',
        '| Steering Board | [[Steering Board]] | SB | y |',
        '',
        'Legend:',
        '',
        '| cadence | meaning | example | used |',
        '|---|---|---|---|',
        '| weekly | every week | [[Steering Board]] | y |',
        '| monthly | every month | — | y |',
      ].join('\n'),
    );
    assert.deepEqual(
      entities.map((e) => e.name),
      ['Steering Board'],
    );
    // Otherwise every heading with "weekly" in it would look like a meeting.
    assert.deepEqual(entityNames(entities), ['steering board', 'sb']);
  });

  test('a pipe inside a wikilink does not split the cell, escaped or not', () => {
    const entities = parseEntities(
      [
        '## People',
        '| canonical | wikilink | aliases | active |',
        '| Pat Sample | [[Pat Sample|Pat]] | patty | y |',
        '| Lee Sample | `[[Lee Sample\\|Lee]]` | lee | n |',
      ].join('\n'),
    );
    assert.deepEqual(entities, [
      { name: 'Pat Sample', link: 'Pat Sample', aliases: ['patty'], kind: 'person', active: true },
      { name: 'Lee Sample', link: 'Lee Sample', aliases: ['lee'], kind: 'person', active: false },
    ]);
  });

  test('a name can come from the link, and a link without brackets is read as is', () => {
    const entities = parseEntities(
      ['## Projects', '| wikilink | aliases |', '| [[Work/Atlas]] | atlas project |', '| Plain Name | |'].join('\n'),
    );
    assert.deepEqual(
      entities.map((e) => [e.name, e.link]),
      [
        ['Atlas', 'Work/Atlas'],
        ['Plain Name', 'Plain Name'],
      ],
    );
  });

  test('CRLF, code fences, empty rows and empty input', () => {
    const crlf = REGISTRY.replace(/\n/g, '\r\n');
    assert.deepEqual(parseEntities(crlf), ENTITIES);
    const fenced = ['## People', '```', '| canonical |', '| Ghost |', '```', '| canonical |', '| Real |', '| |', '||'].join('\n');
    assert.deepEqual(
      parseEntities(fenced).map((e) => e.name),
      ['Real'],
    );
    assert.deepEqual(parseEntities(''), []);
    assert.deepEqual(parseEntities('no table here'), []);
  });
});

describe('entityNames', () => {
  const names = entityNames(ENTITIES);

  test('lowercased names, links and aliases', () => {
    for (const expected of [
      'identity & access management',
      'iam',
      'identity & access mgmt',
      'r&d',
      'jane example',
      'jane',
      'the boss',
      'sam',
      'steering board',
      'sb',
      'steering committee',
      'ogov',
      'office of governance',
      'ticket tracker',
      'tt',
      // A link written with a folder is also known by its last segment.
      'concepts/outcome ownership',
      'outcome ownership',
    ]) {
      assert.ok(names.includes(expected), `missing ${expected}`);
    }
    assert.ok(names.every((name) => name === name.toLowerCase()));
  });

  test('deduped, active only, at least two characters', () => {
    assert.equal(new Set(names).size, names.length);
    assert.ok(!names.includes('legacy portal'));
    assert.ok(!names.includes('portal'));
    const short: Entity[] = [{ name: 'Q', link: 'Q', aliases: ['x', 'QQ', ' qq '], kind: 'other', active: true }];
    assert.deepEqual(entityNames(short), ['qq']);
    assert.deepEqual(entityNames([]), []);
  });

  test('feeds the section parser', () => {
    const sections = listSections('### Weekly SB sync\n\nOGOV\n\n- note', { softMarker: /^1:1\b/i, entityNames: names });
    assert.deepEqual(
      sections.map((s) => [s.title, s.meetingLike]),
      [
        ['Weekly SB sync', true],
        // The line under a meeting heading stays a shorthand line.
      ],
    );
    const loose = listSections('### Admin\n\nOGOV\n\n- note', { softMarker: /^1:1\b/i, entityNames: names });
    assert.deepEqual(
      loose.map((s) => [s.title, s.meetingLike]),
      [
        ['Admin', false],
        ['OGOV', true],
      ],
    );
  });
});

describe('findEntity', () => {
  test('by name, link and alias, whatever the case', () => {
    assert.equal(findEntity(ENTITIES, 'jane example')?.name, 'Jane Example');
    assert.equal(findEntity(ENTITIES, 'IAM')?.name, 'Identity & Access Management');
    assert.equal(findEntity(ENTITIES, 'iam')?.name, 'Identity & Access Management');
    assert.equal(findEntity(ENTITIES, 'The Boss')?.name, 'Jane Example');
    assert.equal(findEntity(ENTITIES, 'sb')?.name, 'Steering Board');
    assert.equal(findEntity(ENTITIES, '  Steering   Board ')?.name, 'Steering Board');
  });

  test('accepts a wikilink or a path', () => {
    assert.equal(findEntity(ENTITIES, '[[IAM]]')?.link, 'IAM');
    assert.equal(findEntity(ENTITIES, '[[Jane Example|Jane]]')?.name, 'Jane Example');
    assert.equal(findEntity(ENTITIES, '10 Work/Projects/IAM')?.link, 'IAM');
    assert.equal(findEntity(ENTITIES, 'Outcome Ownership')?.name, 'Outcome ownership');
  });

  test('null for an unknown or empty name', () => {
    assert.equal(findEntity(ENTITIES, 'Maya'), null);
    assert.equal(findEntity(ENTITIES, 'Jan'), null);
    assert.equal(findEntity(ENTITIES, ''), null);
    assert.equal(findEntity([], 'Jane'), null);
  });

  test('inactive entities are still found', () => {
    assert.equal(findEntity(ENTITIES, 'portal')?.name, 'Legacy Portal');
  });

  test('a name beats an alias, and active beats inactive', () => {
    const entities: Entity[] = [
      { name: 'Samuel Sample', link: 'Samuel Sample', aliases: ['Sam'], kind: 'person', active: true },
      { name: 'Sam', link: 'Sam', aliases: [], kind: 'project', active: true },
      { name: 'Atlas', link: 'Atlas (old)', aliases: [], kind: 'project', active: false },
      { name: 'Atlas', link: 'Atlas', aliases: [], kind: 'project', active: true },
    ];
    assert.equal(findEntity(entities, 'sam')?.kind, 'project');
    assert.equal(findEntity(entities, 'atlas')?.link, 'Atlas');
  });
});

describe('classifyHeading', () => {
  const classify = (rawTitle: string, entities: Entity[] = ENTITIES): { attendees: string[]; projects: string[] } =>
    classifyHeading(rawTitle, wikilinks(rawTitle), entities);

  test('a linked project goes to projects', () => {
    assert.deepEqual(classify('Steering comittee [[R&D]]'), { attendees: [], projects: ['R&D'] });
    // The same heading with an empty registry: an unknown name outside a 1:1 is a project.
    assert.deepEqual(classify('Steering comittee [[R&D]]', []), { attendees: [], projects: ['R&D'] });
  });

  test('a linked person goes to attendees', () => {
    assert.deepEqual(classify('1:1 [[Jane Example]]'), { attendees: ['Jane Example'], projects: [] });
    assert.deepEqual(classify('[[Jane Example]] on hiring'), { attendees: ['Jane Example'], projects: [] });
  });

  test('an unknown name after 1:1 is an attendee', () => {
    assert.deepEqual(classify('1:1 Maya'), { attendees: ['Maya'], projects: [] });
    assert.deepEqual(classify('1:1 [[Maya Unknown]]'), { attendees: ['Maya Unknown'], projects: [] });
    assert.deepEqual(classify('Prep 1:1 [[Maya Unknown]]'), { attendees: ['Maya Unknown'], projects: [] });
    assert.deepEqual(classify('Ad Hoc [[Maya Unknown]]'), { attendees: ['Maya Unknown'], projects: [] });
    assert.deepEqual(classify('adhoc Maya'), { attendees: ['Maya'], projects: [] });
  });

  test('an unknown link elsewhere is a project', () => {
    assert.deepEqual(classify('[[Unknown Thing]] - dry run'), { attendees: [], projects: ['Unknown Thing'] });
    assert.deepEqual(classify('[[Work/Unknown Thing|that thing]]'), { attendees: [], projects: ['Unknown Thing'] });
  });

  test('people are listed by canonical name, projects and bodies by link', () => {
    assert.deepEqual(classify('1:1 Jane'), { attendees: ['Jane Example'], projects: [] });
    assert.deepEqual(classify('[[Steering Board]]'), { attendees: [], projects: ['Steering Board'] });
    assert.deepEqual(classify('[[OGOV]] Steering'), { attendees: [], projects: ['OGOV'] });
    assert.deepEqual(classify('[[IAM]] - dry run'), { attendees: [], projects: ['IAM'] });
    assert.deepEqual(classify('[[Jane Example]] and [[IAM]]'), { attendees: ['Jane Example'], projects: ['IAM'] });
  });

  test('several names after the marker: comma, et, and; an ampersand does not split', () => {
    assert.deepEqual(classify('1:1 Maya et Tim'), { attendees: ['Maya', 'Tim'], projects: [] });
    assert.deepEqual(classify('Ad Hoc Jane, Sam and Noé.'), {
      attendees: ['Jane Example', 'Sam Placeholder', 'Noé'],
      projects: [],
    });
    assert.deepEqual(classify('Ad Hoc R&D'), { attendees: [], projects: ['R&D'] });
    assert.deepEqual(classify('1:1 R&D lead'), { attendees: ['R&D lead'], projects: [] });
  });

  test('a slash between typed names is not a folder', () => {
    // Only a link target has folders; reading one here dropped everything before the slash.
    assert.deepEqual(classify('Ad Hoc Maya/Tim'), { attendees: ['Maya/Tim'], projects: [] });
    assert.deepEqual(classify('1:1 Jane/Sam'), { attendees: ['Jane/Sam'], projects: [] });
    assert.deepEqual(classify('1:1 [[People/Jane Example]]'), { attendees: ['Jane Example'], projects: [] });
    assert.deepEqual(classify('1:1 [[People/Zed Unknown]]'), { attendees: ['Zed Unknown'], projects: [] });
  });

  test('a link still being typed leaves no bracket in a name', () => {
    assert.deepEqual(classify('1:1 [[Jane'), { attendees: ['Jane Example'], projects: [] });
    assert.deepEqual(classify('1:1 [[Maya]'), { attendees: ['Maya'], projects: [] });
    assert.deepEqual(classify('Ad Hoc Maya]] et [[Tim'), { attendees: ['Maya', 'Tim'], projects: [] });
    assert.deepEqual(classify('1:1 [['), { attendees: [], projects: [] });
  });

  test('the topic after the names is not a name', () => {
    assert.deepEqual(classify('1:1 Maya - budget review'), { attendees: ['Maya'], projects: [] });
    assert.deepEqual(classify('1:1 avec Maya: suivi'), { attendees: ['Maya'], projects: [] });
    assert.deepEqual(classify('1:1 with Jane (weekly)'), { attendees: ['Jane Example'], projects: [] });
    assert.deepEqual(classify('1:1'), { attendees: [], projects: [] });
  });

  test('without links or a 1:1 marker, only known names count', () => {
    assert.deepEqual(classify('Rencontre avec Léa, Maya et Tom et Noé.'), { attendees: [], projects: [] });
    assert.deepEqual(classify('Rencontre avec Jane et Sam sur IAM'), {
      attendees: ['Jane Example', 'Sam Placeholder'],
      projects: ['IAM'],
    });
    assert.deepEqual(classify('OGOV'), { attendees: [], projects: ['OGOV'] });
    assert.deepEqual(classify('Weekly SB sync'), { attendees: [], projects: ['Steering Board'] });
    assert.deepEqual(classify('Samedi plans'), { attendees: [], projects: [] });
    assert.deepEqual(classify('Priority 1:'), { attendees: [], projects: [] });
  });

  test('the longest name wins where two overlap', () => {
    const entities: Entity[] = [
      { name: 'Steering', link: 'Steering', aliases: [], kind: 'project', active: true },
      { name: 'Steering Board', link: 'Steering Board', aliases: [], kind: 'governance', active: true },
    ];
    assert.deepEqual(classify('Budget for Steering Board', entities), { attendees: [], projects: ['Steering Board'] });
  });

  test('other kinds are ignored, known or mentioned', () => {
    assert.deepEqual(classify('[[Ticket Tracker]] cleanup'), { attendees: [], projects: [] });
    assert.deepEqual(classify('Ticket Tracker cleanup with Jane'), { attendees: ['Jane Example'], projects: [] });
  });

  test('an inactive entity is known when linked, not when merely mentioned', () => {
    assert.deepEqual(classify('[[Legacy Portal]] shutdown'), { attendees: [], projects: ['Legacy Portal'] });
    assert.deepEqual(classify('Portal shutdown'), { attendees: [], projects: [] });
  });

  test('deduped, in order, without brackets', () => {
    const result = classify('1:1 [[Jane Example]] [[Jane Example|Jane]] [[Zed Unknown]] [[IAM]] [[IAM#Scope]]');
    assert.deepEqual(result, { attendees: ['Jane Example', 'Zed Unknown'], projects: ['IAM'] });
    for (const value of [...result.attendees, ...result.projects]) assert.ok(!/[[\]]/.test(value));
  });

  test('uses the links it is given rather than re-reading the title', () => {
    assert.deepEqual(classifyHeading('1:1 Maya', ['Jane Example'], ENTITIES), {
      attendees: ['Jane Example'],
      projects: [],
    });
  });
});
