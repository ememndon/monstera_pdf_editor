import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // Open dialogs
  openFileDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:openFile'),
  openMultipleFiles: (): Promise<string[]> =>
    ipcRenderer.invoke('dialog:openMultipleFiles'),
  openImageFile: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:openImageFile'),
  saveFileDialog: (defaultPath: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveFile', defaultPath),
  chooseDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:chooseDirectory'),

  // Clipboard (native; the web Clipboard API is blocked by our permission handler)
  clipboardWriteText: (text: string): Promise<void> =>
    ipcRenderer.invoke('clipboard:writeText', text),

  // Read
  readFileBytes: (filePath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('file:readBytes', filePath),
  getMimeType: (filePath: string): Promise<string> =>
    ipcRenderer.invoke('file:getMimeType', filePath),

  // PDFium engine — true in-place text editing
  pdfiumStatus: (): Promise<{ available: boolean }> =>
    ipcRenderer.invoke('pdfium:status'),
  pdfiumRenderPage: (
    bytes: ArrayBuffer,
    pageIndex: number,
    scale: number,
  ): Promise<{ data: ArrayBuffer; width: number; height: number }> =>
    ipcRenderer.invoke('pdfium:renderPage', bytes, pageIndex, scale),
  pdfiumEnsureSession: (token: string, bytes: ArrayBuffer): Promise<boolean> =>
    ipcRenderer.invoke('pdfium:ensureSession', token, bytes),
  pdfiumCloseSession: (): Promise<void> =>
    ipcRenderer.invoke('pdfium:closeSession'),
  pdfiumRenderSession: (
    token: string,
    pageIndex: number,
    scale: number,
  ): Promise<{ stale: boolean; data?: ArrayBuffer; width?: number; height?: number }> =>
    ipcRenderer.invoke('pdfium:renderSession', token, pageIndex, scale),
  pdfiumTextInRegion: (
    bytes: ArrayBuffer,
    pageIndex: number,
    rect: { x1: number; y1: number; x2: number; y2: number },
  ): Promise<{ text: string; fontSize: number; found: boolean; color: string; matrix: number[]; fontData: ArrayBuffer; fontLoadable: boolean; nested: boolean; fontName: string }> =>
    ipcRenderer.invoke('pdfium:textInRegion', bytes, pageIndex, rect),
  pdfiumTextObjectAt: (
    bytes: ArrayBuffer,
    pageIndex: number,
    x: number,
    y: number,
  ): Promise<{ found: boolean; text: string; fontSize: number; color: string; x1: number; y1: number; x2: number; y2: number; matrix: number[]; fontData: ArrayBuffer; fontLoadable: boolean; nested: boolean; fontName: string }> =>
    ipcRenderer.invoke('pdfium:textObjectAt', bytes, pageIndex, x, y),
  pdfiumTextBoxes: (
    bytes: ArrayBuffer, pageIndex: number,
  ): Promise<Array<{ x1: number; y1: number; x2: number; y2: number; nested: boolean }>> =>
    ipcRenderer.invoke('pdfium:textBoxes', bytes, pageIndex),
  resolveSystemFont: (
    name: string, bold: boolean, italic: boolean,
  ): Promise<{ family: string; data: ArrayBuffer } | null> =>
    ipcRenderer.invoke('fonts:resolve', name, bold, italic),
  pdfiumObjectAt: (
    bytes: ArrayBuffer, pageIndex: number, x: number, y: number,
  ): Promise<{ found: boolean; index: number; type: number; color: string; x1: number; y1: number; x2: number; y2: number }> =>
    ipcRenderer.invoke('pdfium:objectAt', bytes, pageIndex, x, y),
  pdfiumTransformObject: (
    bytes: ArrayBuffer, pageIndex: number, index: number,
    m: { a: number; b: number; c: number; d: number; e: number; f: number },
  ): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('pdfium:transformObject', bytes, pageIndex, index, m),
  pdfiumSetObjectFill: (
    bytes: ArrayBuffer, pageIndex: number, index: number,
    c: { r: number; g: number; b: number; a: number },
  ): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('pdfium:setObjectFill', bytes, pageIndex, index, c),
  pdfiumDeleteObject: (
    bytes: ArrayBuffer, pageIndex: number, index: number,
  ): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('pdfium:deleteObject', bytes, pageIndex, index),
  pdfiumReplaceText: (
    bytes: ArrayBuffer, term: string, replacement: string, matchCase: boolean,
  ): Promise<{ bytes: ArrayBuffer; count: number }> =>
    ipcRenderer.invoke('pdfium:replaceText', bytes, term, replacement, matchCase),
  pdfiumEditText: (
    bytes: ArrayBuffer,
    pageIndex: number,
    rect: { x1: number; y1: number; x2: number; y2: number },
    newText: string,
  ): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('pdfium:editText', bytes, pageIndex, rect, newText),
  pdfiumEditTextAt: (
    bytes: ArrayBuffer,
    pageIndex: number,
    x: number,
    y: number,
    newText: string,
  ): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('pdfium:editTextAt', bytes, pageIndex, x, y, newText),
  pdfiumLineAt: (
    bytes: ArrayBuffer,
    pageIndex: number,
    x: number,
    y: number,
  ): Promise<{ found: boolean; editable: boolean; text: string; x1: number; y1: number; x2: number; y2: number; baseY: number; fontSize: number; color: string; fontName: string; fontData: ArrayBuffer; fontLoadable: boolean }> =>
    ipcRenderer.invoke('pdfium:lineAt', bytes, pageIndex, x, y),
  pdfiumReplaceLine: (
    bytes: ArrayBuffer,
    pageIndex: number,
    x: number,
    y: number,
    newText: string,
    bbox?: { x1: number; y1: number; x2: number; y2: number },
  ): Promise<{ bytes: ArrayBuffer; outcome: 'in-place' | 'in-place-form' | 'in-place-extended' | 'in-place-substituted' | 'substituted' | 'cleared' | 'unchanged'; substituteFamily: string }> =>
    ipcRenderer.invoke('pdfium:replaceLine', bytes, pageIndex, x, y, newText, bbox),
  pdfaConvert: (
    bytes: ArrayBuffer,
  ): Promise<{ bytes: ArrayBuffer; report: Array<{ level: string; message: string }>; ok: boolean }> =>
    ipcRenderer.invoke('pdfa:convert', bytes),

  // Write
  writeFile: (filePath: string, bytes: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke('file:writeBytes', filePath, bytes),
  writeBytesToDir: (
    dirPath: string,
    files: Array<{ name: string; bytes: ArrayBuffer }>
  ): Promise<void> =>
    ipcRenderer.invoke('file:writeBytesToDir', dirPath, files),

  // MuPDF operations
  mupdfGetMetadata: (bytes: ArrayBuffer): Promise<{
    title: string; author: string; subject: string; keywords: string;
    creator: string; producer: string; needsPassword: boolean; encryption: string;
  }> => ipcRenderer.invoke('mupdf:getMetadata', bytes),

  mupdfSetMetadata: (bytes: ArrayBuffer, meta: Record<string, string>): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('mupdf:setMetadata', bytes, meta),

  mupdfEncrypt: (bytes: ArrayBuffer, opts: {
    userPassword: string; ownerPassword: string; permissions: number;
  }): Promise<ArrayBuffer> => ipcRenderer.invoke('mupdf:encrypt', bytes, opts),

  mupdfRemovePassword: (bytes: ArrayBuffer, password: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('mupdf:removePassword', bytes, password),

  mupdfApplyRedactions: (bytes: ArrayBuffer, areas: Array<{
    pageNum: number; x1: number; y1: number; x2: number; y2: number; blurred?: boolean;
  }>): Promise<ArrayBuffer> => ipcRenderer.invoke('mupdf:applyRedactions', bytes, areas),

  mupdfSynthesizeAppearances: (bytes: ArrayBuffer): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('mupdf:synthesizeAppearances', bytes),

  mupdfGetOutline: (bytes: ArrayBuffer): Promise<Array<{ id: string; title: string; pageNum: number }>> =>
    ipcRenderer.invoke('mupdf:getOutline', bytes),

  mupdfWriteOutline: (bytes: ArrayBuffer, bookmarks: Array<{ id: string; title: string; pageNum: number }>): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('mupdf:writeOutline', bytes, bookmarks),

  pdfSign: (bytes: ArrayBuffer, pfxPath: string, pfxPassword: string, info: {
    name: string; reason: string; location: string; contactInfo: string;
  }): Promise<ArrayBuffer> => ipcRenderer.invoke('pdf:sign', bytes, pfxPath, pfxPassword, info),

  pdfSignWithTsa: (bytes: ArrayBuffer, pfxPath: string, pfxPassword: string, info: {
    name: string; reason: string; location: string; contactInfo: string;
  }, tsaUrl: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('pdf:signWithTsa', bytes, pfxPath, pfxPassword, info, tsaUrl),

  pdfCertify: (bytes: ArrayBuffer, pfxPath: string, pfxPassword: string, info: {
    reason: string; permission: 1 | 2 | 3;
  }): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('pdf:certify', bytes, pfxPath, pfxPassword, info),

  pdfVerifySignatures: (bytes: ArrayBuffer): Promise<Array<{
    signerName: string; signerOrg: string; reason: string; location: string;
    contactInfo: string; certValidFrom: string; certValidTo: string; certCurrentlyValid: boolean;
    hashMatches: boolean; signatureValid: boolean;
    integrity: 'valid' | 'modified' | 'unknown'; coversWholeDocument: boolean;
  }>> => ipcRenderer.invoke('pdf:verifySignatures', bytes),

  exportToDocx: (bytes: ArrayBuffer, fileName: string, mode?: 'text' | 'layout'): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('export:toDocx', bytes, fileName, mode),

  paragraphsToDocx: (pages: Array<{ page: number; paragraphs?: string[]; markdown?: string }>): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('export:paragraphsToDocx', pages),

  exportToPptx: (bytes: ArrayBuffer, dpi?: number): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('export:toPptx', bytes, dpi),

  formsIdentify: (bytes: ArrayBuffer): Promise<Array<{
    pageNum: number; label: string; rect: [number, number, number, number]; fieldType: 'text' | 'checkbox' | 'date';
  }>> => ipcRenderer.invoke('forms:identify', bytes),

  mupdfExtractAllText: (bytes: ArrayBuffer): Promise<Array<{ pageNum: number; text: string }>> =>
    ipcRenderer.invoke('mupdf:extractAllText', bytes),

  mupdfCheckAccessibility: (bytes: ArrayBuffer): Promise<Array<{
    issue: string; severity: 'error' | 'warning' | 'info'; page?: number;
  }>> => ipcRenderer.invoke('mupdf:checkAccessibility', bytes),

  mupdfGenerateBookmarks: (bytes: ArrayBuffer): Promise<Array<{
    title: string; pageNum: number; level: number;
  }>> => ipcRenderer.invoke('mupdf:generateBookmarks', bytes),

  mupdfOptimize: (bytes: ArrayBuffer): Promise<{ bytes: ArrayBuffer; origSize: number; newSize: number }> =>
    ipcRenderer.invoke('mupdf:optimize', bytes),

  openFromUrl: (url: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('file:openFromUrl', url),

  mupdfFindTextRects: (bytes: ArrayBuffer, term: string): Promise<Array<{ pageNum: number; x1: number; y1: number; x2: number; y2: number }>> =>
    ipcRenderer.invoke('mupdf:findTextRects', bytes, term),

  // AI Assistant
  aiQuery: (
    apiKey: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    systemPrompt: string,
    model?: string
  ): Promise<string> => ipcRenderer.invoke('ai:query', apiKey, messages, systemPrompt, model),

  aiVisionAnalyze: (
    apiKey: string,
    pngBytes: ArrayBuffer,
    mode: 'text' | 'tables',
    model?: string,
  ): Promise<string | Array<{ rows: string[][] }>> =>
    ipcRenderer.invoke('ai:visionAnalyze', apiKey, pngBytes, mode, model),

  // Office import
  importDocx: (bytes: ArrayBuffer): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('file:importDocx', bytes),

  importXlsx: (bytes: ArrayBuffer): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('file:importXlsx', bytes),

  // PDF → XLSX export
  exportToXlsx: (bytes: ArrayBuffer): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('export:toXlsx', bytes),

  // Multi-type file dialog
  openAnyFile: (filters: Array<{ name: string; extensions: string[] }>): Promise<string | null> =>
    ipcRenderer.invoke('dialog:openAnyFile', filters),

  setWindowTitle: (title: string): Promise<void> =>
    ipcRenderer.invoke('window:setTitle', title),

  setDirty: (dirty: boolean): Promise<void> =>
    ipcRenderer.invoke('window:setDirty', dirty),
  confirmAppClose: (): Promise<void> =>
    ipcRenderer.invoke('window:confirmClose'),

  printWindow: (): Promise<void> =>
    ipcRenderer.invoke('window:print'),

  printPdf: (bytes: ArrayBuffer, opts: { pages?: number[]; dpi?: number }): Promise<boolean> =>
    ipcRenderer.invoke('print:pdf', bytes, opts),

  confirmUnsaved: (fileName: string): Promise<'save' | 'discard' | 'cancel'> =>
    ipcRenderer.invoke('dialog:confirmUnsaved', fileName),

  confirmSignatureInvalidation: (): Promise<boolean> =>
    ipcRenderer.invoke('dialog:confirmSignatureInvalidation'),

  // Synchronous OS-keychain encryption for secrets at rest.
  secureEncryptSync: (plain: string): string =>
    ipcRenderer.sendSync('secure:encryptSync', plain),
  secureDecryptSync: (stored: string): string =>
    ipcRenderer.sendSync('secure:decryptSync', stored),

  onMenuAction: (callback: (action: string) => void): void => {
    ipcRenderer.on('menu:action', (_event, action: string) => callback(action))
  },

  removeMenuActionListener: (): void => {
    ipcRenderer.removeAllListeners('menu:action')
  },

  // A PDF path handed over by the OS (double-click / "Open with"), forwarded by main.
  onOpenFile: (callback: (filePath: string) => void): void => {
    ipcRenderer.on('file:open-path', (_event, filePath: string) => callback(filePath))
  },
  removeOpenFileListener: (): void => {
    ipcRenderer.removeAllListeners('file:open-path')
  },
  // The .pdf path this app was launched with, if any (folder double-click).
  getPendingOpenPath: (): Promise<string | null> =>
    ipcRenderer.invoke('app:getPendingOpenPath'),
  // The app's build version (e.g. "0.1.3"), so the UI can show which build is running.
  getAppVersion: (): Promise<string> =>
    ipcRenderer.invoke('app:getVersion'),

  // Real on-disk path for a dropped/File-picked File (Electron removed File.path
  // in v32+; this is the supported replacement, used by drag-and-drop-to-open).
  getPathForFile: (file: File): string => {
    try { return webUtils.getPathForFile(file) } catch { return '' }
  },

  // ── Crash-recovery sidecars ──────────────────────────────────────────────────
  recoverySave: (id: string, fileName: string, filePath: string, bytes: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke('recovery:save', id, fileName, filePath, bytes),
  recoveryList: (): Promise<Array<{ id: string; fileName: string; filePath: string; savedAt: number }>> =>
    ipcRenderer.invoke('recovery:list'),
  recoveryRead: (id: string): Promise<ArrayBuffer | null> =>
    ipcRenderer.invoke('recovery:read', id),
  recoveryDiscard: (id: string): Promise<void> =>
    ipcRenderer.invoke('recovery:discard', id),

  // ── Native binary management ─────────────────────────────────────────────────

  binsGetStatus: (): Promise<{
    mutool:      { path: string; available: boolean }
    ghostscript: { path: string; available: boolean }
    libreoffice: { path: string; available: boolean }
  }> => ipcRenderer.invoke('bins:getStatus'),

  binsOpenUrl: (url: string): Promise<void> =>
    ipcRenderer.invoke('bins:openUrl', url),

  binsDownloadMutool: (): Promise<string> =>
    ipcRenderer.invoke('bins:downloadMutool'),

  onBinsDownloadProgress: (cb: (data: { pct: number; mb?: string; status?: string }) => void): void => {
    ipcRenderer.on('bins:downloadProgress', (_e, data) => cb(data))
  },

  removeBinsDownloadListener: (): void => {
    ipcRenderer.removeAllListeners('bins:downloadProgress')
  },

  // ── Ghostscript operations ───────────────────────────────────────────────────

  gsToPdfa:      (bytes: ArrayBuffer, level: 1 | 2 | 3): Promise<ArrayBuffer> => ipcRenderer.invoke('gs:toPdfa', bytes, level),
  gsToPdfx:      (bytes: ArrayBuffer): Promise<ArrayBuffer>                    => ipcRenderer.invoke('gs:toPdfx', bytes),
  gsToGrayscale: (bytes: ArrayBuffer): Promise<ArrayBuffer>                    => ipcRenderer.invoke('gs:toGrayscale', bytes),
  gsToCmyk:      (bytes: ArrayBuffer): Promise<ArrayBuffer>                    => ipcRenderer.invoke('gs:toCmyk', bytes),
  gsOptimize:    (bytes: ArrayBuffer, preset: string): Promise<ArrayBuffer>    => ipcRenderer.invoke('gs:optimize', bytes, preset),
  gsLinearize:   (bytes: ArrayBuffer): Promise<ArrayBuffer>                    => ipcRenderer.invoke('gs:linearize', bytes),
  gsSanitize:    (bytes: ArrayBuffer): Promise<ArrayBuffer>                    => ipcRenderer.invoke('gs:sanitize', bytes),
  gsRasterize:   (bytes: ArrayBuffer, dpi: number): Promise<ArrayBuffer>       => ipcRenderer.invoke('gs:rasterize', bytes, dpi),

  // ── MuPDF mutool operations ──────────────────────────────────────────────────

  mutoolClean: (bytes: ArrayBuffer, opts: {
    repair?: boolean; garbage?: 0|1|2|3|4; compress?: boolean; linearize?: boolean; sanitize?: boolean
  }): Promise<ArrayBuffer> => ipcRenderer.invoke('mutool:clean', bytes, opts),

  mutoolInfo: (bytes: ArrayBuffer): Promise<string> =>
    ipcRenderer.invoke('mutool:info', bytes),

  mutoolExtractFiles: (bytes: ArrayBuffer): Promise<Array<{ name: string; size: number; dataBase64: string }>> =>
    ipcRenderer.invoke('mutool:extractFiles', bytes),
  mutoolConvert: (bytes: ArrayBuffer, ext: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('mutool:convert', bytes, ext),

  // ── qpdf / Poppler / Tesseract ───────────────────────────────────────────────
  qpdfLinearize: (bytes: ArrayBuffer): Promise<ArrayBuffer> => ipcRenderer.invoke('qpdf:linearize', bytes),
  qpdfRepair:    (bytes: ArrayBuffer): Promise<ArrayBuffer> => ipcRenderer.invoke('qpdf:repair', bytes),
  qpdfDecrypt:   (bytes: ArrayBuffer, pw: string): Promise<ArrayBuffer> => ipcRenderer.invoke('qpdf:decrypt', bytes, pw),
  popplerTextLayout:   (bytes: ArrayBuffer): Promise<string> => ipcRenderer.invoke('poppler:textLayout', bytes),
  popplerExtractImages: (bytes: ArrayBuffer): Promise<Array<{ name: string; dataBase64: string }>> =>
    ipcRenderer.invoke('poppler:extractImages', bytes),
  tesseractOcrImage: (png: ArrayBuffer, lang: string): Promise<string> =>
    ipcRenderer.invoke('tesseract:ocrImage', png, lang),

  // ── LibreOffice operations ───────────────────────────────────────────────────

  libreofficeIsAvailable: (): Promise<boolean> =>
    ipcRenderer.invoke('libreoffice:isAvailable'),

  libreofficeImportFile:  (filePath: string): Promise<ArrayBuffer>  => ipcRenderer.invoke('libreoffice:importFile', filePath),
  libreofficeImportBytes: (bytes: ArrayBuffer, ext: string): Promise<ArrayBuffer> => ipcRenderer.invoke('libreoffice:importBytes', bytes, ext),
  libreofficeExportDocx:  (bytes: ArrayBuffer): Promise<ArrayBuffer> => ipcRenderer.invoke('libreoffice:exportDocx', bytes),
  libreofficeExportPptx:  (bytes: ArrayBuffer): Promise<ArrayBuffer> => ipcRenderer.invoke('libreoffice:exportPptx', bytes),
  libreofficeExportXlsx:  (bytes: ArrayBuffer): Promise<ArrayBuffer> => ipcRenderer.invoke('libreoffice:exportXlsx', bytes),

  // pdf2docx engine (best editable+layout Word conversion via system Python)
  pdf2docxStatus:  (): Promise<{ python: string; version: string; installed: boolean }> =>
    ipcRenderer.invoke('pdf2docx:status'),
  pdf2docxConvert: (bytes: ArrayBuffer): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('pdf2docx:convert', bytes),
  pdf2docxInstall: (): Promise<{ ok: boolean; version: string; log: string }> =>
    ipcRenderer.invoke('pdf2docx:install'),

  azureLayoutAnalyze: (bytes: ArrayBuffer, endpoint: string, key: string, pages: string): Promise<unknown> =>
    ipcRenderer.invoke('azure:layoutAnalyze', bytes, endpoint, key, pages),

  azureReadAnalyze: (bytes: ArrayBuffer, endpoint: string, key: string, pages: string): Promise<unknown> =>
    ipcRenderer.invoke('azure:readAnalyze', bytes, endpoint, key, pages),

  pdfiumStyledRuns: (bytes: ArrayBuffer, pageIndex: number): Promise<Array<{
    text: string; x1: number; y1: number; x2: number; y2: number
    fontName: string; family: string; bold: boolean; italic: boolean
    fontSize: number; color: string
  }>> => ipcRenderer.invoke('pdfium:styledRuns', bytes, pageIndex),

  trocrStatus: (model?: 'small' | 'base'): Promise<{ ready: boolean; cached: boolean }> => ipcRenderer.invoke('trocr:status', model),
  trocrSetup: (model?: 'small' | 'base'): Promise<boolean> => ipcRenderer.invoke('trocr:setup', model),
  trocrRecognize: (png: ArrayBuffer, model?: 'small' | 'base'): Promise<string> => ipcRenderer.invoke('trocr:recognize', png, model),

  spellCheck: (text: string): Promise<Array<{ word: string; suggestions: string[] }>> =>
    ipcRenderer.invoke('dict:spellCheck', text),

  emailToPdf: (filePath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('email:toPdf', filePath),

  openOfficeFileDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:openOfficeFile'),

  importDocxSmart: (filePath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('file:importDocxSmart', filePath),

  // ── Markdown / CSV → PDF ────────────────────────────────────────────────────

  convertMarkdownToPdf: (markdownText: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('convert:markdownToPdf', markdownText),

  convertCsvToPdf: (csvText: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('convert:csvToPdf', csvText),

  // ── Email document ─────────────────────────────────────────────────────────

  openEmail: (recipient: string, subject: string, body: string): Promise<void> =>
    ipcRenderer.invoke('shell:openEmail', recipient, subject, body),

  // ── External editing round-trip ────────────────────────────────────────────

  exportPageForEdit: (bytes: ArrayBuffer, pageNum: number): Promise<{ pngPath: string; width: number; height: number }> =>
    ipcRenderer.invoke('file:exportPageForEdit', bytes, pageNum),

  reimportEditedPage: (pngPath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('file:reimportEditedPage', pngPath),
})
