import { randomUUID } from 'node:crypto'
import { builtinModules } from 'node:module'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/* The Obsidian plugin build: one CommonJS file, one stylesheet.
   Obsidian provides `obsidian`, `electron` and CodeMirror itself; Node built-ins
   are resolved by Electron at run time (the plugin is desktop-only). */
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  /* React picks its build from `process.env.NODE_ENV`, and nothing substitutes
     that in a CommonJS library build. Without this the bundle carries React's
     development copy as well as the production one, and the development copy
     is the one that runs. */
  define: {
    ...(mode === 'production' ? { 'process.env.NODE_ENV': '"production"' } : {}),
    /* A development build, the one `pnpm install:plugin` makes, names itself, differently every
       time, even when only the stylesheet changed: it compares that name with the main.js on disk
       to know that a new one is installed (src/host/selfReload.ts). A release build has none, and
       no self-reload: the same source must give the same main.js, which the community directory
       checks. */
    __HAMSTER_BUILD__:
      process.env.HAMSTER_DEV_BUILD === '1' ? JSON.stringify(`magical-hamster-build:${randomUUID()}`) : 'null',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: at('./src/main.ts'),
      formats: ['cjs'],
      fileName: () => 'main.js',
    },
    cssCodeSplit: false,
    sourcemap: false,
    minify: 'oxc',
    rolldownOptions: {
      external: [
        'obsidian',
        'electron',
        /^@codemirror\//,
        /^@lezer\//,
        /^node:/,
        ...builtinModules,
      ],
      output: { assetFileNames: 'styles.css' },
    },
  },
}))
