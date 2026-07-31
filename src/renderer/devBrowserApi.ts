/**
 * DEV-ONLY browser shim for `window.electronAPI`.
 *
 * This exists purely so the renderer can be exercised in an ordinary browser
 * tab (`vite` dev server) for click-through verification of the UI and tools.
 * It is installed ONLY when the real Electron preload bridge is absent
 * (`!window.electronAPI`). In the packaged Windows app the native bridge is
 * always present, so NOTHING in this file ever runs in production.
 *
 * What it makes real in the browser:
 *   - File open / save / multi-file via the browser file picker + downloads
 *   - The whole pdf.js / pdf-lib / overlay layer (those run in the renderer
 *     already and need no bridge): viewing, annotations, forms, page ops,
 *     bookmarks, search, the overlay text-edit fallback, etc.
 *
 * What degrades gracefully (native-only, stubbed here):
 *   - Byte-transform engines (MuPDF/Ghostscript/qpdf/mutool/PDFium) pass the
 *     bytes through unchanged so save flows still produce a valid PDF.
 *   - Cryptographic signing, native OCR, Office conversion, etc. return empty.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

type API = Window['electronAPI']

// Pseudo-paths handed back by the file pickers, mapped to the picked File so a
// later readFileBytes(path) can resolve the bytes. Browser-only; never on disk.
const fileStore = new Map<string, File>()

// When set (by the __loadSample dev helper), the next openFileDialog() resolves
// to this file instead of opening the native picker — lets automated testing
// load a document without a real file dialog.
let injectedFile: File | null = null

async function makeSamplePdf(pages = 3): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([612, 792])
    page.drawText('Monstera PDF Editor', { x: 60, y: 720, size: 26, font: bold, color: rgb(0.1, 0.5, 0.25) })
    page.drawText(`Sample document — page ${i} of ${pages}`, { x: 60, y: 690, size: 14, font, color: rgb(0.1, 0.1, 0.1) })
    page.drawText('This is selectable text you can highlight, underline or strike through.',
      { x: 60, y: 650, size: 12, font, color: rgb(0, 0, 0) })
    page.drawText('The quick brown fox jumps over the lazy dog. 0123456789.',
      { x: 60, y: 626, size: 12, font, color: rgb(0, 0, 0) })
    page.drawText('Use the Comment tab tools to mark up this paragraph, then Ctrl+S to save.',
      { x: 60, y: 602, size: 12, font, color: rgb(0, 0, 0) })
  }
  const bytes = await doc.save()
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
let pathSeq = 0
const stash = (f: File): string => {
  const p = `browser://${pathSeq++}/${f.name}`
  fileStore.set(p, f)
  return p
}

function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.style.position = 'fixed'
    input.style.left = '-9999px'
    document.body.appendChild(input)
    let settled = false
    const finish = (files: File[]) => {
      if (settled) return
      settled = true
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => finish(input.files ? Array.from(input.files) : []))
    // Cancel detection: the 'cancel' event in modern browsers, plus a focus
    // fallback for those that don't fire it.
    input.addEventListener('cancel', () => finish([]))
    window.addEventListener('focus', () => setTimeout(() => finish([]), 400), { once: true })
    input.click()
  })
}

function download(name: string, bytes: ArrayBuffer) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name || 'document.pdf'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}

const baseName = (p: string) => p.split(/[\\/]/).pop() || p
const acceptFrom = (filters: Array<{ name: string; extensions: string[] }>) =>
  filters.flatMap(f => f.extensions.map(e => `.${e}`)).join(',')

const EMPTY = new ArrayBuffer(0)
const echo = async (bytes: ArrayBuffer) => bytes               // byte-transform passthrough
const emptyBuf = async () => EMPTY
const emptyArr = async () => [] as never[]

let menuCb: ((a: string) => void) | null = null

export function installBrowserApi() {
  const api = {
    // ── File open ────────────────────────────────────────────────────────────
    openFileDialog: async () => {
      if (injectedFile) { const p = stash(injectedFile); injectedFile = null; return p }
      const [f] = await pickFiles('.pdf,application/pdf', false)
      return f ? stash(f) : null
    },
    openMultipleFiles: async () => {
      if (injectedFile) { const p = stash(injectedFile); injectedFile = null; return [p] }
      return (await pickFiles('.pdf,application/pdf', true)).map(stash)
    },
    openImageFile: async () => {
      const [f] = await pickFiles('image/png,image/jpeg,image/jpg', false)
      return f ? stash(f) : null
    },
    openAnyFile: async (filters: Array<{ name: string; extensions: string[] }>) => {
      const [f] = await pickFiles(acceptFrom(filters), false)
      return f ? stash(f) : null
    },
    openOfficeFileDialog: async () => {
      const [f] = await pickFiles('.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp', false)
      return f ? stash(f) : null
    },
    chooseDirectory: async () => 'browser://downloads',

    clipboardWriteText: async (text: string) => { await navigator.clipboard.writeText(text) },

    readFileBytes: async (filePath: string) => {
      const f = fileStore.get(filePath)
      if (f) return await f.arrayBuffer()
      try { return await (await fetch(filePath)).arrayBuffer() } catch { return EMPTY }
    },
    getMimeType: async (filePath: string) => {
      const ext = filePath.toLowerCase().split('.').pop() || ''
      if (ext === 'png') return 'image/png'
      if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
      if (ext === 'pdf') return 'application/pdf'
      return 'application/octet-stream'
    },

    // ── File save ────────────────────────────────────────────────────────────
    saveFileDialog: async (defaultPath: string) => defaultPath || 'document.pdf',
    writeFile: async (filePath: string, bytes: ArrayBuffer) => { download(baseName(filePath), bytes) },
    writeBytesToDir: async (_dir: string, files: Array<{ name: string; bytes: ArrayBuffer }>) => {
      for (const f of files) { download(f.name, f.bytes); await new Promise(r => setTimeout(r, 150)) }
    },

    // ── Window / misc ──────────────────────────────────────────────────────────
    setWindowTitle: async (title: string) => { document.title = title },
    setDirty: async (_dirty: boolean) => {},
    confirmAppClose: async () => {},
    printWindow: async () => { window.print() },
    printPdf: async () => { window.print(); return true },
    confirmSignatureInvalidation: async () =>
      window.confirm('This document contains digital signature(s). Saving will invalidate them. Save anyway?'),
    confirmUnsaved: async (fileName: string) => {
      // Browser only has a 2-button confirm; the packaged app shows a native
      // 3-button Save / Don't Save / Cancel dialog. Map OK→save, Cancel→cancel
      // (keep the document open) so no work is lost on an ambiguous dismissal.
      const ok = window.confirm(`Save changes to ${fileName || 'this document'} before closing?\n\nOK = Save, Cancel = keep open.`)
      return ok ? 'save' as const : 'cancel' as const
    },
    onMenuAction: (cb: (a: string) => void) => {
      menuCb = cb
      // Lets you fire menu-only tools from the devtools console in browser mode,
      // e.g. __menu('taggedPdf'). No-op in the packaged app (this never runs).
      ;(window as unknown as Record<string, unknown>).__menu = (a: string) => menuCb?.(a)
    },
    removeMenuActionListener: () => { menuCb = null },
    onOpenFile: () => {},
    removeOpenFileListener: () => {},
    getPendingOpenPath: async () => null,
    getAppVersion: async () => 'dev',
    openFromUrl: async (url: string) => {
      try { return await (await fetch(url)).arrayBuffer() } catch { return EMPTY }
    },

    // ── PDFium (native FFI) — unavailable in browser; overlays/fallbacks kick in ─
    pdfiumStatus: async () => ({ available: false }),
    pdfiumRenderPage: async () => ({ data: EMPTY, width: 0, height: 0 }),
    pdfiumEnsureSession: async () => false,
    pdfiumCloseSession: async () => {},
    pdfiumRenderSession: async () => ({ stale: true }),
    pdfiumTextInRegion: async () => ({ text: '', fontSize: 0, found: false, color: '#000000', matrix: [1, 0, 0, 1, 0, 0], fontData: EMPTY, fontLoadable: false, nested: false, fontName: '' }),
    pdfiumTextObjectAt: async () => ({ found: false, text: '', fontSize: 0, color: '#000000', x1: 0, y1: 0, x2: 0, y2: 0, matrix: [1, 0, 0, 1, 0, 0], fontData: EMPTY, fontLoadable: false, nested: false, fontName: '' }),
    pdfiumTextBoxes: async () => [],
    resolveSystemFont: async () => null,
    pdfiumObjectAt: async () => ({ found: false, index: -1, type: 0, color: '', x1: 0, y1: 0, x2: 0, y2: 0 }),
    pdfiumTransformObject: echo,
    pdfiumSetObjectFill: echo,
    pdfiumDeleteObject: echo,
    pdfiumReplaceText: async () => ({ bytes: EMPTY, count: 0 }),
    pdfiumEditText: emptyBuf,
    pdfiumEditTextAt: emptyBuf,
    pdfiumLineAt: async () => ({ found: false, editable: false, text: '', x1: 0, y1: 0, x2: 0, y2: 0, baseY: 0, fontSize: 0, color: '#000000', fontName: '', fontData: EMPTY, fontLoadable: false }),
    pdfiumReplaceLine: async () => { throw new Error('PDFium runs in the desktop app, not the browser preview') },
    pdfaConvert: async (bytes: ArrayBuffer) => ({ bytes, report: [{ level: 'warning', message: 'PDF/A conversion runs in the desktop app, not the browser preview.' }], ok: false }),

    // ── MuPDF (native WASM in main) — passthrough so save stays valid ──────────
    mupdfGetMetadata: async () => ({ title: '', author: '', subject: '', keywords: '', creator: '', producer: '', needsPassword: false, encryption: '' }),
    mupdfSetMetadata: echo,
    mupdfEncrypt: echo,
    mupdfRemovePassword: echo,
    mupdfApplyRedactions: echo,
    mupdfSynthesizeAppearances: echo,
    mupdfGetOutline: emptyArr,
    mupdfWriteOutline: echo,
    mupdfExtractAllText: emptyArr,
    mupdfCheckAccessibility: emptyArr,
    mupdfGenerateBookmarks: emptyArr,
    mupdfOptimize: async (bytes: ArrayBuffer) => ({ bytes, origSize: bytes.byteLength, newSize: bytes.byteLength }),
    mupdfFindTextRects: emptyArr,

    // ── Signing / verify ───────────────────────────────────────────────────────
    pdfSign: emptyBuf,
    pdfVerifySignatures: emptyArr,
    pdfSignWithTsa: emptyBuf,
    pdfCertify: emptyBuf,

    // ── Office / conversion ────────────────────────────────────────────────────
    exportToDocx: emptyBuf,
    paragraphsToDocx: emptyBuf,
    exportToPptx: emptyBuf,
    importDocx: emptyBuf,
    importXlsx: emptyBuf,
    exportToXlsx: emptyBuf,
    importDocxSmart: emptyBuf,
    libreofficeIsAvailable: async () => false,
    libreofficeImportFile: emptyBuf,
    libreofficeImportBytes: emptyBuf,
    libreofficeExportDocx: emptyBuf,
    libreofficeExportPptx: emptyBuf,
    libreofficeExportXlsx: emptyBuf,
    pdf2docxStatus: async () => ({ python: '', version: '', installed: false }),
    pdf2docxConvert: emptyBuf,
    pdf2docxInstall: async () => ({ ok: false, version: '', log: 'Not available in browser preview.' }),
    convertMarkdownToPdf: emptyBuf,
    convertCsvToPdf: emptyBuf,
    emailToPdf: emptyBuf,
    openEmail: async () => {},
    exportPageForEdit: async () => ({ pngPath: '', width: 0, height: 0 }),
    reimportEditedPage: emptyBuf,

    // ── Forms / misc analysis ──────────────────────────────────────────────────
    formsIdentify: emptyArr,
    spellCheck: emptyArr,
    aiQuery: async () => '',
    aiVisionAnalyze: async () => { throw new Error('Claude vision analysis runs in the desktop app, not the browser preview') },
    azureLayoutAnalyze: async () => { throw new Error('Azure analysis runs in the desktop app, not the browser preview') },
    azureReadAnalyze: async () => { throw new Error('Azure analysis runs in the desktop app, not the browser preview') },
    pdfiumStyledRuns: async () => [],
    trocrStatus: async () => ({ ready: false, cached: false }),
    trocrSetup: async () => { throw new Error('The local handwriting model runs in the desktop app, not the browser preview') },
    trocrRecognize: async () => { throw new Error('The local handwriting model runs in the desktop app, not the browser preview') },

    // ── Native binaries (unavailable in browser) ───────────────────────────────
    binsGetStatus: async () => ({
      mutool: { path: '', available: false },
      ghostscript: { path: '', available: false },
      libreoffice: { path: '', available: false },
      qpdf: { path: '', available: false },
      poppler: { path: '', available: false },
      tesseract: { path: '', available: false },
    }),
    binsOpenUrl: async () => {},
    binsDownloadMutool: async () => '',
    onBinsDownloadProgress: () => {},
    removeBinsDownloadListener: () => {},

    gsToPdfa: echo, gsToPdfx: echo, gsToGrayscale: echo, gsToCmyk: echo,
    gsOptimize: echo, gsLinearize: echo, gsSanitize: echo, gsRasterize: echo,

    mutoolClean: echo,
    mutoolInfo: async () => '',
    mutoolExtractFiles: emptyArr,
    mutoolConvert: echo,

    qpdfLinearize: echo, qpdfRepair: echo, qpdfDecrypt: echo,
    popplerTextLayout: async () => '',
    popplerExtractImages: emptyArr,
    tesseractOcrImage: async () => '',
  }

  ;(window as unknown as { electronAPI: API }).electronAPI = api as unknown as API

  // Dev test helper: generate an in-memory sample PDF and open it through the
  // real open flow (no native picker). Call __loadSample() from the console or
  // automation. Browser-mode only.
  ;(window as unknown as Record<string, unknown>).__loadSample = async (pages = 3) => {
    injectedFile = new File([await makeSamplePdf(pages)], 'sample.pdf', { type: 'application/pdf' })
    menuCb?.('open')
  }

  // Visible breadcrumb so it's obvious you're in the dev browser harness.
  // eslint-disable-next-line no-console
  console.info('%c[Monstera] running in DEV BROWSER mode — native features stubbed. Packaged app uses the real bridge.', 'color:#4ade80;font-weight:bold')
}
