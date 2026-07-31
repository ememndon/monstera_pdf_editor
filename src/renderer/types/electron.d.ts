export {}

declare global {
  interface Window {
    electronAPI: {
      openFileDialog: () => Promise<string | null>
      openMultipleFiles: () => Promise<string[]>
      openImageFile: () => Promise<string | null>
      saveFileDialog: (defaultPath: string) => Promise<string | null>
      chooseDirectory: () => Promise<string | null>

      clipboardWriteText: (text: string) => Promise<void>
      readFileBytes: (filePath: string) => Promise<ArrayBuffer>
      getMimeType: (filePath: string) => Promise<string>

      pdfiumStatus: () => Promise<{ available: boolean }>
      pdfiumRenderPage: (
        bytes: ArrayBuffer,
        pageIndex: number,
        scale: number,
      ) => Promise<{ data: ArrayBuffer; width: number; height: number }>
      pdfiumEnsureSession: (token: string, bytes: ArrayBuffer) => Promise<boolean>
      pdfiumCloseSession: () => Promise<void>
      pdfiumRenderSession: (
        token: string,
        pageIndex: number,
        scale: number,
      ) => Promise<{ stale: boolean; data?: ArrayBuffer; width?: number; height?: number }>
      pdfiumTextInRegion: (
        bytes: ArrayBuffer,
        pageIndex: number,
        rect: { x1: number; y1: number; x2: number; y2: number },
      ) => Promise<{ text: string; fontSize: number; found: boolean; color: string; matrix: number[]; fontData: ArrayBuffer; fontLoadable: boolean; nested: boolean; fontName: string }>
      pdfiumTextObjectAt: (
        bytes: ArrayBuffer,
        pageIndex: number,
        x: number,
        y: number,
      ) => Promise<{ found: boolean; text: string; fontSize: number; color: string; x1: number; y1: number; x2: number; y2: number; matrix: number[]; fontData: ArrayBuffer; fontLoadable: boolean; nested: boolean; fontName: string }>
      pdfiumTextBoxes: (
        bytes: ArrayBuffer, pageIndex: number,
      ) => Promise<Array<{ x1: number; y1: number; x2: number; y2: number; nested: boolean }>>
      resolveSystemFont: (
        name: string, bold: boolean, italic: boolean,
      ) => Promise<{ family: string; data: ArrayBuffer } | null>
      pdfiumObjectAt: (
        bytes: ArrayBuffer, pageIndex: number, x: number, y: number,
      ) => Promise<{ found: boolean; index: number; type: number; color: string; x1: number; y1: number; x2: number; y2: number }>
      pdfiumTransformObject: (
        bytes: ArrayBuffer, pageIndex: number, index: number,
        m: { a: number; b: number; c: number; d: number; e: number; f: number },
      ) => Promise<ArrayBuffer>
      pdfiumSetObjectFill: (
        bytes: ArrayBuffer, pageIndex: number, index: number,
        c: { r: number; g: number; b: number; a: number },
      ) => Promise<ArrayBuffer>
      pdfiumDeleteObject: (
        bytes: ArrayBuffer, pageIndex: number, index: number,
      ) => Promise<ArrayBuffer>
      pdfiumReplaceText: (
        bytes: ArrayBuffer, term: string, replacement: string, matchCase: boolean,
      ) => Promise<{ bytes: ArrayBuffer; count: number }>
      pdfiumEditText: (
        bytes: ArrayBuffer,
        pageIndex: number,
        rect: { x1: number; y1: number; x2: number; y2: number },
        newText: string,
      ) => Promise<ArrayBuffer>
      pdfiumEditTextAt: (
        bytes: ArrayBuffer,
        pageIndex: number,
        x: number,
        y: number,
        newText: string,
      ) => Promise<ArrayBuffer>
      pdfiumLineAt: (
        bytes: ArrayBuffer,
        pageIndex: number,
        x: number,
        y: number,
      ) => Promise<{ found: boolean; editable: boolean; text: string; x1: number; y1: number; x2: number; y2: number; baseY: number; fontSize: number; color: string; fontName: string; fontData: ArrayBuffer; fontLoadable: boolean }>
      pdfiumReplaceLine: (
        bytes: ArrayBuffer,
        pageIndex: number,
        x: number,
        y: number,
        newText: string,
        bbox?: { x1: number; y1: number; x2: number; y2: number },
      ) => Promise<{ bytes: ArrayBuffer; outcome: 'in-place' | 'in-place-form' | 'in-place-extended' | 'in-place-substituted' | 'substituted' | 'cleared' | 'unchanged'; substituteFamily: string }>
      pdfaConvert: (
        bytes: ArrayBuffer,
      ) => Promise<{ bytes: ArrayBuffer; report: Array<{ level: string; message: string }>; ok: boolean }>

      writeFile: (filePath: string, bytes: ArrayBuffer) => Promise<void>
      writeBytesToDir: (
        dirPath: string,
        files: Array<{ name: string; bytes: ArrayBuffer }>
      ) => Promise<void>

      mupdfGetMetadata: (bytes: ArrayBuffer) => Promise<{
        title: string; author: string; subject: string; keywords: string;
        creator: string; producer: string; needsPassword: boolean; encryption: string;
      }>
      mupdfSetMetadata: (bytes: ArrayBuffer, meta: Record<string, string>) => Promise<ArrayBuffer>
      mupdfEncrypt: (bytes: ArrayBuffer, opts: {
        userPassword: string; ownerPassword: string; permissions: number;
      }) => Promise<ArrayBuffer>
      mupdfRemovePassword: (bytes: ArrayBuffer, password: string) => Promise<ArrayBuffer>
      mupdfApplyRedactions: (bytes: ArrayBuffer, areas: Array<{
        pageNum: number; x1: number; y1: number; x2: number; y2: number; blurred?: boolean;
      }>) => Promise<ArrayBuffer>

      mupdfSynthesizeAppearances: (bytes: ArrayBuffer) => Promise<ArrayBuffer>
      mupdfGetOutline: (bytes: ArrayBuffer) => Promise<Array<{ id: string; title: string; pageNum: number }>>
      mupdfWriteOutline: (bytes: ArrayBuffer, bookmarks: Array<{ id: string; title: string; pageNum: number }>) => Promise<ArrayBuffer>

      pdfSign: (bytes: ArrayBuffer, pfxPath: string, pfxPassword: string, info: {
        name: string; reason: string; location: string; contactInfo: string;
      }) => Promise<ArrayBuffer>
      pdfVerifySignatures: (bytes: ArrayBuffer) => Promise<Array<{
        signerName: string; signerOrg: string; reason: string; location: string;
        contactInfo: string; certValidFrom: string; certValidTo: string; certCurrentlyValid: boolean;
        hashMatches: boolean; signatureValid: boolean;
        integrity: 'valid' | 'modified' | 'unknown'; coversWholeDocument: boolean;
      }>>

      exportToDocx: (bytes: ArrayBuffer, fileName: string, mode?: 'text' | 'layout') => Promise<ArrayBuffer>
      paragraphsToDocx: (pages: Array<{ page: number; paragraphs?: string[]; markdown?: string }>) => Promise<ArrayBuffer>
      exportToPptx: (bytes: ArrayBuffer, dpi?: number) => Promise<ArrayBuffer>

      formsIdentify: (bytes: ArrayBuffer) => Promise<Array<{
        pageNum: number; label: string; rect: [number, number, number, number]; fieldType: 'text' | 'checkbox' | 'date';
      }>>

      mupdfExtractAllText: (bytes: ArrayBuffer) => Promise<Array<{ pageNum: number; text: string }>>
      mupdfCheckAccessibility: (bytes: ArrayBuffer) => Promise<Array<{
        issue: string; severity: 'error' | 'warning' | 'info'; page?: number;
      }>>
      mupdfGenerateBookmarks: (bytes: ArrayBuffer) => Promise<Array<{
        title: string; pageNum: number; level: number;
      }>>

      mupdfOptimize: (bytes: ArrayBuffer) => Promise<{ bytes: ArrayBuffer; origSize: number; newSize: number }>
      mupdfFindTextRects: (bytes: ArrayBuffer, term: string) => Promise<Array<{ pageNum: number; x1: number; y1: number; x2: number; y2: number }>>

      openFromUrl: (url: string) => Promise<ArrayBuffer>
      openAnyFile: (filters: Array<{ name: string; extensions: string[] }>) => Promise<string | null>

      setWindowTitle: (title: string) => Promise<void>
      setDirty: (dirty: boolean) => Promise<void>
      confirmAppClose: () => Promise<void>
      printWindow: () => Promise<void>
      printPdf: (bytes: ArrayBuffer, opts: { pages?: number[]; dpi?: number }) => Promise<boolean>
      confirmUnsaved: (fileName: string) => Promise<'save' | 'discard' | 'cancel'>
      confirmSignatureInvalidation: () => Promise<boolean>

      // OS-keychain-backed encryption for secrets at rest (synchronous).
      secureEncryptSync: (plain: string) => string
      secureDecryptSync: (stored: string) => string
      onMenuAction: (callback: (action: string) => void) => void
      removeMenuActionListener: () => void
      onOpenFile: (callback: (filePath: string) => void) => void
      removeOpenFileListener: () => void
      getPendingOpenPath: () => Promise<string | null>
      getAppVersion: () => Promise<string>
      getPathForFile: (file: File) => string
      recoverySave: (id: string, fileName: string, filePath: string, bytes: ArrayBuffer) => Promise<void>
      recoveryList: () => Promise<Array<{ id: string; fileName: string; filePath: string; savedAt: number }>>
      recoveryRead: (id: string) => Promise<ArrayBuffer | null>
      recoveryDiscard: (id: string) => Promise<void>

      aiQuery: (apiKey: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>, systemPrompt: string) => Promise<string>
      aiVisionAnalyze: (apiKey: string, pngBytes: ArrayBuffer, mode: 'text' | 'tables', model?: string) => Promise<string | Array<{ rows: string[][] }>>

      importDocx: (bytes: ArrayBuffer) => Promise<ArrayBuffer>
      importXlsx: (bytes: ArrayBuffer) => Promise<ArrayBuffer>
      exportToXlsx: (bytes: ArrayBuffer) => Promise<ArrayBuffer>
      importDocxSmart: (filePath: string) => Promise<ArrayBuffer>
      openOfficeFileDialog: () => Promise<string | null>

      pdfSignWithTsa: (bytes: ArrayBuffer, pfxPath: string, pfxPassword: string, info: {
        name: string; reason: string; location: string; contactInfo: string;
      }, tsaUrl: string) => Promise<ArrayBuffer>
      pdfCertify: (bytes: ArrayBuffer, pfxPath: string, pfxPassword: string, info: {
        reason: string; permission: 1 | 2 | 3;
      }) => Promise<ArrayBuffer>

      binsGetStatus: () => Promise<{
        mutool: { path: string; available: boolean }
        ghostscript: { path: string; available: boolean }
        libreoffice: { path: string; available: boolean }
        qpdf?: { path: string; available: boolean }
        poppler?: { path: string; available: boolean }
        tesseract?: { path: string; available: boolean }
      }>
      binsOpenUrl: (url: string) => Promise<void>
      binsDownloadMutool: () => Promise<string>
      onBinsDownloadProgress: (cb: (data: { pct: number; mb?: string; status?: string }) => void) => void
      removeBinsDownloadListener: () => void

      gsToPdfa: (bytes: ArrayBuffer, level: 1 | 2 | 3) => Promise<ArrayBuffer>
      gsToPdfx: (bytes: ArrayBuffer) => Promise<ArrayBuffer>
      gsToGrayscale: (bytes: ArrayBuffer) => Promise<ArrayBuffer>
      gsToCmyk: (bytes: ArrayBuffer) => Promise<ArrayBuffer>
      gsOptimize: (bytes: ArrayBuffer, preset: string) => Promise<ArrayBuffer>
      gsLinearize: (bytes: ArrayBuffer) => Promise<ArrayBuffer>
      gsSanitize: (bytes: ArrayBuffer) => Promise<ArrayBuffer>
      gsRasterize: (bytes: ArrayBuffer, dpi: number) => Promise<ArrayBuffer>

      mutoolClean: (bytes: ArrayBuffer, opts: {
        repair?: boolean; garbage?: 0|1|2|3|4; compress?: boolean; linearize?: boolean; sanitize?: boolean
      }) => Promise<ArrayBuffer>
      mutoolInfo: (bytes: ArrayBuffer) => Promise<string>
      mutoolExtractFiles: (bytes: ArrayBuffer) => Promise<Array<{ name: string; size: number; dataBase64: string }>>
      mutoolConvert: (bytes: ArrayBuffer, ext: string) => Promise<ArrayBuffer>

      qpdfLinearize: (bytes: ArrayBuffer) => Promise<ArrayBuffer>
      qpdfRepair: (bytes: ArrayBuffer) => Promise<ArrayBuffer>
      qpdfDecrypt: (bytes: ArrayBuffer, pw: string) => Promise<ArrayBuffer>
      popplerTextLayout: (bytes: ArrayBuffer) => Promise<string>
      popplerExtractImages: (bytes: ArrayBuffer) => Promise<Array<{ name: string; dataBase64: string }>>
      tesseractOcrImage: (png: ArrayBuffer, lang: string) => Promise<string>

      libreofficeIsAvailable: () => Promise<boolean>
      libreofficeImportFile: (filePath: string) => Promise<ArrayBuffer>
      libreofficeImportBytes: (bytes: ArrayBuffer, ext: string) => Promise<ArrayBuffer>
      libreofficeExportDocx: (bytes: ArrayBuffer) => Promise<ArrayBuffer>
      libreofficeExportPptx: (bytes: ArrayBuffer) => Promise<ArrayBuffer>
      libreofficeExportXlsx: (bytes: ArrayBuffer) => Promise<ArrayBuffer>
      pdf2docxStatus: () => Promise<{ python: string; version: string; installed: boolean }>
      pdf2docxConvert: (bytes: ArrayBuffer) => Promise<ArrayBuffer>
      pdf2docxInstall: () => Promise<{ ok: boolean; version: string; log: string }>

      azureLayoutAnalyze: (bytes: ArrayBuffer, endpoint: string, key: string, pages: string) => Promise<unknown>
      azureReadAnalyze: (bytes: ArrayBuffer, endpoint: string, key: string, pages: string) => Promise<unknown>
      pdfiumStyledRuns: (bytes: ArrayBuffer, pageIndex: number) => Promise<Array<{
        text: string; x1: number; y1: number; x2: number; y2: number
        fontName: string; family: string; bold: boolean; italic: boolean
        fontSize: number; color: string
      }>>
      trocrStatus: (model?: 'small' | 'base') => Promise<{ ready: boolean; cached: boolean }>
      trocrSetup: (model?: 'small' | 'base') => Promise<boolean>
      trocrRecognize: (png: ArrayBuffer, model?: 'small' | 'base') => Promise<string>

      spellCheck: (text: string) => Promise<Array<{ word: string; suggestions: string[] }>>
      emailToPdf: (filePath: string) => Promise<ArrayBuffer>

      // New batch
      convertMarkdownToPdf: (markdownText: string) => Promise<ArrayBuffer>
      convertCsvToPdf: (csvText: string) => Promise<ArrayBuffer>
      openEmail: (recipient: string, subject: string, body: string) => Promise<void>
      exportPageForEdit: (bytes: ArrayBuffer, pageNum: number) => Promise<{ pngPath: string; width: number; height: number }>
      reimportEditedPage: (pngPath: string) => Promise<ArrayBuffer>
    }
  }
}
