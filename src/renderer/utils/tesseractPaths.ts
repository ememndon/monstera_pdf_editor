// Local Tesseract asset paths. Vite (vite-plugin-static-copy) copies the worker,
// core WASM variants, and eng.traineddata into <app>/tesseract/. We hand
// createWorker absolute URLs built from document.baseURI so they resolve in both
// the dev server (http://localhost/tesseract/…) and the packaged app
// (file://…/dist/tesseract/…), and so importScripts/fetch inside the spawned
// worker resolve against the app origin rather than the worker's own blob URL.
//
// - workerBlobURL: false so the worker script loads directly (CSP worker-src
//   'self'), instead of a blob that importScripts the CDN.
// - gzip: false because eng.traineddata is stored uncompressed.
export function tesseractOptions(): {
  workerPath: string
  corePath: string
  langPath: string
  workerBlobURL: boolean
  gzip: boolean
} {
  const dir = new URL('tesseract/', document.baseURI).href
  return {
    workerPath: `${dir}worker.min.js`,
    corePath: dir,
    langPath: dir,
    workerBlobURL: false,
    gzip: false,
  }
}
