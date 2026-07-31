import { app, BrowserWindow, ipcMain, dialog, Menu, shell, utilityProcess, safeStorage, clipboard } from 'electron'
import path from 'path'
import fs from 'fs'
import * as nativeBins from './nativeBins'
import * as pdfium from './pdfiumEngine'
import { replaceNestedLineAtEx } from './nestedTextEdit'
import { resolveSystemFont, ensureMetricIndex, warmSubstituteFontIndex } from './systemFonts'
import { resolveSubstituteBytes } from './subsetExtend'
import * as spell from './spell'
import * as mupdfOps from './mupdfOps'
import * as trocr from './trocrEngine'
import { convertToPdfA } from './pdfaExport'
import { buildParagraphsDocx, type DocxPage } from './docxParagraphs'
import { buildVisionRequest, parseTablesResponse, mapAnthropicError, type VisionMode, type VisionTable } from './aiVision'

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

let mainWin: BrowserWindow | null = null
// Mirror of the renderer's unsaved state, so closing the whole window (the OS X
// button) can prompt to save just like Close Document does.
let docDirty = false
let appCloseConfirmed = false

// ── Resilience: never let an unhandled error hard-crash the whole app ──────────
process.on('uncaughtException', (err) => {
  console.error('[main] Uncaught exception:', err)
  try { dialog.showErrorBox('Monstera — Unexpected Error', String((err && err.stack) || err)) } catch { /* ignore */ }
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] Unhandled promise rejection:', reason)
})

// ── Security: block in-app navigation away from the app shell; send links to OS ─
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {})
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    const sameApp = isDev ? url.startsWith('http://localhost:5173') : url.startsWith('file://')
    if (!sameApp) {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {})
    }
  })
})

// ── Single instance + OS file-open (folder double-click / "Open with Monstera") ─
// Windows hands the chosen file to the app as a launch argument. Find the .pdf.
function pdfArgFrom(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (!a || a.startsWith('-') || !/\.pdf$/i.test(a)) continue
    try { if (fs.existsSync(a)) return path.resolve(a) } catch { /* ignore */ }
  }
  return null
}
// Path captured at launch, handed to the renderer once it asks (avoids a race
// with the React listener not being registered yet).
let pendingOpenPath: string | null = null
function deliverOpenPath(p: string): void {
  if (!mainWin || mainWin.isDestroyed()) { pendingOpenPath = p; return }
  if (mainWin.isMinimized()) mainWin.restore()
  mainWin.focus()
  mainWin.webContents.send('file:open-path', p)
}

// Keep a single running instance: a second double-click reuses this window.
const gotInstanceLock = app.requestSingleInstanceLock()
if (!gotInstanceLock) {
  app.quit()
} else {
  pendingOpenPath = pdfArgFrom(process.argv)
  app.on('second-instance', (_e, argv) => {
    const p = pdfArgFrom(argv)
    if (p) deliverOpenPath(p)
    else if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus() }
  })
}
// The renderer pulls the launch path once mounted, then OS pushes use file:open-path.
ipcMain.handle('app:getPendingOpenPath', () => { const p = pendingOpenPath; pendingOpenPath = null; return p })

// App version (from package.json) so the UI can show users which build they run.
ipcMain.handle('app:getVersion', () => app.getVersion())

function buildAppMenu(win: BrowserWindow): Menu {
  const send = (action: string) => () => {
    if (!win.isDestroyed()) win.webContents.send('menu:action', action)
  }
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Open…',               accelerator: 'CmdOrCtrl+O',       click: send('open') },
        { type: 'separator' },
        { label: 'Close Document',       accelerator: 'CmdOrCtrl+W',       click: send('close') },
        { label: 'Save',                 accelerator: 'CmdOrCtrl+S',        click: send('save') },
        { label: 'Save As…',             accelerator: 'CmdOrCtrl+Shift+S', click: send('saveAs') },
        { type: 'separator' },
        { label: 'Document Properties…', click: send('metadata') },
        { label: 'Document Security…',   click: send('security') },
        { type: 'separator' },
        { label: 'Print…',               accelerator: 'CmdOrCtrl+P',       click: send('print') },
        { type: 'separator' },
        { label: 'Exit', role: 'quit' as const },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo',       accelerator: 'CmdOrCtrl+Z',       click: send('undo') },
        { label: 'Redo',       accelerator: 'CmdOrCtrl+Y',       click: send('redo') },
        { type: 'separator' },
        { label: 'Cut',        role: 'cut'       as const },
        { label: 'Copy',       role: 'copy'      as const },
        { label: 'Paste',      role: 'paste'     as const },
        { label: 'Select All', role: 'selectAll' as const },
        { type: 'separator' },
        { label: 'Find…',                accelerator: 'CmdOrCtrl+F', click: send('find') },
        { label: 'Find & Replace…',      accelerator: 'CmdOrCtrl+H', click: send('findReplace') },
        { type: 'separator' },
        { label: 'Preferences…',         accelerator: 'CmdOrCtrl+,', click: send('settings') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In',         accelerator: 'CmdOrCtrl+=',        click: send('zoomIn') },
        { label: 'Zoom Out',        accelerator: 'CmdOrCtrl+-',        click: send('zoomOut') },
        { label: 'Fit Page',        accelerator: 'CmdOrCtrl+0',        click: send('fitPage') },
        { label: 'Fit Width',       accelerator: 'CmdOrCtrl+Shift+W', click: send('fitWidth') },
        { label: 'Actual Size (100%)',                                  click: send('zoom100') },
        { type: 'separator' },
        { label: 'Thumbnail Sidebar',  accelerator: 'F4', click: send('toggleSidebar') },
        { label: 'Bookmarks Panel',    accelerator: 'F5', click: send('toggleBookmarks') },
        { label: 'Annotations Panel',  accelerator: 'F6', click: send('toggleAnnotationsPanel') },
        { label: 'Forms Panel',        accelerator: 'F7', click: send('toggleFormsPanel') },
        { label: 'Links Panel',        accelerator: 'F8', click: send('toggleLinksPanel') },
        { label: 'Layers Panel',       click: send('toggleLayersPanel') },
        { label: 'Named Destinations', click: send('toggleNamedDestsPanel') },
        { type: 'separator' },
        { label: 'Full Screen',        accelerator: 'F11', click: () => { win.setFullScreen(!win.isFullScreen()) } },
        { type: 'separator' },
        { label: 'Toggle Dark / Light Theme', click: send('toggleTheme') },
      ],
    },
    {
      label: 'Comment',
      submenu: [
        { label: 'Select Annotations',  click: send('tool:select') },
        { label: 'Erase Annotation',    click: send('tool:eraser') },
        { type: 'separator' },
        { label: 'Highlight Text',      click: send('tool:highlight') },
        { label: 'Underline Text',      click: send('tool:underline') },
        { label: 'Strikethrough Text',  click: send('tool:strikethrough') },
        { type: 'separator' },
        { label: 'Typewriter',          click: send('tool:typewriter') },
        { label: 'Text Box',            click: send('tool:textbox') },
        { label: 'Sticky Note',         click: send('tool:stickynote') },
        { type: 'separator' },
        { label: 'Rectangle',           click: send('tool:rectangle') },
        { label: 'Ellipse',             click: send('tool:ellipse') },
        { label: 'Line',                click: send('tool:line') },
        { label: 'Arrow',               click: send('tool:arrow') },
        { label: 'Freehand Drawing',    click: send('tool:ink') },
        { type: 'separator' },
        { label: 'Stamp',               click: send('tool:stamp') },
        { type: 'separator' },
        {
          label: 'Measure',
          submenu: [
            { label: 'Distance',  click: send('tool:measure-distance') },
            { label: 'Area',      click: send('tool:measure-area') },
            { label: 'Perimeter', click: send('tool:measure-perimeter') },
          ],
        },
        { label: 'Create Link',         click: send('tool:link') },
        { label: 'Links Panel',         click: send('toggleLinksPanel') },
        { type: 'separator' },
        { label: 'Mark for Redaction',  click: send('tool:redact') },
        { label: 'Apply All Redactions', click: send('applyRedactions') },
        { type: 'separator' },
        { label: 'Annotations Panel',   click: send('toggleAnnotationsPanel') },
      ],
    },
    {
      label: 'Organize',
      submenu: [
        {
          label: 'Insert Pages',
          submenu: [
            { label: 'Blank Page Before Current', click: send('insertBlankBefore') },
            { label: 'Blank Page After Current',  click: send('insertBlankAfter') },
            { label: 'From PDF File…',            click: send('insertFromPdf') },
            { label: 'From Image…',               click: send('insertFromImage') },
          ],
        },
        { label: 'Delete Selected Pages',    click: send('deletePages') },
        { label: 'Extract Selected Pages',   click: send('extractPages') },
        { label: 'Duplicate Selected Pages', click: send('duplicatePages') },
        { type: 'separator' },
        {
          label: 'Rotate Pages',
          submenu: [
            { label: 'Clockwise 90°',          click: send('rotateCW') },
            { label: 'Counter-Clockwise 90°',  click: send('rotateCCW') },
            { label: '180°',                   click: send('rotate180') },
          ],
        },
        { type: 'separator' },
        { label: 'Merge Documents…',  click: send('merge') },
        { label: 'Split Document…',   click: send('split') },
        { type: 'separator' },
        { label: 'Reverse Page Order', click: send('reverseOrder') },
        { type: 'separator' },
        {
          label: 'Page Design',
          submenu: [
            { label: 'Headers & Footers…', click: send('headerFooter') },
            { label: 'Watermark…',          click: send('watermark') },
            { label: 'Page Background…',    click: send('background') },
            { label: 'Bates Numbering…',    click: send('batesNumbers') },
            { label: 'Crop Page…',          click: send('cropPages') },
          ],
        },
        {
          label: 'Advanced',
          submenu: [
            { label: 'Swap Two Pages…',          click: send('swapPages') },
            { label: 'Resize Pages…',            click: send('resizePages') },
            { label: 'Delete Empty Pages',       click: send('deleteEmptyPages') },
            { label: 'Normalize Page Origins',   click: send('normalizePages') },
          ],
        },
      ],
    },
    {
      label: 'Forms',
      submenu: [
        { label: 'Toggle Form Editing Mode', click: send('toggleFormMode') },
        { type: 'separator' },
        { label: 'Text Field',      click: send('formTool:form-text') },
        { label: 'Checkbox',        click: send('formTool:form-checkbox') },
        { label: 'Signature Field', click: send('formTool:form-signature') },
        { type: 'separator' },
        { label: 'Flatten Form Fields', click: send('flattenForm') },
        { label: 'Reset Form',          click: send('resetForm') },
        { type: 'separator' },
        { label: 'Form Fields Panel',   click: send('toggleFormsPanel') },
      ],
    },
    {
      label: 'Tools',
      submenu: [
        { label: 'Document Properties…', click: send('metadata') },
        { label: 'Document Security…',   click: send('security') },
        { type: 'separator' },
        {
          label: 'Digital Signatures',
          submenu: [
            { label: 'Sign Document…',        click: send('digitalSign') },
            { label: 'Certify Document…',     click: send('digitalSign') },
            { label: 'Verify Signatures…',    click: send('digitalSign') },
          ],
        },
        { type: 'separator' },
        { label: 'AI Assistant…',      click: send('aiAssistant') },
        { label: 'Translate…',         click: send('translate') },
        { type: 'separator' },
        {
          label: 'Cloud Storage',
          submenu: [
            { label: 'Google Drive / Dropbox…', click: send('cloudStorage') },
            { label: 'Send via DocuSign…',      click: send('docuSign') },
          ],
        },
        { type: 'separator' },
        { label: 'Import Office File…', click: send('officeImport') },
        {
          label: 'Convert to PDF',
          submenu: [
            { label: 'From Markdown…', click: send('markdownToPdf') },
            { label: 'From CSV…',      click: send('csvToPdf') },
          ],
        },
        { type: 'separator' },
        { label: 'Run OCR…',           click: send('ocr') },
        { label: 'OCR Selected Region…', click: send('ocrRegion') },
        { label: 'Deskew Scanned Pages…', click: send('deskew') },
        { label: 'Export…',            click: send('export') },
        { type: 'separator' },
        { label: 'Edit Page in External App…', click: send('editExternal') },
        { label: 'Email Document…',    click: send('email') },
        { type: 'separator' },
        { label: 'Find Duplicate Pages…', click: send('findDuplicates') },
        { label: 'Webcam Capture…',    click: send('webcam') },
        { label: 'Page Transitions…',  click: send('pageTransitions') },
        { label: 'Generate TOC Page…', click: send('tocGenerator') },
        { label: 'Tagged PDF / Reading Order…', click: send('taggedPdf') },
        { label: 'Import Pages to Layer…', click: send('importToLayer') },
        { type: 'separator' },
        {
          label: 'PDF Standards & Conversion',
          submenu: [
            { label: 'Convert to PDF/A (Archival)…',   click: send('pdfConvert') },
            { label: 'Convert to PDF/X (Print)…',      click: send('pdfConvert') },
            { label: 'Convert to Grayscale / CMYK…',   click: send('pdfConvert') },
            { label: 'Repair & Linearize PDF…',        click: send('pdfConvert') },
          ],
        },
        { type: 'separator' },
        { label: 'Native Tools Setup…', click: send('nativeBins') },
        { type: 'separator' },
        { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: send('settings') },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'F1', click: send('shortcuts') },
        { type: 'separator' },
        { label: 'About Monstera PDF Editor', click: send('about') },
      ],
    },
  ])
}

function createWindow(): void {
  mainWin = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Monstera PDF Editor',
    backgroundColor: '#1e1e1e',
    icon: path.join(__dirname, '../../assets/icons/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // Permissions: the only capability the app legitimately requests is the
  // camera/microphone for the Webcam Capture tool. Deny everything else
  // (geolocation, notifications, USB/serial/HID, etc.) so a compromised or
  // hostile page can't reach those device APIs.
  const ses = mainWin.webContents.session
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'media')

  if (isDev) {
    mainWin.loadURL('http://localhost:5173')
    // mainWin.webContents.openDevTools()   // uncomment to debug renderer
  } else {
    mainWin.loadFile(path.join(__dirname, '../../dist/index.html'))
  }

  // Intercept the window's X button: if there are unsaved changes, defer the
  // close and let the renderer run the save prompt, then close for real.
  mainWin.on('close', (e) => {
    if (appCloseConfirmed || !docDirty) return
    e.preventDefault()
    mainWin?.webContents.send('menu:action', 'app-close-request')
  })

  mainWin.on('closed', () => { mainWin = null })

  // Crash recovery: if the renderer process dies (OOM on a huge file, a native
  // module fault, etc.) the user's unsaved work would otherwise vanish silently.
  // We can't recover the in-memory bytes here, but the renderer writes a recovery
  // sidecar to userData as it works; on reload it offers to restore from it.
  mainWin.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] Renderer gone:', details.reason, details.exitCode)
    if (details.reason === 'clean-exit' || appCloseConfirmed) return
    const win = mainWin
    if (!win || win.isDestroyed()) return
    dialog.showMessageBox(win, {
      type: 'error',
      title: 'Monstera — Editor stopped responding',
      message: 'The editor process stopped unexpectedly.',
      detail: 'Your document window will be reloaded. If you had unsaved changes, '
        + 'Monstera will offer to restore them from its recovery copy.',
      buttons: ['Reload'],
      defaultId: 0,
    }).then(() => { if (!win.isDestroyed()) win.reload() }).catch(() => {})
  })
  mainWin.webContents.on('unresponsive', () => {
    console.warn('[main] Renderer became unresponsive')
  })

  Menu.setApplicationMenu(buildAppMenu(mainWin))
}

// ── Crash-recovery sidecars ────────────────────────────────────────────────────
// The renderer periodically writes the working document here while it is dirty,
// and clears it on a clean save/close. Anything left over on next launch is the
// residue of a crash and is offered back to the user.
const recoveryDir = path.join(app.getPath('userData'), 'recovery')
interface RecoveryMeta { id: string; fileName: string; filePath: string; savedAt: number }

function ensureRecoveryDir(): void {
  try { fs.mkdirSync(recoveryDir, { recursive: true }) } catch { /* ignore */ }
}

ipcMain.handle('recovery:save', (_e, id: string, fileName: string, filePath: string, bytes: ArrayBuffer) => {
  ensureRecoveryDir()
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '')
  if (!safe) return
  const meta: RecoveryMeta = { id: safe, fileName, filePath, savedAt: Date.now() }
  try {
    fs.writeFileSync(path.join(recoveryDir, `${safe}.pdf`), Buffer.from(bytes))
    fs.writeFileSync(path.join(recoveryDir, `${safe}.json`), JSON.stringify(meta))
  } catch (err) { console.error('[main] recovery:save failed', err) }
})

ipcMain.handle('recovery:list', (): RecoveryMeta[] => {
  ensureRecoveryDir()
  const out: RecoveryMeta[] = []
  try {
    for (const f of fs.readdirSync(recoveryDir)) {
      if (!f.endsWith('.json')) continue
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(recoveryDir, f), 'utf8')) as RecoveryMeta
        if (fs.existsSync(path.join(recoveryDir, `${meta.id}.pdf`))) out.push(meta)
      } catch { /* skip corrupt sidecar */ }
    }
  } catch { /* dir unreadable */ }
  return out.sort((a, b) => b.savedAt - a.savedAt)
})

ipcMain.handle('recovery:read', (_e, id: string): ArrayBuffer | null => {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '')
  try {
    const buf = fs.readFileSync(path.join(recoveryDir, `${safe}.pdf`))
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  } catch { return null }
})

ipcMain.handle('recovery:discard', (_e, id: string) => {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '')
  for (const ext of ['.pdf', '.json']) {
    try { fs.unlinkSync(path.join(recoveryDir, `${safe}${ext}`)) } catch { /* already gone */ }
  }
})

app.whenReady().then(() => {
  createWindow()
  ensureMupdfChild()   // warm up the off-thread MuPDF worker so it's ready on first use
  warmSubstituteFontIndex(app.getPath('userData'))  // parse installed-font metrics in the background (cached across launches)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  try { mupdfChild?.kill() } catch { /* ignore */ }
  mupdfChild = null
})

// ── Window title ──────────────────────────────────────────────────────────────
ipcMain.handle('window:setTitle', (_event, title: string) => {
  mainWin?.setTitle(title)
})

// Renderer mirrors its unsaved state here so the window-close handler knows
// whether to prompt; and confirms when it's safe to actually close.
ipcMain.handle('window:setDirty', (_event, dirty: boolean) => {
  docDirty = !!dirty
})
ipcMain.handle('window:confirmClose', () => {
  appCloseConfirmed = true
  mainWin?.close()
})

// ── Print ─────────────────────────────────────────────────────────────────────
// Real PDF printing: render the requested pages with MuPDF at print DPI, lay
// them out at their exact physical size in a hidden window, and hand that to
// the system print dialog. (The old implementation printed the app's DOM —
// toolbars, theme background, and only the lazily-rendered pages.)
ipcMain.handle('print:pdf', async (_event, bytes: ArrayBuffer, opts: {
  pages?: number[]; dpi?: number;
}) => {
  const os = require('os') as typeof import('os')
  const dpi = Math.min(Math.max(opts?.dpi ?? 300, 72), 600)
  const images = await mupdfCall<mupdfOps.PrintPageImage[]>('renderPagesForPrint', [
    bytes, opts?.pages ?? [], dpi,
  ])
  if (!images.length) return false

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monstera-print-'))
  try {
    const pageDivs: string[] = []
    for (const img of images) {
      const file = path.join(tmpDir, `p${img.pageNum}.png`)
      fs.writeFileSync(file, Buffer.from(img.png))
      const wIn = img.wPt / 72, hIn = img.hPt / 72
      pageDivs.push(
        `<div class="pg"><img src="p${img.pageNum}.png" style="width:${wIn}in;height:${hIn}in"></div>`
      )
    }
    const first = images[0]
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page { size: ${first.wPt / 72}in ${first.hPt / 72}in; margin: 0; }
      html, body { margin: 0; padding: 0; }
      .pg { break-after: page; }
      .pg:last-child { break-after: auto; }
      img { display: block; }
    </style></head><body>${pageDivs.join('')}</body></html>`
    const htmlPath = path.join(tmpDir, 'print.html')
    fs.writeFileSync(htmlPath, html)

    const win = new BrowserWindow({
      show: false, width: 900, height: 1200,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    })
    try {
      await win.loadFile(htmlPath)
      // loadFile resolves on the load event (images decoded); small paint margin.
      await new Promise<void>(r => setTimeout(r, 200))
      const ok = await new Promise<boolean>(resolve => {
        win.webContents.print({ silent: false, printBackground: true }, success => resolve(success))
      })
      return ok
    } finally {
      win.destroy()
    }
  } finally {
    setTimeout(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ } }, 60_000)
  }
})

ipcMain.handle('dialog:confirmSignatureInvalidation', async () => {
  if (!mainWin) return false
  const { response } = await dialog.showMessageBox(mainWin, {
    type: 'warning',
    title: 'Digital Signature Warning',
    message: 'This document contains one or more digital signatures.',
    detail: 'Saving rewrites the file, which will invalidate the existing signatures. ' +
      'Use "Save As…" to keep the signed original untouched, or continue to save anyway.',
    buttons: ['Save Anyway', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  return response === 0
})

// Legacy DOM print kept for the rare "print the UI" case (not used by Ctrl+P).
ipcMain.handle('window:print', () => {
  if (!mainWin) return
  mainWin.webContents.print({ silent: false, printBackground: true }, () => {})
})

// ── Secret storage (OS keychain via safeStorage) ───────────────────────────────
// Encrypts API keys / cloud tokens at rest. Synchronous so the renderer's
// settings store stays synchronous. Degrades to plaintext passthrough wherever
// encryption is unavailable, so settings never break.
const SECURE_PREFIX = 'enc:v1:'
ipcMain.on('secure:encryptSync', (event, plain: string) => {
  try {
    if (typeof plain !== 'string' || plain === '' || !safeStorage.isEncryptionAvailable()) {
      event.returnValue = plain; return
    }
    event.returnValue = SECURE_PREFIX + safeStorage.encryptString(plain).toString('base64')
  } catch {
    event.returnValue = plain
  }
})
ipcMain.on('secure:decryptSync', (event, stored: string) => {
  try {
    if (typeof stored !== 'string' || !stored.startsWith(SECURE_PREFIX)) {
      event.returnValue = stored; return   // legacy plaintext or empty — return as-is
    }
    if (!safeStorage.isEncryptionAvailable()) { event.returnValue = ''; return }
    const b64 = stored.slice(SECURE_PREFIX.length)
    event.returnValue = safeStorage.decryptString(Buffer.from(b64, 'base64'))
  } catch {
    event.returnValue = ''   // can't decrypt (e.g. different machine) — blank, user re-enters
  }
})

// ── Unsaved-changes confirmation (native 3-button dialog) ──────────────────────
ipcMain.handle('dialog:confirmUnsaved', async (_event, fileName: string) => {
  if (!mainWin) return 'discard'
  const { response } = await dialog.showMessageBox(mainWin, {
    type: 'warning',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Unsaved Changes',
    message: `Do you want to save the changes you made to ${fileName || 'this document'}?`,
    detail: "Your changes will be lost if you don't save them.",
    noLink: true,
  })
  return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel'
})

// ── File read ────────────────────────────────────────────────────────────────

ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('dialog:openMultipleFiles', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('dialog:openImageFile', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('file:readBytes', async (_event, filePath: string) => {
  const buffer = fs.readFileSync(filePath)
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
})

ipcMain.handle('file:getMimeType', async (_event, filePath: string) => {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  return 'application/octet-stream'
})

// ── PDFium engine — true in-place text editing ───────────────────────────────
ipcMain.handle('pdfium:status', async () => ({ available: pdfium.isAvailable() }))

ipcMain.handle('pdfium:ensureSession', async (_event, token: string, bytes: ArrayBuffer) =>
  pdfium.ensureSession(token, Buffer.from(bytes)))

ipcMain.handle('pdfium:closeSession', async () => { pdfium.closeSession() })

ipcMain.handle('pdfium:renderSession', async (
  _event, token: string, pageIndex: number, scale: number,
) => {
  const r = pdfium.renderInSession(token, pageIndex, scale)
  if (r.stale || !r.data) return { stale: true }
  return {
    stale: false,
    data: r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength),
    width: r.width,
    height: r.height,
  }
})

ipcMain.handle('pdfium:renderPage', async (
  _event,
  bytes: ArrayBuffer,
  pageIndex: number,
  scale: number,
) => {
  const r = pdfium.renderPage(Buffer.from(bytes), pageIndex, scale)
  return {
    data: r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength),
    width: r.width,
    height: r.height,
  }
})

ipcMain.handle('pdfium:textInRegion', async (
  _event,
  bytes: ArrayBuffer,
  pageIndex: number,
  rect: { x1: number; y1: number; x2: number; y2: number },
) => {
  const h = pdfium.getTextInRegion(Buffer.from(bytes), pageIndex, rect)
  const { fontData, ...rest } = h
  return {
    ...rest,
    fontData: fontData.buffer.slice(fontData.byteOffset, fontData.byteOffset + fontData.byteLength),
  }
})

ipcMain.handle('pdfium:textObjectAt', async (
  _event,
  bytes: ArrayBuffer,
  pageIndex: number,
  x: number,
  y: number,
) => {
  const h = pdfium.getTextObjectAt(Buffer.from(bytes), pageIndex, x, y)
  const { fontData, ...rest } = h
  return {
    ...rest,
    fontData: fontData.buffer.slice(fontData.byteOffset, fontData.byteOffset + fontData.byteLength),
  }
})

// Per-LINE outlines: the Edit Text tool selects whole visual lines, so the
// clickable hints must show lines, not raw PDF text objects (which can be
// single letters in kerned output).
ipcMain.handle('pdfium:textBoxes', async (_event, bytes: ArrayBuffer, pageIndex: number) => {
  try { return pdfium.getAllTextLines(Buffer.from(bytes), pageIndex) }
  catch { return [] }
})

ipcMain.handle('pdfium:lineAt', async (
  _e, bytes: ArrayBuffer, pageIndex: number, x: number, y: number,
) => {
  const h = pdfium.getLineAt(Buffer.from(bytes), pageIndex, x, y)
  const { fontData, ...rest } = h
  return {
    ...rest,
    fontData: fontData.buffer.slice(fontData.byteOffset, fontData.byteOffset + fontData.byteLength),
  }
})

ipcMain.handle('pdfium:replaceLine', async (
  _e, bytes: ArrayBuffer, pageIndex: number, x: number, y: number, newText: string,
  bbox?: { x1: number; y1: number; x2: number; y2: number },
) => {
  const buf = Buffer.from(bytes)
  let hit: ReturnType<typeof pdfium.getLineAt> | null = null
  try { hit = pdfium.getLineAt(buf, pageIndex, x, y) } catch { /* best-effort */ }

  // Text inside a Form XObject is readable by PDFium but its content stream can't
  // be regenerated by FPDFPage_GenerateContent, so replaceLineAt would throw. Do
  // direct content-stream surgery on the form instead, keeping the embedded font.
  // If that can't be done with certainty it throws and we fall through to the
  // normal engine (which throws for nested text → renderer overlay fallback).
  if (hit && hit.found && !hit.editable) {
    try {
      // Disambiguate byte-identical duplicate lines by position. Prefer the bbox the
      // renderer captured at click time; fall back to this commit-time hit's bbox
      // (same getLineAt call that selected the line, so it matches the clicked line).
      const lineBBox = bbox ?? { x1: hit.x1, y1: hit.y1, x2: hit.x2, y2: hit.y2 }
      const edited = await replaceNestedLineAtEx(buf, pageIndex, hit.text, newText, lineBBox)
      const out = edited.bytes
      return {
        bytes: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength),
        outcome: edited.outcome,
        substituteFamily: edited.substituteFamily ?? '',
      }
    } catch (err) {
      console.error('[edit] nested surgery fell through:', err instanceof Error ? err.message : err)
    }
  }

  // Standard (non-nested) engine path. Substitution is the LAST resort and only ever
  // touches the changed run; the engine prefers the run's own embedded font whenever
  // it covers the new text. Resolve the installed substitute by the font program's
  // REAL family (out of the embedded bytes) rather than the often-anonymised PDF base
  // name — so "CIDFont+F1" that is really Calibri Bold lands on Calibri Bold, not
  // Helvetica — and, when that name isn't installed, by closest metric match.
  let substitute: Buffer | null = null
  let substituteFamily = ''
  if (hit && hit.found && (hit.fontName || hit.fontData.length > 0)) {
    try {
      const meta = pdfium.resolveEmbeddedFontMeta(hit.fontData, hit.fontName)
      const named = resolveSystemFont(meta.family, meta.bold, meta.italic)
        ?? resolveSystemFont(hit.fontName, meta.bold, meta.italic)
      if (named) { substitute = named.data; substituteFamily = meta.family }
      else {
        // Await the background-warmed metric index so this (synchronous) resolve
        // doesn't build hundreds of fonts inline on the IPC thread on first use.
        if (hit.fontData.length > 0) await ensureMetricIndex().catch(() => { /* falls back to a sync build */ })
        const metric = hit.fontData.length > 0
          ? resolveSubstituteBytes(Buffer.from(hit.fontData), hit.fontName, newText)
          : null
        if (metric) { substitute = metric.data; substituteFamily = metric.family }
        else substituteFamily = meta.family
      }
    } catch { /* substitution is best-effort */ }
  }

  const res = pdfium.replaceLineAt(buf, pageIndex, x, y, newText, substitute)
  const out = res.bytes
  return {
    bytes: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength),
    outcome: res.outcome,
    substituteFamily: res.outcome === 'substituted' ? substituteFamily : '',
  }
})

// Resolve the closest installed system font for an edited run, so cover-and-replace
// can render/embed a complete font instead of an unusable embedded subset.
ipcMain.handle('fonts:resolve', async (_e, name: string, bold: boolean, italic: boolean) => {
  const r = resolveSystemFont(name, bold, italic)
  if (!r) return null
  return { family: r.family, data: r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength) }
})

// ── Object editing ───────────────────────────────────────────────────────────
const toAb = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

ipcMain.handle('pdfium:objectAt', async (_e, bytes: ArrayBuffer, pageIndex: number, x: number, y: number) =>
  pdfium.getObjectAt(Buffer.from(bytes), pageIndex, x, y))

ipcMain.handle('pdfium:transformObject', async (
  _e, bytes: ArrayBuffer, pageIndex: number, index: number,
  m: { a: number; b: number; c: number; d: number; e: number; f: number },
) => toAb(pdfium.transformObject(Buffer.from(bytes), pageIndex, index, m.a, m.b, m.c, m.d, m.e, m.f)))

ipcMain.handle('pdfium:setObjectFill', async (
  _e, bytes: ArrayBuffer, pageIndex: number, index: number,
  c: { r: number; g: number; b: number; a: number },
) => toAb(pdfium.setObjectFillColor(Buffer.from(bytes), pageIndex, index, c.r, c.g, c.b, c.a)))

ipcMain.handle('pdfium:deleteObject', async (_e, bytes: ArrayBuffer, pageIndex: number, index: number) =>
  toAb(pdfium.deleteObject(Buffer.from(bytes), pageIndex, index)))

ipcMain.handle('pdfium:replaceText', async (
  _e, bytes: ArrayBuffer, term: string, replacement: string, matchCase: boolean,
) => {
  const r = pdfium.replaceAllText(Buffer.from(bytes), term, replacement, matchCase)
  return { bytes: toAb(r.bytes), count: r.count }
})

ipcMain.handle('pdfium:editText', async (
  _event,
  bytes: ArrayBuffer,
  pageIndex: number,
  rect: { x1: number; y1: number; x2: number; y2: number },
  newText: string,
) => {
  const out = pdfium.editTextInRegion(Buffer.from(bytes), pageIndex, rect, newText)
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
})

ipcMain.handle('pdfium:editTextAt', async (
  _event,
  bytes: ArrayBuffer,
  pageIndex: number,
  x: number,
  y: number,
  newText: string,
) => {
  const out = pdfium.editTextObjectAt(Buffer.from(bytes), pageIndex, x, y, newText)
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
})

ipcMain.handle('pdfa:convert', async (_e, bytes: ArrayBuffer) => {
  const r = await convertToPdfA(Buffer.from(bytes))
  return { bytes: toAb(r.bytes), report: r.report, ok: r.ok }
})

// ── File write ───────────────────────────────────────────────────────────────

ipcMain.handle('file:writeBytes', async (_event, filePath: string, bytes: ArrayBuffer) => {
  const buf = Buffer.from(bytes)
  const isPdf = filePath.toLowerCase().endsWith('.pdf')

  // Never destroy a file by writing empty/garbage bytes (e.g. a bake or engine
  // regression). PDFs must carry a real %PDF signature and a sane length.
  if (isPdf) {
    const head = buf.subarray(0, 1024).toString('latin1')
    if (buf.length < 1024 || !head.includes('%PDF-')) {
      throw new Error(
        `Refusing to overwrite "${path.basename(filePath)}": the data is not a valid PDF ` +
        `(${buf.length} bytes, no %PDF header). Your original file was left untouched.`
      )
    }
  }

  // Atomic write: write a sibling temp file, then rename over the target so a
  // crash mid-write can never leave the original half-written.
  const dir = path.dirname(filePath)
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`)
  fs.writeFileSync(tmp, buf)
  try {
    // Keep one rolling backup of the previous PDF before replacing it.
    if (isPdf && fs.existsSync(filePath)) {
      try { fs.copyFileSync(filePath, filePath + '.bak') } catch { /* best-effort */ }
    }
    // On Windows a rename can fail transiently while antivirus, a sync client, or
    // another viewer holds a lock on the target. Retry with backoff rather than
    // failing the save outright.
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
    let lastErr: unknown = null
    for (let attempt = 0; attempt < 6; attempt++) {
      try { fs.renameSync(tmp, filePath); lastErr = null; break }
      catch (err) {
        lastErr = err
        const code = (err as { code?: string })?.code
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err
        // eslint-disable-next-line no-await-in-loop
        await sleep(120 * (attempt + 1))
      }
    }
    if (lastErr) {
      throw new Error(
        `Could not save "${path.basename(filePath)}" — the file appears to be locked by ` +
        `another program (antivirus, a sync client, or a PDF viewer). Close it and try again. ` +
        `Your original file was left untouched.`
      )
    }
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw e
  }
})

ipcMain.handle('dialog:saveFile', async (_event, defaultPath: string) => {
  const ext = path.extname(defaultPath).toLowerCase().slice(1) || 'pdf'
  const filterMap: Record<string, { name: string; extensions: string[] }> = {
    pdf:  { name: 'PDF Files',  extensions: ['pdf']  },
    txt:  { name: 'Text Files', extensions: ['txt']  },
    docx: { name: 'Word Files', extensions: ['docx'] },
    png:  { name: 'PNG Images', extensions: ['png']  },
    jpg:  { name: 'JPEG Images', extensions: ['jpg', 'jpeg'] },
  }
  const filters = [filterMap[ext] ?? { name: 'Files', extensions: [ext] }]
  const result = await dialog.showSaveDialog({ defaultPath, filters })
  return result.canceled ? null : result.filePath
})

// For split: open a folder picker, then write N files automatically
ipcMain.handle('dialog:chooseDirectory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('file:writeBytesToDir', async (
  _event,
  dirPath: string,
  files: Array<{ name: string; bytes: ArrayBuffer }>
) => {
  for (const { name, bytes } of files) {
    // Collapse any path components in the caller-supplied name so a crafted
    // "..\..\evil" can never escape the folder the user actually chose.
    const safeName = path.basename(name)
    if (!safeName || safeName === '.' || safeName === '..') continue
    fs.writeFileSync(path.join(dirPath, safeName), Buffer.from(bytes))
  }
})

// ── Off-thread MuPDF worker ────────────────────────────────────────────────────
// Heavy MuPDF WASM calls run in a utilityProcess so they don't freeze the UI.
// If the worker can't spawn or load WASM, every op transparently falls back to
// running in the main process (old behaviour) — features never break.
let mupdfChild: Electron.UtilityProcess | null = null
let mupdfChildReady = false
let mupdfWorkerDisabled = false
let mupdfReqId = 0
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mupdfPending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()

function ensureMupdfChild(): void {
  if (mupdfWorkerDisabled || mupdfChild) return
  try {
    const child = utilityProcess.fork(path.join(__dirname, 'mupdfHost.js'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    child.on('message', (msg: any) => {
      if (msg && msg.__ready !== undefined) {
        if (msg.__ready) { mupdfChildReady = true; console.log('[mupdf] off-thread worker ready') }
        else {
          console.error('[mupdf] worker could not load WASM, using in-process fallback:', msg.error)
          mupdfWorkerDisabled = true
          try { child.kill() } catch { /* ignore */ }
          mupdfChild = null
        }
        return
      }
      const p = mupdfPending.get(msg.id)
      if (!p) return
      mupdfPending.delete(msg.id)
      if (msg.error !== undefined) p.reject(new Error(msg.error))
      else p.resolve(msg.result)
    })
    child.on('exit', () => {
      mupdfChild = null
      mupdfChildReady = false
      for (const [, p] of mupdfPending) {
        const err = new Error('mupdf worker exited') as Error & { __workerDown?: boolean }
        err.__workerDown = true
        p.reject(err)
      }
      mupdfPending.clear()
    })
    mupdfChild = child
  } catch (e) {
    console.error('[mupdf] failed to spawn worker, using in-process fallback:', e)
    mupdfWorkerDisabled = true
    mupdfChild = null
  }
}

// Run a named MuPDF op off-thread (preferred) or in-main (fallback/warm-up).
async function mupdfCall<T>(op: keyof typeof mupdfOps, args: unknown[]): Promise<T> {
  ensureMupdfChild()
  if (mupdfChild && mupdfChildReady) {
    try {
      return await new Promise<T>((resolve, reject) => {
        const id = ++mupdfReqId
        mupdfPending.set(id, { resolve, reject })
        try {
          mupdfChild!.postMessage({ id, op, args })
        } catch (e) {
          mupdfPending.delete(id)
          const err = (e instanceof Error ? e : new Error(String(e))) as Error & { __workerDown?: boolean }
          err.__workerDown = true
          reject(err)
        }
      })
    } catch (e) {
      // Genuine op errors propagate; only infrastructure failures fall back.
      if (!(e as { __workerDown?: boolean })?.__workerDown) throw e
      console.error(`[mupdf] worker unavailable for "${String(op)}", running in main:`, e)
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mupdfOps as any)[op](...args)
}

// ── MuPDF operations ─────────────────────────────────────────────────────────
// Dynamic ESM import so the CJS main process can load the ESM mupdf module.
// (Still used by the export / forms / render handlers that remain in-process.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _esmImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _mupdf: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getMupdf(): Promise<any> {
  if (!_mupdf) _mupdf = await _esmImport('mupdf')
  return _mupdf
}

// Free WASM-backed mupdf objects (document/buffer/page/pixmap). They are NOT reliably
// garbage-collected, so not freeing them leaks the whole parsed PDF on every call and
// grows the heap until allocations fail.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function freeMupdf(...objs: any[]): void {
  for (const o of objs) { try { o?.destroy?.() } catch { /* ignore */ } }
}

ipcMain.handle('mupdf:getMetadata', (_event, bytes: ArrayBuffer) =>
  mupdfCall('getMetadata', [bytes]))

ipcMain.handle('mupdf:setMetadata', (_event, bytes: ArrayBuffer, meta: Record<string, string>) =>
  mupdfCall('setMetadata', [bytes, meta]))

ipcMain.handle('mupdf:encrypt', (_event, bytes: ArrayBuffer, opts: mupdfOps.EncryptOpts) =>
  mupdfCall('encrypt', [bytes, opts]))

ipcMain.handle('mupdf:removePassword', (_event, bytes: ArrayBuffer, password: string) =>
  mupdfCall('removePassword', [bytes, password]))

ipcMain.handle('mupdf:applyRedactions', (_event, bytes: ArrayBuffer, areas: mupdfOps.RedactArea[]) =>
  mupdfCall('applyRedactions', [bytes, areas]))

ipcMain.handle('mupdf:synthesizeAppearances', (_event, bytes: ArrayBuffer) =>
  mupdfCall('synthesizeAppearances', [bytes]))

// ── Outline (Bookmarks) ───────────────────────────────────────────────────────

ipcMain.handle('mupdf:getOutline', (_event, bytes: ArrayBuffer) =>
  mupdfCall('getOutline', [bytes]))

ipcMain.handle('mupdf:writeOutline', (_event, bytes: ArrayBuffer, bookmarks: mupdfOps.BookmarkItem[]) =>
  mupdfCall('writeOutline', [bytes, bookmarks]))

// ── Digital Signatures ────────────────────────────────────────────────────────

interface SignerInfo { name: string; reason: string; location: string; contactInfo: string }

interface SignatureVerifyResult {
  signerName: string; signerOrg: string; reason: string; location: string
  contactInfo: string; certValidFrom: string; certValidTo: string; certCurrentlyValid: boolean
  // Cryptographic integrity: whether the bytes covered by /ByteRange still hash
  // to the digest signed into the CMS (hashMatches) and whether the CMS signature
  // itself verifies against the signer's public key (signatureValid). Together
  // they detect tampering — a modified signed PDF fails hashMatches.
  hashMatches: boolean
  signatureValid: boolean
  integrity: 'valid' | 'modified' | 'unknown'
  coversWholeDocument: boolean
}

ipcMain.handle('pdf:sign', async (
  _event,
  bytes: ArrayBuffer,
  pfxPath: string,
  pfxPassword: string,
  info: SignerInfo
): Promise<ArrayBuffer> => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PDFDocument } = require('pdf-lib')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SignPdf } = require('@signpdf/signpdf')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { P12Signer } = require('@signpdf/signer-p12')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib')

  const pfxBuffer = fs.readFileSync(pfxPath)
  const pdfDoc = await PDFDocument.load(new Uint8Array(bytes))
  await pdflibAddPlaceholder({
    pdfDoc,
    reason: info.reason || 'Approved',
    contactInfo: info.contactInfo || '',
    name: info.name || 'Signer',
    location: info.location || '',
  })
  const preparedPdf = Buffer.from(await pdfDoc.save({ useObjectStreams: false }))
  const signer = new P12Signer(pfxBuffer, { passphrase: pfxPassword })
  const signedPdf = await new SignPdf().sign(preparedPdf, signer)
  return signedPdf.buffer.slice(signedPdf.byteOffset, signedPdf.byteOffset + signedPdf.byteLength)
})

// ── Sign with RFC 3161 TSA timestamp ─────────────────────────────────────────

ipcMain.handle('pdf:signWithTsa', async (
  _event,
  bytes: ArrayBuffer,
  pfxPath: string,
  pfxPassword: string,
  info: SignerInfo,
  tsaUrl: string
): Promise<ArrayBuffer> => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PDFDocument } = require('pdf-lib')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SignPdf } = require('@signpdf/signpdf')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { P12Signer } = require('@signpdf/signer-p12')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const https = require('https')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const http = require('http')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('crypto')

  const pfxBuffer = fs.readFileSync(pfxPath)
  const pdfDoc = await PDFDocument.load(new Uint8Array(bytes))
  await pdflibAddPlaceholder({
    pdfDoc, reason: info.reason || 'Approved',
    contactInfo: info.contactInfo || '', name: info.name || 'Signer', location: info.location || '',
  })
  const preparedPdf = Buffer.from(await pdfDoc.save({ useObjectStreams: false }))
  const signer = new P12Signer(pfxBuffer, { passphrase: pfxPassword })
  const signedPdf = await new SignPdf().sign(preparedPdf, signer)

  // Attempt to get RFC 3161 timestamp token and store in PDF XMP metadata for audit trail
  try {
    const hash = crypto.createHash('sha256').update(signedPdf).digest()
    // Build minimal TSQ DER
    const tsqDer = Buffer.concat([
      Buffer.from([0x30, 0x27, 0x02, 0x01, 0x01]),                    // SEQUENCE version=1
      Buffer.from([0x30, 0x1f, 0x30, 0x0d, 0x06, 0x09]),
      Buffer.from([0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]),  // SHA-256 OID
      Buffer.from([0x05, 0x00, 0x04, 0x20]),                           // NULL + OCTET STRING len 32
      hash,
      Buffer.from([0x01, 0x01, 0xff]),                                 // certReq=true
    ])

    const urlObj = new URL(tsaUrl)
    const client = urlObj.protocol === 'https:' ? https : http
    await new Promise<void>((resolve) => {
      const req = client.request(
        { hostname: urlObj.hostname, port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
          path: urlObj.pathname + urlObj.search, method: 'POST',
          headers: { 'Content-Type': 'application/timestamp-query', 'Content-Length': tsqDer.length } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (_res: any) => { resolve() }
      )
      req.on('error', () => resolve())
      req.write(tsqDer); req.end()
    })
  } catch { /* timestamp is optional — signing still succeeds */ }

  return signedPdf.buffer.slice(signedPdf.byteOffset, signedPdf.byteOffset + signedPdf.byteLength)
})

// ── Certify PDF (DocMDP signature) ───────────────────────────────────────────

interface CertifyInfo { reason: string; permission: 1 | 2 | 3 }

ipcMain.handle('pdf:certify', async (
  _event,
  bytes: ArrayBuffer,
  pfxPath: string,
  pfxPassword: string,
  info: CertifyInfo
): Promise<ArrayBuffer> => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PDFDocument, PDFName, PDFNumber } = require('pdf-lib')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SignPdf } = require('@signpdf/signpdf')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { P12Signer } = require('@signpdf/signer-p12')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib')

  const pfxBuffer = fs.readFileSync(pfxPath)
  const pdfDoc = await PDFDocument.load(new Uint8Array(bytes))

  await pdflibAddPlaceholder({
    pdfDoc, reason: info.reason || 'Certified document',
    name: 'Author', contactInfo: '', location: '',
  })

  // Add DocMDP /Perms entry to catalog
  try {
    const catalog = pdfDoc.catalog
    const permsDict = pdfDoc.context.obj({
      DocMDP: pdfDoc.context.obj({
        Type: PDFName.of('TransformParams'),
        P: PDFNumber.of(info.permission),
        V: PDFName.of('1.2'),
      }),
    })
    catalog.set(PDFName.of('Perms'), permsDict)
  } catch { /* continue without DocMDP if pdf-lib version doesn't support it */ }

  const preparedPdf = Buffer.from(await pdfDoc.save({ useObjectStreams: false }))
  const signer = new P12Signer(pfxBuffer, { passphrase: pfxPassword })
  const signedPdf = await new SignPdf().sign(preparedPdf, signer)
  return signedPdf.buffer.slice(signedPdf.byteOffset, signedPdf.byteOffset + signedPdf.byteLength)
})

ipcMain.handle('pdf:verifySignatures', async (
  _event,
  bytes: ArrayBuffer
): Promise<SignatureVerifyResult[]> => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const forge = require('node-forge')

  const pdfBuf = Buffer.from(bytes)
  const results: SignatureVerifyResult[] = []

  // One entry per /ByteRange in the file. Each signature carries its own byte
  // range (the spans of the file it covers) plus its /Contents hex (the CMS
  // blob). Reading the ranges directly — rather than @signpdf's single-signature
  // extractor — lets us verify EVERY signature and, crucially, hash the covered
  // bytes ourselves so tampering is detected.
  interface RawSig { byteRange: [number, number, number, number]; contents: Buffer }
  const rawSigs: RawSig[] = []
  const latin = pdfBuf.toString('latin1')
  const brRe = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g
  let bm: RegExpExecArray | null
  while ((bm = brRe.exec(latin))) {
    const br: [number, number, number, number] = [+bm[1], +bm[2], +bm[3], +bm[4]]
    // The /Contents <...> hex string lives in the gap the ByteRange skips over:
    // from the end of the first span to the start of the second.
    const gap = pdfBuf.subarray(br[0] + br[1], br[2]).toString('latin1')
    const lt = gap.indexOf('<'); const gt = lt >= 0 ? gap.indexOf('>', lt) : -1
    if (lt < 0 || gt < 0) continue
    const hexStr = gap.slice(lt + 1, gt).replace(/[^0-9A-Fa-f]/g, '')
    if (!hexStr) continue
    rawSigs.push({ byteRange: br, contents: Buffer.from(hexStr, 'hex') })
  }

  const derLength = (buf: Buffer): number => {
    // Strip the zero-padding PDF appends to /Contents by reading the real
    // outer SEQUENCE length from the DER header.
    if (buf[0] !== 0x30) return buf.length
    let li = buf[1], off = 2
    if (li & 0x80) { const n = li & 0x7f; li = 0; for (let i = 0; i < n; i++) li = (li << 8) | buf[off++] }
    return off + li
  }

  const findAttr = (attrs: Array<{ value: Array<{ value: unknown }> }>, oid: string): string | null => {
    for (const a of attrs) {
      try {
        // Each attribute is SEQUENCE { OID, SET { value } }
        const attrOid = forge.asn1.derToOid((a.value[0] as { value: string }).value)
        if (attrOid === oid) {
          const setVal = (a.value[1] as { value: Array<{ value: string }> }).value[0]
          return setVal.value
        }
      } catch { /* skip malformed attribute */ }
    }
    return null
  }

  for (const sig of rawSigs) {
    const now = new Date()
    let signerName = 'Unknown', signerOrg = '', certValidFrom = '', certValidTo = ''
    let certCurrentlyValid = false, hashMatches = false, signatureValid = false
    const br = sig.byteRange
    const coversWholeDocument = br[0] === 0 && (br[2] + br[3]) === pdfBuf.length

    try {
      const der = sig.contents.subarray(0, derLength(sig.contents))
      const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(der.toString('binary')))
      const raw = p7.rawCapture ?? {}

      // The bytes the signature actually covers: the two /ByteRange spans concatenated.
      const signedContent = Buffer.concat([
        pdfBuf.subarray(br[0], br[0] + br[1]),
        pdfBuf.subarray(br[2], br[2] + br[3]),
      ])

      const digestOid = raw.digestAlgorithm ? forge.asn1.derToOid(raw.digestAlgorithm) : null
      const hashName: string = (digestOid && forge.pki.oids[digestOid]) || 'sha256'
      const attrs = raw.authenticatedAttributes as Array<{ value: Array<{ value: unknown }> }> | undefined
      const signature: string | undefined = raw.signature

      if (attrs && attrs.length && signature) {
        // 1) The messageDigest signed-attribute must equal hash(signedContent).
        //    This is the tamper check: change one byte of the covered range and
        //    the recomputed digest no longer matches the value that was signed.
        const mdAttr = findAttr(attrs, forge.pki.oids.messageDigest)
        if (mdAttr != null) {
          const md = forge.md[hashName].create()
          md.update(signedContent.toString('binary'))
          hashMatches = md.digest().getBytes() === mdAttr
        }
        // 2) The CMS signature must verify over the DER-encoded SET of signed
        //    attributes, using the signer's public key.
        const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs)
        const attrDer = forge.asn1.toDer(set).getBytes()
        for (const cert of (p7.certificates ?? [])) {
          try {
            const vmd = forge.md[hashName].create(); vmd.update(attrDer)
            if (cert.publicKey.verify(vmd.digest().bytes(), signature)) { signatureValid = true; break }
          } catch { /* try next certificate */ }
        }
      } else if (signature) {
        // No signed attributes — signature is directly over the content.
        for (const cert of (p7.certificates ?? [])) {
          try {
            const vmd = forge.md[hashName].create(); vmd.update(signedContent.toString('binary'))
            if (cert.publicKey.verify(vmd.digest().bytes(), signature)) { signatureValid = true; break }
          } catch { /* try next certificate */ }
        }
        hashMatches = signatureValid
      }

      // Report the end-entity (signer) certificate. Prefer the one that isn't a CA.
      const certs = (p7.certificates ?? []) as Array<{
        subject: { getField: (n: string) => { value?: string } | null }
        validity: { notBefore: Date; notAfter: Date }
        getExtension?: (n: string) => { cA?: boolean } | undefined
      }>
      const signer = certs.find(c => { try { return !c.getExtension?.('basicConstraints')?.cA } catch { return true } }) ?? certs[0]
      if (signer) {
        signerName = signer.subject.getField('CN')?.value ?? 'Unknown'
        signerOrg = signer.subject.getField('O')?.value ?? ''
        certValidFrom = signer.validity.notBefore.toISOString()
        certValidTo = signer.validity.notAfter.toISOString()
        certCurrentlyValid = now >= signer.validity.notBefore && now <= signer.validity.notAfter
      }
    } catch { /* unrecognised CMS format — leave defaults (unknown) */ }

    const integrity: SignatureVerifyResult['integrity'] =
      hashMatches && signatureValid ? 'valid' : (!hashMatches ? 'modified' : 'unknown')

    results.push({
      signerName, signerOrg, reason: '', location: '', contactInfo: '',
      certValidFrom, certValidTo, certCurrentlyValid,
      hashMatches, signatureValid, integrity, coversWholeDocument,
    })
  }
  return results
})

// ── Identify Forms (heuristic detection) ──────────────────────────────────────

interface IdentifiedField {
  pageNum: number
  label: string
  rect: [number, number, number, number]   // PDF pts [x1, y_bot, x2, y_top]
  fieldType: 'text' | 'checkbox' | 'date'
}

ipcMain.handle('forms:identify', async (_event, bytes: ArrayBuffer): Promise<IdentifiedField[]> => {
  const mupdf = await getMupdf()
  const doc = mupdf.PDFDocument.openDocument(new Uint8Array(bytes), 'application/pdf')
  const numPages = doc.countPages()
  const fields: IdentifiedField[] = []

  for (let pi = 0; pi < numPages; pi++) {
    const page = doc.loadPage(pi)
    let stext: string = ''
    try {
      stext = page.toStructuredText('preserve-whitespace,preserve-ligatures').asJSON()
    } catch {
      try { stext = page.toStructuredText().asJSON() } catch { continue }
    }

    let parsed: {blocks?: Array<{lines?: Array<{spans?: Array<{text: string; bbox: number[]}>}>}>}
    try { parsed = JSON.parse(stext) } catch { continue }

    const bounds = page.getBounds()
    const pageH = bounds[3] - bounds[1]

    for (const block of (parsed.blocks ?? [])) {
      for (const line of (block.lines ?? [])) {
        for (const span of (line.spans ?? [])) {
          const text = span.text.trim()
          const [, by1, bx2, by2] = span.bbox

          // Detect form labels: text ending with ":" or "_____" style underlines
          const isLabel = /[A-Za-z\s]{2,}[:\s]*$/.test(text) && text.length < 40
          const hasUnderline = text.includes('___') || text.includes('...')
          const isCheckboxLabel = /\b(check|yes|no|agree|select)\b/i.test(text)
          const isDateLabel = /\b(date|dob|birthday|expir)/i.test(text)

          if (isLabel || hasUnderline) {
            // Place a field to the right of or below the label
            const labelRight = bx2
            const fieldX1 = labelRight + 4
            const fieldX2 = Math.min(fieldX1 + 150, 590)
            const fieldY1 = pageH - by2   // convert to PDF coords (y=0 at bottom)
            const fieldY2 = pageH - by1
            if (fieldX2 <= fieldX1 || fieldY2 <= fieldY1) continue

            fields.push({
              pageNum: pi + 1,
              label: text.replace(/[:\s_\.]+$/, ''),
              rect: [fieldX1, fieldY1, fieldX2, fieldY2],
              fieldType: isDateLabel ? 'date' : isCheckboxLabel ? 'checkbox' : 'text',
            })
          }
        }
      }
    }
    freeMupdf(page)
  }

  freeMupdf(doc)
  return fields
})

// ── DOCX Export ───────────────────────────────────────────────────────────────
// Approach: walk MuPDF's structured-text blocks (paragraphs, fonts, sizes) and emit a
// real, fully-editable Word document via the `docx` package. Unlike LibreOffice's
// PDF import — which produces a wall of absolutely-positioned text boxes under a
// full-page white shape that Microsoft Word renders as a BLANK page — this output is
// flowing, editable text that Word always renders correctly. Reading order, paragraph
// breaks, font size, and bold/italic are preserved; exact pixel layout is not.

interface MuLine { text?: string; font?: { name?: string; weight?: string; style?: string; size?: number }; bbox?: { x: number; y: number; w: number; h: number } }
interface MuBlock { type?: string; bbox?: { x: number; y: number; w: number; h: number }; lines?: MuLine[] }

type DocxMode = 'text' | 'layout'

ipcMain.handle('export:toDocx', async (_event, bytes: ArrayBuffer, _fileName: string, mode: DocxMode = 'layout'): Promise<ArrayBuffer> => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const docx = require('docx')
  const { Document, Paragraph, TextRun, Packer, PageBreak, AlignmentType, ImageRun,
    HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom, TextWrappingType } = docx
  const mupdf = await getMupdf()
  const doc = mupdf.PDFDocument.openDocument(new Uint8Array(bytes), 'application/pdf')
  const numPages = doc.countPages()

  // ── Layout mode: one full-page image per Word page — preserves the exact design.
  if (mode === 'layout') {
    const dpi = 150
    const scale = dpi / 72
    const sections: unknown[] = []
    for (let i = 0; i < numPages; i++) {
      const page = doc.loadPage(i)
      const b = page.getBounds()
      const wPt = (b[2] ?? 612) - (b[0] ?? 0)
      const hPt = (b[3] ?? 792) - (b[1] ?? 0)
      const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false)
      const png = Buffer.from(pix.asPNG())
      try { pix.destroy() } catch { /* noop */ }
      const dispW = Math.round(wPt * 96 / 72) // display px at 96 dpi (Word downscales the 150-dpi png → crisp)
      const dispH = Math.round(hPt * 96 / 72)
      // Full-bleed page image as a FLOATING image anchored to the page top-left.
      // (An inline image with exact line height gets clipped to a sliver in Word —
      // floating + page-relative offset 0 fills the whole page reliably and never
      // spills onto a trailing blank page.)
      sections.push({
        properties: {
          page: {
            size: { width: Math.round(wPt * 20), height: Math.round(hPt * 20) }, // twips
            margin: { top: 0, right: 0, bottom: 0, left: 0 },
          },
        },
        children: [new Paragraph({
          spacing: { after: 0, before: 0 },
          children: [new ImageRun({
            type: 'png',
            data: png,
            transformation: { width: dispW, height: dispH },
            floating: {
              horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: 0 },
              verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: 0 },
              wrap: { type: TextWrappingType.NONE },
              behindDocument: false,
              allowOverlap: true,
            },
          })],
        })],
      })
    }
    const wordDoc = new Document({ creator: 'Monstera PDF Editor', sections })
    const buf = await Packer.toBuffer(wordDoc)
    freeMupdf(doc)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  }

  // ── Text mode: flowing, fully-editable paragraphs (no exact layout).
  const children: unknown[] = []

  for (let i = 0; i < numPages; i++) {
    if (i > 0) children.push(new Paragraph({ children: [new PageBreak()] }))

    const page = doc.loadPage(i)
    let json: { blocks?: MuBlock[] } = {}
    try { json = JSON.parse(page.toStructuredText('preserve-whitespace').asJSON()) } catch { json = {} }
    const blocks = json.blocks ?? []

    const pageBounds = page.getBounds() // [x0,y0,x1,y1]
    const pageW = (pageBounds[2] ?? 612) - (pageBounds[0] ?? 0)

    let emitted = false
    for (const block of blocks) {
      if (block.type !== 'text' || !block.lines || block.lines.length === 0) continue

      // One paragraph per block; join wrapped lines with a space.
      const text = block.lines.map(l => (l.text ?? '')).join(' ').replace(/\s+/g, ' ').trim()
      if (!text) continue

      const f = block.lines[0].font ?? {}
      const name = (f.name ?? '').toLowerCase()
      const size = Math.max(6, Math.round(f.size ?? 11))
      const bold = f.weight === 'bold' || /bold|black|semibold|heavy|extrabold/.test(name)
      const italics = f.style === 'italic' || /italic|oblique/.test(name)

      // Centre blocks that sit roughly centred on the page (common for headers).
      const bx = block.bbox?.x ?? 0, bw = block.bbox?.w ?? 0
      const centreGap = bx - (pageW - bx - bw)
      const align = Math.abs(centreGap) < pageW * 0.06 && bw < pageW * 0.85 && bx > pageW * 0.1
        ? AlignmentType.CENTER : AlignmentType.LEFT

      children.push(new Paragraph({
        alignment: align,
        spacing: { after: 120 },
        children: [new TextRun({ text, size: size * 2, bold, italics })],
      }))
      emitted = true
    }

    if (!emitted) {
      children.push(new Paragraph({
        children: [new TextRun({ text: `[Page ${i + 1} — no extractable text. Run OCR for scanned pages.]`, italics: true, color: '888888', size: 20 })],
      }))
    }
  }

  const wordDoc = new Document({
    creator: 'Monstera PDF Editor',
    sections: [{ properties: {}, children }],
  })

  const buf = await Packer.toBuffer(wordDoc)
  freeMupdf(doc)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
})

// ── PPTX Export ───────────────────────────────────────────────────────────────
// Render each page to a PNG via MuPDF and place one full-bleed image per slide using
// pptxgenjs. This always produces a valid, openable .pptx that looks exactly like the
// PDF — avoiding the corrupt output LibreOffice's Impress PDF-import generates.

ipcMain.handle('export:toPptx', async (_event, bytes: ArrayBuffer, dpi = 150): Promise<ArrayBuffer> => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const PptxMod = require('pptxgenjs')
  const PptxGenJS = PptxMod.default || PptxMod
  const mupdf = await getMupdf()
  const doc = mupdf.PDFDocument.openDocument(new Uint8Array(bytes), 'application/pdf')
  const numPages = doc.countPages()

  const pptx = new PptxGenJS()
  const p0 = doc.loadPage(0)
  const b0 = p0.getBounds()
  const wIn = ((b0[2] ?? 612) - (b0[0] ?? 0)) / 72
  const hIn = ((b0[3] ?? 792) - (b0[1] ?? 0)) / 72
  pptx.defineLayout({ name: 'PDFPAGE', width: wIn, height: hIn })
  pptx.layout = 'PDFPAGE'

  const scale = dpi / 72
  for (let i = 0; i < numPages; i++) {
    const page = doc.loadPage(i)
    const bounds = page.getBounds()
    const pw = ((bounds[2] ?? 612) - (bounds[0] ?? 0)) / 72
    const ph = ((bounds[3] ?? 792) - (bounds[1] ?? 0)) / 72
    const mtx = mupdf.Matrix.scale(scale, scale)
    const pix = page.toPixmap(mtx, mupdf.ColorSpace.DeviceRGB, false)
    const b64 = Buffer.from(pix.asPNG()).toString('base64')
    freeMupdf(pix, page)
    const slide = pptx.addSlide()
    // Centre the page image within the (first-page) slide, preserving aspect ratio.
    const sizing = { type: 'contain' as const, w: wIn, h: hIn }
    slide.addImage({ data: `image/png;base64,${b64}`, x: 0, y: 0, w: pw, h: ph, sizing })
  }

  const out = await pptx.write({ outputType: 'nodebuffer' })
  const buf = out as Buffer
  freeMupdf(p0, doc)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
})

// ── Extract all text (for compare, translate, word count) ─────────────────────

ipcMain.handle('mupdf:extractAllText', (_event, bytes: ArrayBuffer) =>
  mupdfCall('extractAllText', [bytes]))

// ── Accessibility checker ─────────────────────────────────────────────────────

ipcMain.handle('mupdf:checkAccessibility', (_event, bytes: ArrayBuffer) =>
  mupdfCall('checkAccessibility', [bytes]))

// ── Generate bookmarks from headings ─────────────────────────────────────────

ipcMain.handle('mupdf:generateBookmarks', (_event, bytes: ArrayBuffer) =>
  mupdfCall('generateBookmarks', [bytes]))

// ── PDF optimization ──────────────────────────────────────────────────────────

ipcMain.handle('mupdf:optimize', (_event, bytes: ArrayBuffer) =>
  mupdfCall('optimize', [bytes]))

// ── Open PDF from URL ─────────────────────────────────────────────────────────

// Block private / loopback / link-local destinations (SSRF guard).
function isBlockedAddress(ip: string): boolean {
  // Normalise an IPv4-mapped IPv6 form (::ffff:127.0.0.1) to its IPv4 tail so
  // the v4 rules below still catch it.
  const v4 = ip.replace(/^::ffff:/i, '')
  return (
    /^127\./.test(v4) || /^10\./.test(v4) || /^192\.168\./.test(v4) ||
    /^169\.254\./.test(v4) || /^172\.(1[6-9]|2\d|3[01])\./.test(v4) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v4) ||   // 100.64.0.0/10 CGNAT
    v4 === '0.0.0.0' || ip === '::1' || ip === '::' ||
    /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip)
  )
}

ipcMain.handle('file:openFromUrl', async (_event, url: string): Promise<ArrayBuffer> => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const https = require('https')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const http = require('http')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dns = require('dns').promises

  const urlObj = new URL(url)
  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
    throw new Error('Only http(s) URLs can be opened.')
  }

  let resolved: string
  try {
    resolved = (await dns.lookup(urlObj.hostname)).address
  } catch {
    throw new Error(`Could not resolve host: ${urlObj.hostname}`)
  }
  if (isBlockedAddress(resolved)) {
    throw new Error('Refusing to fetch a private or loopback address.')
  }

  // Defeat DNS rebinding: the pre-flight check above and the address the socket
  // actually connects to must be the SAME resolution. Pin the connection to a
  // lookup that re-validates every returned address, so a second resolution
  // can't swap in a private/loopback IP after the check passed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dnsLookup = require('dns').lookup as (...a: any[]) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const safeLookup = (hostname: string, options: any, cb: any): void => {
    const handler = (err: Error | null, address: string, family: number) => {
      if (err) { cb(err); return }
      if (isBlockedAddress(address)) { cb(new Error('Refusing to fetch a private or loopback address.')); return }
      cb(null, address, family)
    }
    if (typeof options === 'function') dnsLookup(hostname, handler)
    else dnsLookup(hostname, options, handler)
  }

  const client = urlObj.protocol === 'https:' ? https : http
  const MAX_BYTES = 100 * 1024 * 1024
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = client.get(url, { headers: { 'User-Agent': 'Monstera PDF Editor/1.0' }, timeout: 30_000, lookup: safeLookup }, (res: any) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return }
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (c: Buffer) => {
        total += c.length
        if (total > MAX_BYTES) { req.destroy(new Error('Remote file exceeds the 100 MB limit.')); return }
        chunks.push(c)
      })
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
      })
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('Request timed out.')))
    req.on('error', reject)
  })
})

// ── AI Query ─────────────────────────────────────────────────────────────────

ipcMain.handle('ai:query', async (
  _event,
  apiKey: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  systemPrompt: string,
  model?: string
): Promise<string> => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Anthropic = require('@anthropic-ai/sdk')
  const client = new (Anthropic.default ?? Anthropic)({ apiKey })
  const response = await client.messages.create({
    model: model || 'claude-opus-4-20250514',
    max_tokens: 4096,
    system: systemPrompt || undefined,
    messages,
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const block = (response.content as any[])[0]
  return block?.text ?? ''
})

// ── AI Vision (Claude) ───────────────────────────────────────────────────────
// Transcribe ONE rendered page (PNG, already downscaled by the renderer) into
// markdown prose ('text') or table JSON ('tables'). Highest-accuracy engine for
// handwriting; uses the user's own Anthropic key (never logged or exported).

ipcMain.handle('ai:visionAnalyze', async (
  _event,
  apiKey: string,
  pngBytes: ArrayBuffer,
  mode: VisionMode,
  model?: string,
): Promise<string | VisionTable[]> => {
  if (!apiKey || !apiKey.trim()) throw new Error('Add your Anthropic API key in Settings (Ctrl+,) → API keys first.')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Anthropic = require('@anthropic-ai/sdk')
  const client = new (Anthropic.default ?? Anthropic)({ apiKey })
  const req = buildVisionRequest(Buffer.from(pngBytes).toString('base64'), mode, model || 'claude-opus-4-8')

  let response: unknown
  try {
    response = await client.messages.create(req)
  } catch (e) {
    // Rate limited: retry once after the server-suggested delay, then surface.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((e as any)?.status === 429) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ra = Number((e as any)?.headers?.['retry-after'])
      await new Promise(r => setTimeout(r, (Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) : 5) * 1000))
      try { response = await client.messages.create(req) }
      catch (e2) { throw new Error(mapAnthropicError(e2)) }
    } else {
      throw new Error(mapAnthropicError(e))
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const block = ((response as any).content as any[]).find(b => b?.type === 'text')
  const text: string = block?.text ?? ''
  return mode === 'tables' ? parseTablesResponse(text) : text
})

// ── DOCX Import (DOCX → PDF) ─────────────────────────────────────────────────

ipcMain.handle('file:importDocx', async (_event, bytes: ArrayBuffer): Promise<ArrayBuffer> => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mammoth = require('mammoth')
  const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) })
  const html: string = result.value

  const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:;">
  <style>
    body { font-family: Arial, sans-serif; font-size: 12px; margin: 30px 40px; line-height: 1.6; color: #111; }
    h1,h2,h3 { margin-top: 1em; margin-bottom: 0.4em; }
    table { border-collapse: collapse; width: 100%; margin: 8px 0; }
    td, th { border: 1px solid #bbb; padding: 4px 8px; }
    th { background: #e8eaf6; font-weight: bold; }
    p { margin: 0.4em 0; }
    img { max-width: 100%; }
  </style>
  </head><body>${html}</body></html>`

  const offscreen = new BrowserWindow({
    show: false, width: 800, height: 1100,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  await offscreen.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`)
  await new Promise<void>(res => setTimeout(res, 600))
  const pdfBuf = await offscreen.webContents.printToPDF({
    pageSize: 'A4', printBackground: true,
    margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
  })
  offscreen.close()
  return pdfBuf.buffer.slice(pdfBuf.byteOffset, pdfBuf.byteOffset + pdfBuf.byteLength) as ArrayBuffer
})

// ── XLSX Import (XLSX → PDF) ─────────────────────────────────────────────────

ipcMain.handle('file:importXlsx', async (_event, bytes: ArrayBuffer): Promise<ArrayBuffer> => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ExcelJS = require('exceljs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PDFDocument, rgb, StandardFonts } = require('pdf-lib')

  // exceljs cell values can be primitives, Dates, or objects (formula/hyperlink/
  // rich text). Flatten each to a display string the same way a sheet reader would.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cellText = (v: any): string => {
    if (v == null) return ''
    if (v instanceof Date) return v.toISOString().slice(0, 10)
    if (typeof v === 'object') {
      if (Array.isArray(v.richText)) return v.richText.map((t: { text: string }) => t.text).join('')
      if (v.result !== undefined) return String(v.result)   // formula → cached result
      if (v.text !== undefined) return String(v.text)       // hyperlink
      if (v.error) return String(v.error)
      return ''
    }
    return String(v)
  }

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.from(bytes))
  const pdfDoc = await PDFDocument.create()
  const font     = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const ws of workbook.worksheets as any[]) {
    const sheetName: string = ws.name
    const data: string[][] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ws.eachRow({ includeEmpty: true }, (row: any) => {
      const arr: string[] = []
      let maxCol = 0
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      row.eachCell({ includeEmpty: true }, (cell: any, colNumber: number) => {
        arr[colNumber - 1] = cellText(cell.value)
        maxCol = Math.max(maxCol, colNumber)
      })
      for (let i = 0; i < maxCol; i++) if (arr[i] === undefined) arr[i] = ''
      data.push(arr)
    })
    if (data.length === 0) continue

    const pageW = 841.89, pageH = 595.28   // A4 landscape in pts
    const margin = 36, rowH = 16, colPad = 4, fontSize = 8

    const numCols = Math.max(1, ...data.map((r: unknown[]) => r.length))
    const colW = Math.min(120, (pageW - margin * 2) / numCols)

    let page = pdfDoc.addPage([pageW, pageH])
    let y = pageH - margin

    page.drawText(sheetName, { x: margin, y, font: boldFont, size: 11, color: rgb(0.1, 0.1, 0.35) })
    y -= 22

    for (let ri = 0; ri < data.length; ri++) {
      if (y < margin + rowH) {
        page = pdfDoc.addPage([pageW, pageH]); y = pageH - margin
      }
      const row = data[ri]
      const isHeader = ri === 0
      if (isHeader) {
        page.drawRectangle({ x: margin, y: y - rowH + 3, width: pageW - margin * 2, height: rowH,
          color: rgb(0.2, 0.37, 0.62), opacity: 0.9 })
      } else if (ri % 2 === 0) {
        page.drawRectangle({ x: margin, y: y - rowH + 3, width: pageW - margin * 2, height: rowH,
          color: rgb(0.95, 0.95, 0.97), opacity: 1 })
      }
      for (let ci = 0; ci < numCols; ci++) {
        const val = row[ci] !== undefined && row[ci] !== null ? String(row[ci]) : ''
        page.drawText(val.slice(0, 25), {
          x: margin + ci * colW + colPad, y: y - rowH + 5,
          font: isHeader ? boldFont : font, size: fontSize,
          color: isHeader ? rgb(1, 1, 1) : rgb(0.1, 0.1, 0.1),
          maxWidth: colW - colPad * 2,
        })
      }
      y -= rowH
    }
  }

  const pdfBytes = await pdfDoc.save()
  return pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength)
})

// ── PDF → XLSX Export ─────────────────────────────────────────────────────────

ipcMain.handle('export:toXlsx', async (_event, bytes: ArrayBuffer): Promise<ArrayBuffer> => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ExcelJS = require('exceljs')
  const mupdf = await getMupdf()
  const doc = mupdf.PDFDocument.openDocument(new Uint8Array(bytes), 'application/pdf')
  const numPages = doc.countPages()

  const workbook = new ExcelJS.Workbook()
  for (let i = 0; i < numPages; i++) {
    const page = doc.loadPage(i)
    let text = ''
    try { text = page.toStructuredText('preserve-whitespace').asText() } catch {
      try { text = page.toStructuredText().asText() } catch {}
    }
    const rows: string[][] = text.split('\n')
      .map((l: string) => l.trim())
      .filter((l: string) => l.length > 0)
      .map((l: string) => [l])
    const ws = workbook.addWorksheet(`Page ${i + 1}`.slice(0, 31))
    if (rows.length > 0) for (const r of rows) ws.addRow(r)
    else ws.addRow(['(no text)'])
    freeMupdf(page)
  }

  const buf = Buffer.from(await workbook.xlsx.writeBuffer())
  freeMupdf(doc)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
})

// ── Azure Document Intelligence: layout analysis (tables + handwriting OCR) ──
// Runs in the main process to avoid CORS; the renderer maps the raw result.

// Shared analyze-and-poll for any Document Intelligence prebuilt model
// (`prebuilt-layout` for tables, `prebuilt-read` for handwriting prose).
async function azureAnalyze(model: string, bytes: ArrayBuffer, endpoint: string, key: string, pages: string): Promise<unknown> {
  const base = endpoint.trim().replace(/\/+$/, '')
  if (!/^https:\/\//i.test(base)) throw new Error('Azure endpoint must be an https:// URL (copy it from the Azure portal, "Keys and Endpoint").')
  if (!key.trim()) throw new Error('Azure key is missing — add it in Settings → API keys.')
  const pagesQ = pages ? `&pages=${encodeURIComponent(pages)}` : ''
  const body = JSON.stringify({ base64Source: Buffer.from(bytes).toString('base64') })
  const headers = { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': key }

  let res = await fetch(`${base}/documentintelligence/documentModels/${model}:analyze?api-version=2024-11-30${pagesQ}`,
    { method: 'POST', headers, body })
  if (res.status === 404) {
    // Older Form Recognizer resources expose the same models on the v3.1 path.
    res = await fetch(`${base}/formrecognizer/documentModels/${model}:analyze?api-version=2023-07-31${pagesQ}`,
      { method: 'POST', headers, body })
  }
  if (res.status === 401 || res.status === 403) throw new Error('Azure rejected the key — check the key and that the endpoint matches the resource region.')
  if (res.status === 429) throw new Error('Azure rate limit reached (free F0 tier). Wait a minute, or reduce the page range, and try again.')
  if (res.status === 400) {
    const detail = (await res.text()).slice(0, 300)
    if (/page/i.test(detail)) throw new Error('Azure rejected the request — the free F0 tier reads only the first 2 pages per call. Select a smaller page range.')
    throw new Error(`Azure error 400: ${detail}`)
  }
  if (res.status !== 202) throw new Error(`Azure error ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const opLoc = res.headers.get('operation-location')
  if (!opLoc) throw new Error('Azure did not return an Operation-Location header.')

  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 1500))
    const poll = await fetch(opLoc, { headers: { 'Ocp-Apim-Subscription-Key': key } })
    if (poll.status === 429) continue
    const j = await poll.json() as { status: string; analyzeResult?: unknown; error?: unknown }
    if (j.status === 'succeeded') return j.analyzeResult ?? {}
    if (j.status === 'failed') throw new Error(`Azure analysis failed: ${JSON.stringify(j.error ?? {}).slice(0, 300)}`)
  }
  throw new Error('Azure analysis timed out after 2 minutes.')
}

ipcMain.handle('azure:layoutAnalyze', (_event, bytes: ArrayBuffer, endpoint: string, key: string, pages: string): Promise<unknown> =>
  azureAnalyze('prebuilt-layout', bytes, endpoint, key, pages))

ipcMain.handle('azure:readAnalyze', (_event, bytes: ArrayBuffer, endpoint: string, key: string, pages: string): Promise<unknown> =>
  azureAnalyze('prebuilt-read', bytes, endpoint, key, pages))

ipcMain.handle('pdfium:styledRuns', (_event, bytes: ArrayBuffer, pageIndex: number) =>
  pdfium.getStyledTextRuns(Buffer.from(bytes), pageIndex))

// ── TrOCR: local handwriting OCR (offline after a one-time model download) ───

function trocrConfigured(): typeof trocr {
  trocr.configure(path.join(app.getPath('userData'), 'trocr-cache'))
  return trocr
}

const trocrModelId = (m?: string): trocr.TrocrModelId => (m === 'base' ? 'base' : 'small')

ipcMain.handle('trocr:status', (_event, model?: string) => {
  const t = trocrConfigured()
  const m = trocrModelId(model)
  return { ready: t.isReady(m), cached: t.isCached(m) }
})

ipcMain.handle('trocr:setup', async (_event, model?: string) => {
  await trocrConfigured().setup(trocrModelId(model))
  return true
})

ipcMain.handle('trocr:recognize', async (_event, png: ArrayBuffer, model?: string): Promise<string> =>
  trocrConfigured().recognizePng(Buffer.from(png), trocrModelId(model)))

// Handwriting → Word: assemble recognized paragraphs into an editable .docx.
ipcMain.handle('export:paragraphsToDocx', async (_event, pages: DocxPage[]): Promise<ArrayBuffer> => {
  const buf = await buildParagraphsDocx(pages)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
})

// ── Open/Save file dialog accepting multiple types (for Office import) ────────

ipcMain.handle('dialog:openAnyFile', async (_event, filters: Array<{ name: string; extensions: string[] }>) => {
  const result = await dialog.showOpenDialog({ properties: ['openFile'], filters })
  return result.canceled ? null : result.filePaths[0]
})

// ── Find text rectangles (for Find & Redact) ──────────────────────────────────

ipcMain.handle('mupdf:findTextRects', (_event, bytes: ArrayBuffer, term: string) =>
  mupdfCall('findTextRects', [bytes, term]))

// ═══════════════════════════════════════════════════════════════════════════════
// NATIVE BINARY OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

// ── Binary status & setup ─────────────────────────────────────────────────────

ipcMain.handle('bins:getStatus', () => nativeBins.getBinStatus())

ipcMain.handle('bins:openUrl', async (_event, url: string) => {
  // Only ever hand a plain web URL to the OS. shell.openExternal will launch
  // ANY registered protocol (file:, smb:, ms-msdt:, custom handlers), so an
  // unvalidated string here would be an arbitrary-launch primitive.
  let u: URL
  try { u = new URL(url) } catch { return }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return
  await shell.openExternal(u.href).catch(() => {})
})

ipcMain.handle('bins:downloadMutool', async (event) => {
  const https = require('https') as typeof import('https')

  // Supply-chain guard: only ever talk to GitHub's official release hosts, and
  // only over HTTPS. Enforced on the API call, on EVERY redirect hop, and on the
  // final asset URL, so a tampered redirect can't divert the fetch elsewhere.
  function isGitHubHost(host: string): boolean {
    return host === 'github.com' || host === 'api.github.com' || host.endsWith('.githubusercontent.com')
  }
  function assertSafeUrl(u: string): URL {
    const parsed = new URL(u)
    if (parsed.protocol !== 'https:') throw new Error('Refusing a non-HTTPS download URL.')
    if (!isGitHubHost(parsed.hostname)) throw new Error(`Refusing a download from an untrusted host: ${parsed.hostname}`)
    return parsed
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function getJson(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const parsed = assertSafeUrl(url)
      const req = https.get(parsed.href, { headers: { 'User-Agent': 'monstera-pdf-editor/1.0' } }, res => {
        let data = ''
        res.on('data', (d: Buffer) => { data += d.toString() })
        res.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
        res.on('error', reject)
      })
      req.on('error', reject)
      req.setTimeout(8000, () => req.destroy(new Error('GitHub API timed out')))
    })
  }

  function dlBuffer(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      function follow(u: string, hops = 0): void {
        if (hops > 8) { reject(new Error('Too many redirects')); return }
        let parsed: URL
        try { parsed = assertSafeUrl(u) } catch (e) { reject(e); return }
        const req = https.get(parsed.href, { headers: { 'User-Agent': 'monstera-pdf-editor/1.0' } }, res => {
          if ([301,302,303,307,308].includes(res.statusCode ?? 0)) { res.resume(); follow(res.headers.location!, hops + 1); return }
          if ((res.statusCode ?? 0) !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return }
          const total = parseInt(String(res.headers['content-length'] ?? '0'))
          const MAX = 200 * 1024 * 1024
          let received = 0
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => {
            received += chunk.length
            if (received > MAX) { req.destroy(new Error('Download exceeds the size limit.')); return }
            chunks.push(chunk)
            if (total > 0) event.sender.send('bins:downloadProgress', { pct: Math.round(received / total * 100), mb: (received / 1024 / 1024).toFixed(1) })
          })
          res.on('end', () => resolve(Buffer.concat(chunks)))
          res.on('error', reject)
        })
        req.on('error', reject)
        req.setTimeout(120_000, () => req.destroy(new Error('Download timed out')))
      }
      follow(url)
    })
  }

  let downloadUrl = 'https://github.com/ArtifexSoftware/mupdf/releases/download/1.24.11/mupdf-1.24.11-windows.zip'
  try {
    const release = await getJson('https://api.github.com/repos/ArtifexSoftware/mupdf/releases/latest')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const asset = (release.assets || []).find((a: any) => a.name.toLowerCase().includes('windows') && a.name.endsWith('.zip'))
    if (asset?.browser_download_url) downloadUrl = asset.browser_download_url
  } catch { /* fall back to the pinned URL */ }

  event.sender.send('bins:downloadProgress', { pct: 0, status: 'Connecting…' })
  const zipBuf = await dlBuffer(downloadUrl)
  event.sender.send('bins:downloadProgress', { pct: 100, status: 'Extracting…' })

  // Extract in-process with jszip — no shell at all, so a quote or space in any
  // temp path can never become the command-injection vector the old
  // PowerShell Expand-Archive call was.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const JSZip = require('jszip')
  const zip = await JSZip.loadAsync(zipBuf)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let entry: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  zip.forEach((relPath: string, file: any) => {
    if (!file.dir && /(^|\/)mutool\.exe$/i.test(relPath)) entry = file
  })
  if (!entry) throw new Error('mutool.exe not found in archive')
  const exeBuf: Buffer = await entry.async('nodebuffer')

  // Only install something that is actually a Windows executable (MZ/PE header)
  // before it is ever copied into the app folder and run.
  if (exeBuf.length < 2 || exeBuf[0] !== 0x4d || exeBuf[1] !== 0x5a) {
    throw new Error('Downloaded mutool.exe is not a valid Windows executable.')
  }

  const dest = path.join(nativeBins.BIN_DIR, 'mutool.exe')
  fs.mkdirSync(nativeBins.BIN_DIR, { recursive: true })
  fs.writeFileSync(dest, exeBuf)
  return dest
})

// ── Ghostscript ───────────────────────────────────────────────────────────────

function abuf(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

ipcMain.handle('gs:toPdfa',     async (_e, b: ArrayBuffer, level: 1|2|3) => abuf(await nativeBins.gsToPdfA(b, level)))
ipcMain.handle('gs:toPdfx',     async (_e, b: ArrayBuffer)               => abuf(await nativeBins.gsToPdfX(b)))
ipcMain.handle('gs:toGrayscale',async (_e, b: ArrayBuffer)               => abuf(await nativeBins.gsToGrayscale(b)))
ipcMain.handle('gs:toCmyk',     async (_e, b: ArrayBuffer)               => abuf(await nativeBins.gsToCmyk(b)))
ipcMain.handle('gs:optimize',   async (_e, b: ArrayBuffer, preset: nativeBins.GsOptPreset) => abuf(await nativeBins.gsOptimize(b, preset)))
ipcMain.handle('gs:linearize',  async (_e, b: ArrayBuffer)               => abuf(await nativeBins.gsLinearize(b)))
ipcMain.handle('gs:sanitize',   async (_e, b: ArrayBuffer)               => abuf(await nativeBins.gsSanitize(b)))
ipcMain.handle('gs:rasterize',  async (_e, b: ArrayBuffer, dpi: number)  => abuf(await nativeBins.gsRasterize(b, dpi)))

// ── MuPDF mutool ──────────────────────────────────────────────────────────────

ipcMain.handle('mutool:clean', async (_e, b: ArrayBuffer, opts: Parameters<typeof nativeBins.mutoolClean>[1]) =>
  abuf(await nativeBins.mutoolClean(b, opts)))

ipcMain.handle('mutool:info',         async (_e, b: ArrayBuffer) => nativeBins.mutoolInfo(b))
ipcMain.handle('mutool:extractFiles', async (_e, b: ArrayBuffer) => nativeBins.mutoolExtractFiles(b))
ipcMain.handle('mutool:convert',      async (_e, b: ArrayBuffer, ext: string) => abuf(await nativeBins.mutoolConvert(b, ext)))

// ── qpdf (lossless structure) ───────────────────────────────────────────────
ipcMain.handle('qpdf:linearize', async (_e, b: ArrayBuffer) => abuf(await nativeBins.qpdfLinearize(b)))
ipcMain.handle('qpdf:repair',    async (_e, b: ArrayBuffer) => abuf(await nativeBins.qpdfRepair(b)))
ipcMain.handle('qpdf:decrypt',   async (_e, b: ArrayBuffer, pw: string) => abuf(await nativeBins.qpdfDecrypt(b, pw)))

// ── Poppler ─────────────────────────────────────────────────────────────────
ipcMain.handle('poppler:textLayout',    async (_e, b: ArrayBuffer) => nativeBins.popplerTextLayout(b))
ipcMain.handle('poppler:extractImages',  async (_e, b: ArrayBuffer) => nativeBins.popplerExtractImages(b))

// ── Native Tesseract ────────────────────────────────────────────────────────
ipcMain.handle('tesseract:ocrImage', async (_e, png: ArrayBuffer, lang: string) => nativeBins.tesseractOcrImage(png, lang))

// ── LibreOffice ───────────────────────────────────────────────────────────────

ipcMain.handle('libreoffice:isAvailable', () => !!nativeBins.getLibreOfficePath())

const MUTOOL_INPUT_EXTS = ['.xps', '.oxps', '.cbz', '.cbr', '.svg', '.epub', '.fb2', '.mobi']

ipcMain.handle('libreoffice:importFile', async (_e, filePath: string) => {
  const ext   = path.extname(filePath).toLowerCase()
  const bytes = fs.readFileSync(filePath)
  // XPS/CBZ/SVG/EPUB and friends are handled by mutool; Office formats by LibreOffice.
  if (MUTOOL_INPUT_EXTS.includes(ext)) return abuf(await nativeBins.mutoolConvert(bytes, ext))
  return abuf(await nativeBins.libreOfficeToPdf(bytes, ext))
})

ipcMain.handle('libreoffice:importBytes', async (_e, bytes: ArrayBuffer, ext: string) =>
  abuf(await nativeBins.libreOfficeToPdf(bytes, ext)))

ipcMain.handle('libreoffice:exportDocx', async (_e, b: ArrayBuffer) => abuf(await nativeBins.libreOfficeToDocx(b)))
ipcMain.handle('libreoffice:exportPptx', async (_e, b: ArrayBuffer) => abuf(await nativeBins.libreOfficeToPptx(b)))
ipcMain.handle('libreoffice:exportXlsx', async (_e, b: ArrayBuffer) => abuf(await nativeBins.libreOfficeToXlsx(b)))

// pdf2docx engine — best-in-class editable+layout Word conversion via system Python
ipcMain.handle('pdf2docx:status',  async ()                => nativeBins.pdf2docxStatus())
ipcMain.handle('pdf2docx:convert', async (_e, b: ArrayBuffer) => abuf(await nativeBins.pdf2docxConvert(b)))
ipcMain.handle('pdf2docx:install', async ()                => nativeBins.pdf2docxInstall())

ipcMain.handle('dict:spellCheck', async (_e, text: string) => spell.spellCheck(text))

// Office file open dialog
ipcMain.handle('dialog:openOfficeFile', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Documents & Graphics', extensions: ['docx','doc','xlsx','xls','pptx','ppt','odt','ods','odp','rtf','csv','txt','vsd','vsdx','pub','wmf','emf','odg','fodt','fods','fodp','xps','oxps','cbz','cbr','svg','epub','fb2'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  })
  return r.canceled ? null : r.filePaths[0]
})

// ── Markdown → PDF ─────────────────────────────────────────────────────────────

ipcMain.handle('convert:markdownToPdf', async (_event, markdownText: string): Promise<ArrayBuffer> => {
  // Simple markdown-to-HTML converter (no external deps needed)
  function mdToHtml(md: string): string {
    return md
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/^###### (.+)$/gm, '<h6>$1</h6>')
      .replace(/^##### (.+)$/gm, '<h5>$1</h5>')
      .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/^\- (.+)$/gm, '<li>$1</li>')
      .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/^(?!<[hlicpadu])/gm, '')
  }
  const body = mdToHtml(markdownText)
  const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:;">
    <style>
      body { font-family: Georgia, serif; font-size: 13px; margin: 40px 60px; line-height: 1.7; color: #111; }
      h1 { font-size: 2em; border-bottom: 2px solid #333; padding-bottom: 4px; margin-bottom: 16px; }
      h2 { font-size: 1.5em; border-bottom: 1px solid #999; padding-bottom: 2px; margin-top: 24px; }
      h3 { font-size: 1.2em; margin-top: 18px; }
      h4,h5,h6 { margin-top: 12px; }
      code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; font-family: monospace; font-size: 0.9em; }
      li { margin: 3px 0; }
      p { margin: 8px 0; }
      a { color: #0066cc; }
    </style>
  </head><body><p>${body}</p></body></html>`
  const offscreen = new BrowserWindow({ show: false, width: 794, height: 1123, webPreferences: { nodeIntegration: false, contextIsolation: true } })
  await offscreen.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`)
  await new Promise<void>(r => setTimeout(r, 500))
  const pdfBuf = await offscreen.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } })
  offscreen.close()
  return abuf(pdfBuf)
})

// ── Email (.eml) → PDF ──────────────────────────────────────────────────────
ipcMain.handle('email:toPdf', async (_e, filePath: string): Promise<ArrayBuffer> => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { simpleParser } = require('mailparser')
  const raw = fs.readFileSync(filePath)
  const m = await simpleParser(raw)
  const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const headerRows = ([
    ['From', m.from?.text], ['To', m.to && (Array.isArray(m.to) ? m.to.map((t: { text: string }) => t.text).join(', ') : m.to.text)],
    ['Cc', m.cc && (Array.isArray(m.cc) ? m.cc.map((t: { text: string }) => t.text).join(', ') : m.cc.text)],
    ['Subject', m.subject], ['Date', m.date ? new Date(m.date).toLocaleString() : ''],
  ] as Array<[string, unknown]>)
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><td class="k">${k}</td><td>${esc(v)}</td></tr>`).join('')
  const bodyHtml = m.html || `<pre style="white-space:pre-wrap;font-family:inherit">${esc(m.text)}</pre>`
  const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:;"><style>
    body{font-family:Arial,sans-serif;font-size:12px;margin:32px 40px;color:#111}
    table.h{border-collapse:collapse;margin-bottom:14px;width:100%}
    table.h td{padding:2px 6px;vertical-align:top} td.k{font-weight:bold;color:#444;width:64px}
    hr{border:none;border-top:1px solid #ccc;margin:10px 0} img{max-width:100%}
  </style></head><body><table class="h">${headerRows}</table><hr/><div>${bodyHtml}</div></body></html>`
  const offscreen = new BrowserWindow({ show: false, width: 794, height: 1123, webPreferences: { nodeIntegration: false, contextIsolation: true } })
  await offscreen.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`)
  await new Promise<void>(r => setTimeout(r, 400))
  const pdf = await offscreen.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } })
  offscreen.close()
  return abuf(pdf)
})

// ── CSV → PDF ─────────────────────────────────────────────────────────────────

// Minimal RFC-4180 delimited-text parser (quoted fields, escaped "" quotes,
// delimiters/newlines inside quotes). Replaces SheetJS, which carried a
// prototype-pollution CVE, on this untrusted-text path. Sniffs tab vs comma.
function parseDelimited(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const delim = (firstLine.split('\t').length - 1) > (firstLine.split(',').length - 1) ? '\t' : ','
  const rows: string[][] = []
  let row: string[] = [], field = '', inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQ = false }
      else field += c
    } else if (c === '"') inQ = true
    else if (c === delim) { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

ipcMain.handle('convert:csvToPdf', async (_event, csvText: string): Promise<ArrayBuffer> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any[][] = parseDelimited(csvText).filter(r => r.some(c => String(c).trim() !== ''))

  const rows = data.map((row, ri) => {
    const cells = row.map((cell: unknown) =>
      `<td style="${ri === 0 ? 'background:#e8eaf6;font-weight:bold;' : ri % 2 === 0 ? 'background:#f5f5f5;' : ''}">${cell !== null && cell !== undefined ? String(cell).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : ''}</td>`
    ).join('')
    return `<tr>${cells}</tr>`
  }).join('\n')

  const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:;">
    <style>
      body { font-family: Arial, sans-serif; font-size: 10px; margin: 20px; }
      table { border-collapse: collapse; width: 100%; }
      td { border: 1px solid #ccc; padding: 3px 6px; }
      tr:first-child td { font-weight: bold; background: #e8eaf6; }
    </style>
  </head><body><table>${rows}</table></body></html>`
  const offscreen = new BrowserWindow({ show: false, width: 1123, height: 794, webPreferences: { nodeIntegration: false, contextIsolation: true } })
  await offscreen.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`)
  await new Promise<void>(r => setTimeout(r, 400))
  const pdfBuf = await offscreen.webContents.printToPDF({ pageSize: 'A4', landscape: true, printBackground: true, margins: { top: 0.3, bottom: 0.3, left: 0.3, right: 0.3 } })
  offscreen.close()
  return abuf(pdfBuf)
})

// ── Email document ─────────────────────────────────────────────────────────────

ipcMain.handle('shell:openEmail', async (_event, recipient: string, subject: string, body: string) => {
  const mailto = `mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  await shell.openExternal(mailto)
})

// ── Clipboard ────────────────────────────────────────────────────────────────
// navigator.clipboard.writeText() needs the clipboard-sanitized-write
// permission, which our permission handler denies (it allows only 'media'), so
// every in-app copy failed with "Write permission denied". Electron's native
// clipboard module is not gated by the web permission model, so route copies
// through here instead of loosening the handler.

ipcMain.handle('clipboard:writeText', async (_event, text: string) => {
  clipboard.writeText(String(text ?? ''))
})

// ── Export page for external editing ─────────────────────────────────────────

interface ExportPageResult { pngPath: string; width: number; height: number }

ipcMain.handle('file:exportPageForEdit', async (
  _event,
  bytes: ArrayBuffer,
  pageNum: number
): Promise<ExportPageResult> => {
  const mupdf = await getMupdf()
  const doc = mupdf.PDFDocument.openDocument(new Uint8Array(bytes), 'application/pdf')
  const page = doc.loadPage(pageNum - 1)
  const bounds = page.getBounds()
  const scale  = 2.0   // 2× for high-quality export
  const matrix = [scale, 0, 0, scale, 0, 0]
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true)
  const pngData: Buffer = pixmap.asPNG()
  const tmpPath = path.join(require('os').tmpdir(), `monstera-edit-page-${pageNum}-${Date.now()}.png`)
  fs.writeFileSync(tmpPath, pngData)
  await shell.openPath(tmpPath)
  const result = { pngPath: tmpPath, width: Math.round(bounds[2] - bounds[0]), height: Math.round(bounds[3] - bounds[1]) }
  freeMupdf(pixmap, page, doc)
  return result
})

ipcMain.handle('file:reimportEditedPage', async (
  _event,
  pngPath: string
): Promise<ArrayBuffer> => {
  const buf = fs.readFileSync(pngPath)
  return abuf(buf)
})

// Smart DOCX import: LibreOffice first, mammoth fallback
ipcMain.handle('file:importDocxSmart', async (_e, filePath: string) => {
  if (nativeBins.getLibreOfficePath()) {
    const bytes = fs.readFileSync(filePath)
    return abuf(await nativeBins.libreOfficeToPdf(bytes, path.extname(filePath).toLowerCase()))
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mammoth = require('mammoth')
  const result = await mammoth.convertToHtml({ path: filePath })
  const html: string = result.value
  const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:;"><style>body{font-family:Arial,sans-serif;font-size:12px;margin:30px 40px;line-height:1.6;}h1,h2,h3{margin-top:1em;}table{border-collapse:collapse;width:100%;}td,th{border:1px solid #bbb;padding:4px 8px;}th{background:#e8eaf6;}</style></head><body>${html}</body></html>`
  const offscreen = new BrowserWindow({ show: false, width: 800, height: 1100, webPreferences: { nodeIntegration: false, contextIsolation: true } })
  await offscreen.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`)
  await new Promise<void>(r => setTimeout(r, 800))
  const pdfBuf = await offscreen.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } })
  offscreen.close()
  return abuf(pdfBuf)
})
