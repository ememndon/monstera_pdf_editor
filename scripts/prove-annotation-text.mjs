// Headless proof that every text-bearing annotation actually saves its text.
//
// The bug: pdf-lib wrote bare annotation dicts for FreeText (typewriter, text
// box, callout) and for stamps. Two things were wrong at once:
//   * /C on a FreeText is the BACKGROUND colour, not the text colour, so passing
//     the user's text colour painted a solid filled rectangle over the page.
//   * the /DA font name resolves only via the AcroForm /DR resources, which were
//     never written, so the text could not be laid out and was dropped.
//   * writeStamp() mapped only five names, so Today/Received/Revised/Void/any
//     custom label fell back to /Draft and the viewer drew its DRAFT artwork.
// Saving produced coloured boxes with no text, and every unmapped stamp read
// "DRAFT". Building the /AP ourselves fixes all of it, and MuPDF's synthesis
// pass skips annotations that already carry an appearance.
//
// Checks, per annotation: the /AP normal appearance exists, its content stream
// draws the exact expected string, and (for FreeText) it paints no background
// fill. Then the page is rendered and each region is checked for real ink at a
// density well below a solid block.

import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'
import { PDFDocument, PDFName, PDFArray } from 'pdf-lib'

const ROOT = process.cwd()
let failures = 0
const ok = (cond, label) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} - ${label}`)
  if (!cond) failures++
}

const tmp = mkdtempSync(join(tmpdir(), 'monstera-anntext-'))
const entryPath = join(tmp, 'entry.ts')
const bundlePath = join(tmp, 'bundle.mjs')
const modPath = join(ROOT, 'src/renderer/utils/annotationPdfLib').replace(/\\/g, '/')
writeFileSync(entryPath, `export { writeAnnotationsToPdf, readAnnotationsFromPdf } from '${modPath}'\n`)
const esbuild = await import('esbuild')
esbuild.buildSync({
  entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node',
  absWorkingDir: ROOT, outfile: bundlePath,
})
const { writeAnnotationsToPdf, readAnnotationsFromPdf } = await import(pathToFileURL(bundlePath).href)
const ops = await import(pathToFileURL(join(ROOT, 'dist-electron/main/mupdfOps.js')).href)

// ── a blank white page ───────────────────────────────────────────────────────
const base = await PDFDocument.create()
base.addPage([612, 792])
const baseBytes = await base.save()

const common = { pageNum: 1, createdAt: Date.now(), opacity: 1 }
const annotations = [
  { ...common, id: 'tw', type: 'typewriter', x: 60, y: 700, text: 'TYPEWRITERPROBE', fontSize: 14, color: '#000000', font: 'Helvetica' },
  { ...common, id: 'tb', type: 'textbox', x: 60, y: 400, width: 300, height: 40, text: 'TEXTBOXPROBE', fontSize: 14, color: '#000000', font: 'Helvetica', lineWidth: 1 },
  { ...common, id: 'co', type: 'callout', x: 60, y: 300, width: 200, height: 40, tipX: 40, tipY: 280, text: 'CALLOUTPROBE', fontSize: 12, color: '#c00000', font: 'Helvetica', lineWidth: 1 },
  { ...common, id: 's1', type: 'stamp', x: 150, y: 600, width: 120, height: 40, stampName: 'Approved', color: '#008000' },
  { ...common, id: 's2', type: 'stamp', x: 400, y: 600, width: 120, height: 40, stampName: 'Rejected', color: '#ff0000' },
  { ...common, id: 's3', type: 'stamp', x: 150, y: 500, width: 120, height: 40, stampName: 'Today',    color: '#0000ff' },
  { ...common, id: 's4', type: 'stamp', x: 400, y: 500, width: 120, height: 40, stampName: 'Void',     color: '#ff00ff' },
]

const written = await writeAnnotationsToPdf(baseBytes, annotations)
// The real save runs MuPDF appearance synthesis afterwards; prove our /AP survives it.
const final = new Uint8Array(await ops.synthesizeAppearances(written.slice().buffer))
writeFileSync(join(tmp, 'out.pdf'), final)

// ── structural: each annotation's /AP draws the expected text ────────────────
const doc = await PDFDocument.load(final)
const page = doc.getPage(0)
const annots = page.node.lookup(PDFName.of('Annots'), PDFArray)

const apTextByNM = new Map()
if (annots) {
  for (const ref of annots.asArray()) {
    const d = doc.context.lookup(ref)
    if (!d?.get) continue
    const nm = d.get(PDFName.of('NM'))?.decodeText?.() ?? String(d.get(PDFName.of('NM')) ?? '')
    const ap = d.get(PDFName.of('AP'))
    const apd = doc.context.lookup(ap)
    const n = apd?.get?.(PDFName.of('N'))
    const stream = doc.context.lookup(n)
    if (!stream?.getContents) { apTextByNM.set(nm, null); continue }
    const raw = Buffer.from(stream.getContents())
    const filter = String(stream.dict?.get(PDFName.of('Filter')) ?? '')
    let body
    try { body = (/Flate/.test(filter) ? inflateSync(raw) : raw).toString('latin1') }
    catch { body = raw.toString('latin1') }
    apTextByNM.set(nm, body)
  }
}

const expect = [
  ['monstera-tw', 'TYPEWRITERPROBE', 'typewriter'],
  ['monstera-tb', 'TEXTBOXPROBE',    'text box'],
  ['monstera-co', 'CALLOUTPROBE',    'callout'],
  ['monstera-s1', 'APPROVED',        'stamp Approved'],
  ['monstera-s2', 'REJECTED',        'stamp Rejected'],
  ['monstera-s3', 'TODAY',           'stamp Today'],
  ['monstera-s4', 'VOID',            'stamp Void'],
]

console.log('\n=== appearance streams draw the real text ===')
for (const [nm, want, label] of expect) {
  const body = apTextByNM.get(nm)
  ok(!!body, `${label}: has a normal appearance stream`)
  ok(!!body && body.includes(`(${want}) Tj`), `${label}: draws "${want}"`)
}

console.log('\n=== no stamp falls back to the built-in DRAFT artwork ===')
for (const [nm, , label] of expect.filter(e => e[0].startsWith('monstera-s'))) {
  const body = apTextByNM.get(nm) ?? ''
  ok(!body.includes('(DRAFT) Tj') || nm === 'monstera-sDraft', `${label}: not rendered as DRAFT`)
}
// a /Name would let a viewer substitute its own artwork for ours
let namedStamps = 0
if (annots) {
  for (const ref of annots.asArray()) {
    const d = doc.context.lookup(ref)
    if (d?.get?.(PDFName.of('Subtype'))?.toString() === '/Stamp'
      && d.get(PDFName.of('Name'))) namedStamps++
  }
}
ok(namedStamps === 0, `no stamp relies on a /Name the viewer could reinterpret (found ${namedStamps})`)

console.log('\n=== FreeText paints no background box ===')
for (const nm of ['monstera-tw', 'monstera-tb']) {
  const d = annots?.asArray().map(r => doc.context.lookup(r))
    .find(x => (x?.get?.(PDFName.of('NM'))?.decodeText?.() ?? '') === nm)
  ok(!d?.get(PDFName.of('C')), `${nm}: no /C, so nothing fills the box with the text colour`)
  const body = apTextByNM.get(nm) ?? ''
  ok(!/\bre\s*\n?f\b/.test(body), `${nm}: appearance contains no filled rectangle`)
}

// ── visual: real ink, and nowhere near a solid block ─────────────────────────
const mupdf = await import('mupdf')
const mdoc = mupdf.PDFDocument.openDocument(final, 'application/pdf')
const mpage = mdoc.loadPage(0)
const S = 2
const pix = mpage.toPixmap(mupdf.Matrix.scale(S, S), mupdf.ColorSpace.DeviceRGB, false, true)
const W = pix.getWidth(), H = pix.getHeight(), px = pix.getPixels()
const nchan = px.length / (W * H)
const density = (x0, y0, x1, y1) => {
  let ink = 0, total = 0
  const a = Math.max(0, Math.floor(x0 * S)), b = Math.min(W, Math.ceil(x1 * S))
  const c = Math.max(0, Math.floor((792 - y1) * S)), d = Math.min(H, Math.ceil((792 - y0) * S))
  for (let y = c; y < d; y++) for (let x = a; x < b; x++) {
    const o = (y * W + x) * nchan
    total++
    if (px[o] < 240 || px[o + 1] < 240 || px[o + 2] < 240) ink++
  }
  return total ? ink / total : 0
}

console.log('\n=== rendered page: text present, not a filled block ===')
const regions = [
  ['typewriter', 55, 695, 300, 730],
  ['text box',   55, 395, 365, 445],
]
for (const [label, x0, y0, x1, y1] of regions) {
  const dns = density(x0, y0, x1, y1)
  ok(dns > 0.005, `${label}: ink is present (${(dns * 100).toFixed(1)}%)`)
  ok(dns < 0.40, `${label}: not a solid filled box (${(dns * 100).toFixed(1)}%)`)
}

// ── round trip: reopen the saved file the way the app does ───────────────────
// Writing correctly is only half the job. The app reloads annotations through
// PDF.js, and PDF.js v6 exposes the text as contentsObj.str, not contents.
// Reading the stale property returned undefined, so every reopened typewriter,
// text box and sticky note came back EMPTY, and every stamp came back as
// 'Draft'. That is what the user still saw after the writer was fixed.
console.log('\n=== round trip: reopen and read back ===')
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
const rtDoc = await pdfjs.getDocument({ data: new Uint8Array(final), useSystemFonts: false }).promise
const readBack = await readAnnotationsFromPdf(rtDoc, 1)
const allTextOf = r => r.text ?? ''
const allText = readBack.map(allTextOf).join('|')
const stampNames = readBack.filter(r => r.type === 'stamp').map(r => r.stampName)

ok(readBack.length >= 7, `all annotations read back (got ${readBack.length})`)
for (const want of ['TYPEWRITERPROBE', 'TEXTBOXPROBE', 'CALLOUTPROBE']) {
  ok(allText.includes(want), `"${want}" survives the round trip`)
}
for (const want of ['Approved', 'Rejected', 'Today', 'Void']) {
  ok(stampNames.includes(want), `stamp "${want}" reloads with its own name`)
}
ok(!stampNames.includes('Draft'), `no stamp reloads as Draft (got ${stampNames.join(', ') || 'none'})`)

// PDF.js returns colours as a Uint8ClampedArray indexed [0][1][2], not {r,g,b}.
// Reading .r/.g/.b yielded "#NaNNaNNaN", an invalid colour, so the stamp border
// disappeared and its text fell back to black on reopen.
const colorOf = name => readBack.find(r => r.type === 'stamp' && r.stampName === name)?.color
for (const [name, want] of [['Approved', '#008000'], ['Rejected', '#ff0000'], ['Today', '#0000ff'], ['Void', '#ff00ff']]) {
  const got = colorOf(name)
  ok(got === want, `stamp "${name}" keeps its colour (want ${want}, got ${got})`)
}
ok(readBack.every(r => !String(r.color).includes('NaN')),
  'no annotation reloads with an invalid colour')
const twColor = readBack.find(r => allTextOf(r) === 'TYPEWRITERPROBE')?.color
ok(twColor === '#000000', `typewriter keeps its text colour (want #000000, got ${twColor})`)

console.log('\n=== RESULT ===')
if (failures) { console.log(`  FAIL - ${failures} check(s) failed.`); process.exit(1) }
console.log('  PASS - every text annotation saves its text; no DRAFT fallback; no background boxes.')
