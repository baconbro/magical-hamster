/* Obsidian owns the light/dark question, and announces a change as a stylesheet
   change. These helpers copy its answer onto the plugin's own root element and
   never touch <html> or <body>. */

function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Reads a CSS colour through a real element inside <body>, where Obsidian defines its variables. */
function readColor(value: string): [number, number, number] | null {
  // In the page for one synchronous read and out again: it is never drawn.
  const probe = document.createElement('span');
  probe.style.color = value;
  document.body.appendChild(probe);
  const parts = getComputedStyle(probe).color.match(/[\d.]+/g);
  probe.remove();
  if (!parts || parts.length < 3) return null;
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

/** Applies the host theme to one plugin root: the `.dark` class and the text-on-accent colour. */
export function syncTheme(root: HTMLElement): void {
  root.classList.toggle('dark', document.body.classList.contains('theme-dark'));

  /* Text on an accent fill. Obsidian ships both answers and leaves the choice to
     whoever is drawing; white is right for its default purple and unreadable on
     a pale yellow accent. 0.4 flips gold and lighter, keeps purple/red/blue on white. */
  const accent = readColor('var(--interactive-accent)');
  if (accent) {
    root.style.setProperty(
      '--mh-on-accent',
      luminance(accent) > 0.4
        ? 'var(--text-on-accent-inverted, #111111)'
        : 'var(--text-on-accent, #ffffff)',
    );
  }
}
