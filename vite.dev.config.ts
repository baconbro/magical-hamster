import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tailwindDirectives } from './src/styles/tailwind.ts'

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/* The browser harness: the sidebar UI and the real session, running against
   fake hosts (no Obsidian, no microphone). Development only; not part of the
   plugin bundle. */
export default defineConfig({
  root: at('./dev'),
  // tailwindDirectives first: it adds Tailwind's directives to styles.css before Tailwind reads it.
  plugins: [react(), tailwindDirectives(), tailwindcss()],
  resolve: {
    alias: [{ find: /^obsidian$/, replacement: at('./dev/obsidian-stub.ts') }],
  },
  server: { port: 5181, strictPort: false, fs: { allow: [at('.')] } },
})
