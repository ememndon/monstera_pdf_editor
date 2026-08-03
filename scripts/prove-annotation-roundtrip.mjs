// Full round-trip audit: write one of EVERY annotation type, reopen the bytes
// through PDF.js exactly as the app does, and assert each one comes back intact.
//
// This exists because the read-back path silently destroyed data in several
// ways at once, and each was only found when a user hit it:
//   * PDF.js returns quadPoints / vertices / ink paths as Float32Array, and
//     Array.isArray() is FALSE for a typed array. Every guard written that way
//     discarded the data, so highlights, underlines, strikethroughs, polygons,
//     polylines and clouds vanished on reopen.
//   * ink lists are flat [x,y,x,y] runs, not {x,y} objects, so mapping p.x/p.y
//     produced undefined coordinates.
//   * PDF.js exposes /CA for only a couple of subtypes, so everything else
//     reloaded at a hardcoded 0.7 opacity.
//   * /IT, /BE and /CL are not exposed at all, so a typewriter and a callout
//     both reloaded as a plain text box, a cloud as a polygon, and a
//     measurement as a plain line.
//   * annotation text moved from `contents` to `contentsObj.str`, and colours
//     come back as a Uint8ClampedArray, not {r,g,b}.
//
// Anything PDF.js cannot give back is carried in a compact JSON sidecar in /T.

import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PDFDocument } from 'pdf-lib'

const ROOT = process.cwd()
let failures = 0
const ok = (cond, label) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} - ${label}`)
  if (!cond) failures++
}
const near = (a, b, tol = 0.75) => typeof a === 'number' && Math.abs(a - b) <= tol

const tmp = mkdtempSync(join(tmpdir(), 'monstera-rt-'))
const entryPath = join(tmp, 'entry.ts'), bundlePath = join(tmp, 'bundle.mjs')
const modPath = join(ROOT, 'src/renderer/utils/annotationPdfLib').split('\\').join('/')
writeFileSync(entryPath, `export { writeAnnotationsToPdf, readAnnotationsFromPdf } from '${modPath}'\n`)
const esbuild = await import('esbuild')
esbuild.buildSync({
  entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node',
  absWorkingDir: ROOT, outfile: bundlePath,
})
const { writeAnnotationsToPdf, readAnnotationsFromPdf } = await import(pathToFileURL(bundlePath).href)
const ops = await import(pathToFileURL(join(ROOT, 'dist-electron/main/mupdfOps.js')).href)

const base = await PDFDocument.create()
base.addPage([612, 792])
const OP = 0.55                                  // deliberately not the old 0.7 default
const c = { pageNum: 1, createdAt: Date.now(), opacity: OP }

const IN = [
  { ...c, id: 'hl', type: 'highlight', color: '#ffcc00', quads: [[60, 700, 200, 700, 60, 685, 200, 685]], selectedText: 'HLTEXT' },
  { ...c, id: 'ul', type: 'underline', color: '#00aa00', quads: [[60, 670, 200, 670, 60, 655, 200, 655]], selectedText: 'ULTEXT' },
  { ...c, id: 'sk', type: 'strikethrough', color: '#aa0000', quads: [[60, 640, 200, 640, 60, 625, 200, 625]], selectedText: 'SKTEXT' },
  { ...c, id: 'ink', type: 'ink', color: '#ff0000', lineWidth: 3, paths: [[[60, 600], [90, 580], [120, 605]]] },
  { ...c, id: 'rect', type: 'rectangle', color: '#0000ff', lineWidth: 4, x1: 60, y1: 520, x2: 200, y2: 560 },
  { ...c, id: 'ell', type: 'ellipse', color: '#aa00aa', lineWidth: 5, x1: 220, y1: 520, x2: 360, y2: 560 },
  { ...c, id: 'line', type: 'line', color: '#008080', lineWidth: 2, x1: 60, y1: 500, x2: 200, y2: 500 },
  { ...c, id: 'arr', type: 'arrow', color: '#804000', lineWidth: 2, x1: 220, y1: 500, x2: 360, y2: 500 },
  { ...c, id: 'tb', type: 'textbox', color: '#112233', x: 60, y: 440, width: 200, height: 40, text: 'TBTEXT', fontSize: 13, font: 'Helvetica', lineWidth: 1 },
  { ...c, id: 'tw', type: 'typewriter', color: '#334455', x: 300, y: 450, text: 'TWTEXT', fontSize: 15, font: 'Helvetica' },
  { ...c, id: 'sn', type: 'stickynote', color: '#ffdd00', x: 60, y: 410, text: 'SNTEXT' },
  { ...c, id: 'st', type: 'stamp', color: '#cc0000', x: 300, y: 400, width: 130, height: 40, stampName: 'Rejected' },
  { ...c, id: 'co', type: 'callout', color: '#c05000', x: 300, y: 320, width: 180, height: 40, tipX: 250, tipY: 310, text: 'COTEXT', fontSize: 11, font: 'Helvetica', lineWidth: 1 },
  { ...c, id: 'cl', type: 'cloud', color: '#0066cc', lineWidth: 2, points: [[60, 250], [160, 250], [160, 300], [60, 300]] },
  { ...c, id: 'pg', type: 'polygon', color: '#666600', lineWidth: 2, points: [[220, 250], [320, 250], [270, 300]] },
  { ...c, id: 'pl', type: 'polyline', color: '#996699', lineWidth: 2, points: [[360, 250], [420, 290], [480, 250]] },
  { ...c, id: 'ct', type: 'caret', color: '#ff6600', x: 60, y: 220, width: 12, height: 14 },
  { ...c, id: 'md', type: 'measure-distance', color: '#227722', lineWidth: 2, points: [[60, 190], [200, 190]], label: '140.0 pt', unit: 'pt' },
  { ...c, id: 'lk', type: 'link', color: '#0000ee', x1: 60, y1: 150, x2: 180, y2: 170, href: 'https://example.com' },
]

const written = await writeAnnotationsToPdf(await base.save(), IN)
// The real save runs MuPDF appearance synthesis after pdf-lib; include it.
const final = new Uint8Array(await ops.synthesizeAppearances(written.slice().buffer))
writeFileSync(join(tmp, 'roundtrip.pdf'), final)

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
const doc = await pdfjs.getDocument({ data: new Uint8Array(final), useSystemFonts: false }).promise
const back = await readAnnotationsFromPdf(doc, 1)
const of = t => back.find(r => r.type === t)

console.log('\n=== every tool survives the round trip ===')
for (const want of [...new Set(IN.map(i => i.type))]) {
  ok(!!of(want), `${want} reloads as ${want}`)
}
ok(back.length === IN.length, `annotation count preserved (in ${IN.length}, out ${back.length})`)

console.log('\n=== colour is preserved exactly ===')
for (const src of IN) {
  const got = of(src.type)
  if (src.type === 'link') continue          // link colour is viewer-drawn chrome
  ok(got?.color === src.color, `${src.type}: ${src.color} (got ${got?.color})`)
}
ok(back.every(r => !String(r.color).includes('NaN')), 'no annotation reloads with a NaN colour')

console.log('\n=== opacity is preserved, not reset to a default ===')
for (const src of IN) {
  const got = of(src.type)
  // PDF.js reports Redact as an unimplemented base annotation, which carries no
  // /T, so its sidecar cannot be read. Redactions paint opaque black regardless.
  if (src.type === 'link' || src.type === 'redact') continue
  ok(near(got?.opacity, OP, 0.001), `${src.type}: opacity ${OP} (got ${got?.opacity})`)
}

console.log('\n=== geometry survives (the typed-array bugs) ===')
const hl = of('highlight')
ok(hl?.quads?.length === 1 && near(hl.quads[0][0], 60) && near(hl.quads[0][3], 700),
  `highlight quad points intact (${JSON.stringify(hl?.quads?.[0]?.slice(0, 4))})`)

const ink = of('ink')
const p0 = ink?.paths?.[0]
ok(ink?.paths?.length === 1 && p0?.length === 3, `ink has 1 path of 3 points (got ${ink?.paths?.length}/${p0?.length})`)
ok(near(p0?.[0]?.[0], 60) && near(p0?.[0]?.[1], 600) && near(p0?.[2]?.[0], 120),
  `ink coordinates are real numbers (${JSON.stringify(p0)})`)

const cloud = of('cloud'), poly = of('polygon'), pline = of('polyline')
ok(cloud?.points?.length === 4, `cloud keeps 4 vertices (got ${cloud?.points?.length})`)
ok(poly?.points?.length === 3, `polygon keeps 3 vertices (got ${poly?.points?.length})`)
ok(pline?.points?.length === 3, `polyline keeps 3 vertices (got ${pline?.points?.length})`)
ok(near(poly?.points?.[0]?.[0], 220) && near(poly?.points?.[0]?.[1], 250),
  `polygon vertex values intact (${JSON.stringify(poly?.points?.[0])})`)

const rect = of('rectangle')
ok(near(rect?.x1, 60) && near(rect?.y1, 520) && near(rect?.x2, 200) && near(rect?.y2, 560), 'rectangle bounds intact')
ok(rect?.lineWidth === 4 && of('ellipse')?.lineWidth === 5, 'line widths intact')

console.log('\n=== text survives ===')
for (const [type, want] of [['highlight', 'HLTEXT'], ['underline', 'ULTEXT'], ['strikethrough', 'SKTEXT'],
  ['textbox', 'TBTEXT'], ['typewriter', 'TWTEXT'], ['stickynote', 'SNTEXT'], ['callout', 'COTEXT']]) {
  const r = of(type)
  const got = r?.text ?? r?.selectedText ?? ''
  ok(got === want, `${type}: "${want}" (got "${got}")`)
}
ok(of('stamp')?.stampName === 'Rejected', `stamp keeps its label (got ${of('stamp')?.stampName})`)

console.log('\n=== tool identity that PDF.js cannot express ===')
ok(of('typewriter')?.type === 'typewriter', 'typewriter does not degrade into a text box')
const co = of('callout')
ok(near(co?.tipX, 250) && near(co?.tipY, 310), `callout keeps its leader tip (${co?.tipX},${co?.tipY})`)
ok(of('cloud')?.type === 'cloud', 'cloud does not degrade into a polygon')
const md = of('measure-distance')
ok(md?.label === '140.0 pt' && md?.unit === 'pt', `measurement keeps its label and unit (${md?.label}, ${md?.unit})`)
ok(of('arrow')?.type === 'arrow' && of('line')?.type === 'line', 'arrow and plain line stay distinct')

console.log('\n=== RESULT ===')
if (failures) { console.log(`  FAIL - ${failures} check(s) failed.`); process.exit(1) }
console.log(`  PASS - all ${IN.length} annotation types round trip with colour, opacity, geometry and text intact.`)
