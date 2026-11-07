import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bottomInset } from '../src/ui/inset.ts';

const view = { top: 100, bottom: 900, left: 1000, right: 1400 };

test('bottomInset: the part of the view the status bar covers', () => {
  // Obsidian's bar: 24 px high, over the bottom right corner.
  assert.equal(bottomInset(view, { top: 876, bottom: 900, left: 1150, right: 1400 }), 24);
  // A taller bar that starts inside the view and ends below the window.
  assert.equal(bottomInset(view, { top: 880.4, bottom: 920, left: 900, right: 1400 }), 20);
});

test('bottomInset: nothing when the bar is elsewhere, hidden or absent', () => {
  assert.equal(bottomInset(view, null), 0);
  // Under the main editor, left of the sidebar.
  assert.equal(bottomInset(view, { top: 876, bottom: 900, left: 600, right: 1000 }), 0);
  // Below the view.
  assert.equal(bottomInset(view, { top: 900, bottom: 924, left: 1150, right: 1400 }), 0);
  // Collapsed to nothing by a theme.
  assert.equal(bottomInset(view, { top: 900, bottom: 900, left: 1150, right: 1400 }), 0);
});
