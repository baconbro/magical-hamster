import assert from 'node:assert/strict';
import { test } from 'node:test';
import { leadingTaskMark, taskMark, taskStatus, withoutTaskMark } from '../src/util/tasks.ts';

/* A task typed in the notes stays a task in the enhanced notes: its status, read from the line,
   and the mark put back on its bullet. */

test('taskStatus reads the checkbox of a list line, whatever its status character', () => {
  assert.equal(taskStatus('- [ ] send the budget'), ' ');
  assert.equal(taskStatus('- [x] send the budget'), 'x');
  assert.equal(taskStatus('  * [X] indented'), 'X');
  assert.equal(taskStatus('1. [/] in progress'), '/');
  assert.equal(taskStatus('- [-] cancelled'), '-');
  assert.equal(taskStatus('- [ ]'), ' ', 'an empty task is still a task');
  assert.equal(taskStatus('- send the budget'), null);
  assert.equal(taskStatus('[ ] no list marker: not a task in Obsidian'), null);
  assert.equal(taskStatus('- [link](x) is no checkbox'), null);
  assert.equal(taskStatus('- [[Wiki]] neither'), null);
});

test('taskMark: a checkbox when asked for, a sign task tools ignore otherwise', () => {
  assert.equal(taskMark(' ', true), '[ ] ');
  assert.equal(taskMark('x', true), '[x] ');
  assert.equal(taskMark('/', true), '[/] ', 'the status is kept as typed');
  assert.equal(taskMark(' ', false), '☐ ');
  assert.equal(taskMark('x', false), '☑ ');
  assert.equal(taskMark('X', false), '☑ ');
  assert.equal(taskMark('-', false), '☐ ');
  assert.equal(taskMark(undefined, true), '');
  assert.equal(taskMark(null, false), '');
});

test('a written mark is found and removed, and nothing else is', () => {
  for (const mark of ['[ ] ', '[x] ', '☐ ', '☑ ']) {
    assert.equal(leadingTaskMark(`${mark}**Note:** send it`), mark);
    assert.equal(withoutTaskMark(`${mark}**Note:** send it`), '**Note:** send it');
  }
  assert.equal(leadingTaskMark('**Note:** send it'), '');
  assert.equal(withoutTaskMark('**Note:** a ☐ inside stays'), '**Note:** a ☐ inside stays');
  assert.equal(withoutTaskMark('[link](x) stays'), '[link](x) stays');
});
