import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/* The browser harness: the sidebar UI and the real session, running against
   fake hosts (no Obsidian, no microphone). Development only; not part of the
   plugin bundle. */
export default defineConfig({
  root: at('./dev'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [{ find: /^obsidian$/, replacement: at('./dev/obsidian-stub.ts') }],
  },
  server: { port: 5181, strictPort: false, fs: { allow: [at('.')] } },
})
