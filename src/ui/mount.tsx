import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { HamsterProvider, type AppProps } from './context.tsx';
import { syncTheme } from './theme.ts';
import '../styles/styles.css';

const mounted = new Set<HTMLElement>();

/** Re-reads the host theme for every mounted root. Call on Obsidian's `css-change`. */
export function syncAllThemes(): void {
  for (const el of mounted) syncTheme(el);
}

/** Renders the sidebar into `container`. The returned function takes it back down. */
export function mountHamster(container: HTMLElement, props: AppProps): () => void {
  container.classList.add('mh-root');
  mounted.add(container);
  syncTheme(container);

  const root = createRoot(container);
  root.render(
    <StrictMode>
      <HamsterProvider value={props}>
        <App />
      </HamsterProvider>
    </StrictMode>,
  );

  return () => {
    root.unmount();
    mounted.delete(container);
    container.classList.remove('mh-root', 'dark');
    container.style.removeProperty('--mh-on-accent');
  };
}
