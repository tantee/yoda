import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import vuetify from 'vite-plugin-vuetify'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/**
 * The pages and the service worker. The injected scripts are built separately as self-contained IIFEs
 * (scripts/build.ts): executeScript needs one file each, with no imports.
 */
export default defineConfig(({ mode }) => ({
  plugins: [vue(), vuetify({ autoImport: true })],
  define: { 'import.meta.env.VITE_TARGET': JSON.stringify(mode === 'e2e' ? 'e2e' : 'release') },
  build: {
    outDir: mode === 'e2e' ? 'dist-e2e' : 'dist',
    emptyOutDir: true,
    target: 'chrome116',
    sourcemap: false,
    // No inline data: URLs or remote code: everything is a file in the package.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        popup: r('src/popup/index.html'),
        editor: r('src/editor/index.html'),
        options: r('src/options/index.html'),
        offscreen: r('src/offscreen/index.html'),
        sw: r('src/sw/index.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
}))
