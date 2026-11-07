import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
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

  /* An error no boundary catches makes React unmount the root, and the leaf stays blank until
     it is closed and opened again. The boundary around the app shows the error and offers to
     draw it again instead; what still gets past it (the provider, the fallback itself) is at
     least logged under the plugin's tag, where React would log it bare. */
  const root = createRoot(container, {
    onUncaughtError: (error, info) => console.error('[magical-hamster]', error, info.componentStack),
  });
  root.render(
    <StrictMode>
      <HamsterProvider value={props}>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
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
