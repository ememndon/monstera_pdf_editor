// Headless proof that image-bearing stamps (drawn/uploaded signatures, custom
// image stamps) survive a save.
//
// The bug: writeStamp() wrote a /Stamp annotation carrying only a /Name and
// silently dropped StampAnn.imageDataUrl. A name-only stamp has no artwork of
// its own, so the viewer (or MuPDF's appearance synthesis) painted its built-in
// stamp for that name instead. A saved signature reopened as a big "DRAFT".
//
// Case A: a Custom stamp WITH an image
//   - the exact image is embedded as an XObject (unique 37x11 dimensions)
//   - it is drawn into the page content stream at the right place
//     (StampAnn x/y is the CENTRE, so the draw origin must be x-w/2, y-h/2)
//   - NO /Stamp annotation is emitted for it, or the viewer would draw
//     its own artwork over the picture
// Case B: a plain named stamp (no image) still writes its /Stamp annotation,
//   so the fix does not regress ordinary stamps.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'
import { PDFDocument, PDFName, PDFDict, PDFArray, StandardFonts } from 'pdf-lib'

const ROOT = process.cwd()
let failures = 0
const ok = (cond, label) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} - ${label}`)
  if (!cond) failures++
}

// ── Bundle the renderer module under test ────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'monstera-stamp-'))
const entryPath = join(tmp, 'entry.ts')
const bundlePath = join(tmp, 'bundle.mjs')
const modPath = join(ROOT, 'src/renderer/utils/annotationPdfLib').replace(/\\/g, '/')
writeFileSync(entryPath, `export { writeAnnotationsToPdf } from '${modPath}'\n`)
const esbuild = await import('esbuild')
esbuild.buildSync({
  entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node',
  absWorkingDir: ROOT, outfile: bundlePath,
})
const { writeAnnotationsToPdf } = await import(pathToFileURL(bundlePath).href)

// ── Minimal RGB PNG encoder, so the test image has unique known dimensions ───
const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
const crc32 = buf => {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function makePng(width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3
      raw[p] = 20; raw[p + 1] = 90; raw[p + 2] = 200   // ink blue
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

const SIG_W = 37, SIG_H = 11          // deliberately odd, so a match is unambiguous
const sigDataUrl = 'data:image/png;base64,' + makePng(SIG_W, SIG_H).toString('base64')

// ── Base document ────────────────────────────────────────────────────────────
const base = await PDFDocument.create()
const page = base.addPage([612, 792])
const font = await base.embedFont(StandardFonts.Helvetica)
page.drawText('Signature save round trip', { x: 60, y: 720, size: 14, font })
const baseBytes = await base.save()

// ── Annotations: one image stamp (signature), one plain named stamp ──────────
const CX = 300, CY = 200, SW = 120, SH = 40
const annotations = [
  {
    id: 'sig-1', type: 'stamp', pageNum: 1, createdAt: Date.now(),
    color: '#000000', opacity: 1,
    x: CX, y: CY, width: SW, height: SH,
    stampName: 'Custom', imageDataUrl: sigDataUrl,
  },
  {
    id: 'plain-1', type: 'stamp', pageNum: 1, createdAt: Date.now(),
    color: '#ff0000', opacity: 1,
    x: 300, y: 500, width: 120, height: 40,
    stampName: 'Approved',
  },
]

const outBytes = await writeAnnotationsToPdf(baseBytes, annotations)
writeFileSync(join(tmp, 'out.pdf'), outBytes)

// ── Inspect the result ───────────────────────────────────────────────────────
const out = await PDFDocument.load(outBytes)
const outPage = out.getPage(0)

console.log('\n=== Case A: image stamp (signature) ===')

// 1. the image is embedded, at the exact dimensions we supplied
const xobjs = outPage.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict)
let found = null
if (xobjs) {
  for (const [, ref] of xobjs.entries()) {
    const st = out.context.lookup(ref)
    const d = st?.dict ?? st
    if (!d?.get) continue
    if (d.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue
    const w = d.get(PDFName.of('Width'))?.asNumber?.()
    const h = d.get(PDFName.of('Height'))?.asNumber?.()
    if (w === SIG_W && h === SIG_H) found = { w, h }
  }
}
ok(!!found, `signature image embedded as an XObject at ${SIG_W}x${SIG_H}`)

// 2. it is actually painted, at the centre-corrected origin.
// Content streams are Flate-compressed, and pdf-lib emits the translate and the
// scale as two separate cm operators rather than one combined matrix.
const contentsRef = outPage.node.get(PDFName.of('Contents'))
const resolved = out.context.lookup(contentsRef)
const streams = resolved instanceof PDFArray
  ? resolved.asArray().map(r => out.context.lookup(r))
  : [resolved]
const text = streams
  .filter(Boolean)
  .map(s => {
    const raw = Buffer.from(s.getContents())
    const filter = String(s.dict?.get(PDFName.of('Filter')) ?? '')
    try { return (/Flate/.test(filter) ? inflateSync(raw) : raw).toString('latin1') }
    catch { return raw.toString('latin1') }
  })
  .join('\n')

const expX = CX - SW / 2, expY = CY - SH / 2
const num = n => `${n}(?:\\.0+)?`
const translateRe = new RegExp(`1\\s+0\\s+0\\s+1\\s+${num(expX)}\\s+${num(expY)}\\s+cm`)
const scaleRe = new RegExp(`${num(SW)}\\s+0\\s+0\\s+${num(SH)}\\s+0\\s+0\\s+cm`)
ok(translateRe.test(text), `translated to the centre-corrected origin (${expX}, ${expY})`)
ok(scaleRe.test(text), `scaled to the stamp size ${SW}x${SH}`)
ok(/\/Image[-\w]*\s+Do/.test(text), 'content stream invokes the image (Do operator)')

// 3. no name-based Stamp annotation for it, which is what produced "DRAFT"
const annots = outPage.node.lookup(PDFName.of('Annots'), PDFArray)
const stampNames = []
if (annots) {
  for (const ref of annots.asArray()) {
    const d = out.context.lookup(ref)
    if (d?.get?.(PDFName.of('Subtype'))?.toString() === '/Stamp') {
      stampNames.push(d.get(PDFName.of('Name'))?.toString() ?? '(none)')
    }
  }
}
ok(!stampNames.includes('/Draft'), 'no /Draft stamp annotation emitted')
ok(!stampNames.includes('/NotApproved'), 'no /NotApproved stamp annotation emitted for the Custom image stamp')

console.log('\n=== Case B: plain named stamp still works ===')
ok(stampNames.length === 1, `exactly one stamp annotation remains (found ${stampNames.length}: ${stampNames.join(', ')})`)
// The label is drawn by our own /AP now. Deliberately NO /Name: leaving one lets
// the viewer substitute its built-in artwork, which is what turned every
// unmapped stamp into "DRAFT". prove-annotation-text.mjs asserts the label text.
ok(stampNames[0] === '(none)', 'the remaining stamp carries no /Name for a viewer to reinterpret')

console.log('\n=== RESULT ===')
if (failures) { console.log(`  FAIL - ${failures} check(s) failed.`); process.exit(1) }
console.log('  PASS - image stamps are baked into the page; named stamps unaffected.')
