import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import path from 'path'

// Tesseract.js defaults to loading its worker, core WASM, and language data from
// a CDN (jsdelivr / tessdata). The app's CSP (`script-src 'self'`,
// `connect-src 'self'`) blocks that, so OCR failed with a worker importScripts
// NetworkError. Copy those assets into dist/tesseract/ so they load locally and
// offline. src/renderer/utils/tesseractPaths.ts points createWorker at them.
export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        { src: 'node_modules/tesseract.js/dist/worker.min.js', dest: 'tesseract', rename: { stripBase: true } },
        { src: 'node_modules/tesseract.js-core/*.{js,wasm}', dest: 'tesseract', rename: { stripBase: true } },
        { src: 'eng.traineddata', dest: 'tesseract' },
      ],
    }),
  ],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  optimizeDeps: {
    exclude: ['mupdf'],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
