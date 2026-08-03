// Round-trip audit for the three non-annotation save paths: AcroForm fields,
// the bookmark outline, and the OCR invisible text layer.
//
// Forms were losing and CORRUPTING data:
//   * PDF.js returns a choice field's value as an ARRAY even for one selection.
//     Reading it as a string fell through to options[0], so a saved dropdown
//     reopened showing the FIRST option instead of the user's choice.
//   * a list box was detected via multiSelect, which is false for a
//     single-select list, so it reopened as a dropdown and lost its values.
//     The correct discriminator is the combo flag.
//   * createRadioGroup() throws when the group already exists and the throw was
//     swallowed, so only the FIRST button of any radio group was ever written.
//   * a signature area was written as a stand-in text field, so it reopened as
//     an editable text box.
//   * readOnly and maxLen were carried in the model but never written at all.
//
// Bookmarks and OCR were already correct; the checks here guard them.

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

const tmp = mkdtempSync(join(tmpdir(), 'monstera-fbo-'))
const esbuild = await import('esbuild')
const bundle = (name, exports, mod) => {
  const e = join(tmp, `${name}.ts`), b = join(tmp, `${name}.mjs`)
  writeFileSync(e, `export { ${exports} } from '${join(ROOT, mod).split('\\').join('/')}'\n`)
  esbuild.buildSync({ entryPoints: [e], bundle: true, format: 'esm', platform: 'node', absWorkingDir: ROOT, outfile: b })
  return import(pathToFileURL(b).href)
}
const { writeFormToBytes, readFormFieldsFromPdf } =
  await bundle('forms', 'writeFormToBytes, readFormFieldsFromPdf', 'src/renderer/utils/formPdfLib')
const { embedOcrText } = await bundle('ocr', 'embedOcrText', 'src/renderer/utils/ocrPdfLib')
const ops = await import(pathToFileURL(join(ROOT, 'dist-electron/main/mupdfOps.js')).href)
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

const mkDoc = async (pages = 3) => {
  const d = await PDFDocument.create()
  for (let i = 0; i < pages; i++) d.addPage([612, 792])
  return d.save()
}
const ab = u8 => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)

// ══════════════════════ FORMS ══════════════════════
console.log('\n=== forms: every field type survives a save and reopen ===')
const F_IN = [
  { id: 't1', pageNum: 1, fieldName: 'txtName', rect: [60, 700, 300, 720], readOnly: false, isNew: true, type: 'text', value: 'Karla Reyes', multiline: false },
  { id: 't2', pageNum: 1, fieldName: 'txtNotes', rect: [60, 650, 300, 690], readOnly: false, isNew: true, type: 'text', value: 'line one\nline two', multiline: true, maxLen: 80 },
  { id: 'c1', pageNum: 1, fieldName: 'chkAgree', rect: [60, 610, 78, 628], readOnly: false, isNew: true, type: 'checkbox', checked: true, exportValue: 'Yes' },
  { id: 'c2', pageNum: 1, fieldName: 'chkNo', rect: [120, 610, 138, 628], readOnly: false, isNew: true, type: 'checkbox', checked: false, exportValue: 'Yes' },
  { id: 'r1', pageNum: 1, fieldName: 'grpSize', rect: [60, 570, 78, 588], readOnly: false, isNew: true, type: 'radio', groupName: 'grpSize', exportValue: 'S', selected: false },
  { id: 'r2', pageNum: 1, fieldName: 'grpSize', rect: [120, 570, 138, 588], readOnly: false, isNew: true, type: 'radio', groupName: 'grpSize', exportValue: 'M', selected: true },
  { id: 'd1', pageNum: 1, fieldName: 'ddCountry', rect: [60, 520, 250, 545], readOnly: false, isNew: true, type: 'dropdown', options: ['Honduras', 'Nigeria', 'UK'], value: 'Nigeria' },
  { id: 'l1', pageNum: 1, fieldName: 'lbLangs', rect: [60, 440, 250, 505], readOnly: false, isNew: true, type: 'listbox', options: ['EN', 'ES', 'FR'], values: ['ES'] },
  { id: 's1', pageNum: 1, fieldName: 'sigHere', rect: [60, 380, 250, 420], readOnly: false, isNew: true, type: 'signature' },
  { id: 'ro', pageNum: 1, fieldName: 'txtLocked', rect: [60, 340, 300, 360], readOnly: true, isNew: true, type: 'text', value: 'locked value', multiline: false },
]
const formBytes = await writeFormToBytes(await mkDoc(1), F_IN)
const fDoc = await pdfjs.getDocument({ data: new Uint8Array(formBytes), useSystemFonts: false }).promise
const F_OUT = await readFormFieldsFromPdf(fDoc, 1)
const field = n => F_OUT.filter(f => f.fieldName === n)

ok(F_OUT.length === F_IN.length, `all ${F_IN.length} fields reload (got ${F_OUT.length})`)
ok(field('txtName')[0]?.value === 'Karla Reyes', 'text value preserved')
ok(field('txtNotes')[0]?.multiline === true, 'multiline flag preserved')
ok(field('txtNotes')[0]?.maxLen === 80, `maxLen preserved (got ${field('txtNotes')[0]?.maxLen})`)
ok(field('chkAgree')[0]?.checked === true && field('chkNo')[0]?.checked === false, 'checkbox states preserved')

const radios = field('grpSize')
ok(radios.length === 2, `both radio buttons written (got ${radios.length})`)
ok(radios.filter(r => r.selected).length === 1, 'exactly one radio is selected')
ok(radios[1]?.selected === true, 'the SECOND radio is the selected one, as authored')

const dd = field('ddCountry')[0]
ok(dd?.type === 'dropdown', 'dropdown stays a dropdown')
ok(dd?.value === 'Nigeria', `dropdown keeps the chosen value, not options[0] (got ${JSON.stringify(dd?.value)})`)

const lb = field('lbLangs')[0]
ok(lb?.type === 'listbox', `list box stays a list box (got ${lb?.type})`)
ok(JSON.stringify(lb?.values) === JSON.stringify(['ES']), `list box keeps its selection (got ${JSON.stringify(lb?.values)})`)

ok(field('sigHere')[0]?.type === 'signature', `signature stays a signature (got ${field('sigHere')[0]?.type})`)
ok(field('txtLocked')[0]?.readOnly === true, 'readOnly is preserved')

// ══════════════════════ BOOKMARKS ══════════════════════
console.log('\n=== bookmarks: titles and target pages survive repeated saves ===')
const B_IN = [
  { id: 'a', title: 'Introduction', pageNum: 1 },
  { id: 'b', title: 'Chapter One', pageNum: 2 },
  { id: 'c', title: 'Résumé & Ünicode — dash', pageNum: 3 },
  { id: 'd', title: 'Back to page 1', pageNum: 1 },
]
const bm1 = await ops.writeOutline(ab(await mkDoc(3)), B_IN)
const B_OUT = await ops.getOutline(bm1)
ok(B_OUT.length === B_IN.length, `all ${B_IN.length} bookmarks reload (got ${B_OUT.length})`)
ok(B_OUT.every((b, i) => b.title === B_IN[i].title), 'titles preserved, including non-ASCII')
ok(B_OUT.every((b, i) => b.pageNum === B_IN[i].pageNum), 'target pages preserved')
const B_OUT2 = await ops.getOutline(await ops.writeOutline(bm1, B_OUT))
ok(JSON.stringify(B_OUT2.map(b => [b.title, b.pageNum])) === JSON.stringify(B_IN.map(b => [b.title, b.pageNum])),
  'a second save/reopen cycle does not drift')

// ══════════════════════ OCR ══════════════════════
console.log('\n=== OCR: the invisible text layer is extractable and invisible ===')
const WORDS = [
  { text: 'Hello', x: 60, y: 700, w: 40, h: 12 },
  { text: 'world', x: 110, y: 700, w: 40, h: 12 },
  { text: 'Ünïcodé', x: 60, y: 680, w: 60, h: 12 },
  { text: '12345', x: 60, y: 660, w: 40, h: 12 },
  { text: '(paren)', x: 60, y: 640, w: 50, h: 12 },
]
const ocrBytes = await embedOcrText(await mkDoc(2), new Map([[1, WORDS], [2, [{ text: 'PageTwo', x: 60, y: 700, w: 60, h: 12 }]]]))
const oPages = await ops.extractAllText(ab(ocrBytes))
const page1 = oPages[0]?.text ?? ''
for (const w of WORDS) ok(page1.includes(w.text), `"${w.text}" is extractable from the saved file`)
ok((oPages[1]?.text ?? '').includes('PageTwo'), 'per-page OCR text lands on the right page')
const after = await ops.extractAllText(ab(new Uint8Array(await ops.synthesizeAppearances(ab(ocrBytes)))))
ok((after[0]?.text ?? '').includes('Hello'), 'OCR text survives a further save')

const mupdf = await import('mupdf')
const mp = mupdf.PDFDocument.openDocument(ocrBytes, 'application/pdf').loadPage(0)
const pix = mp.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true)
const px = pix.getPixels(), nch = px.length / (pix.getWidth() * pix.getHeight())
let ink = 0
for (let i = 0; i < px.length; i += nch) if (px[i] < 240 || px[i + 1] < 240 || px[i + 2] < 240) ink++
ok(ink === 0, `the OCR layer paints nothing visible (${ink} ink pixels)`)

console.log('\n=== RESULT ===')
if (failures) { console.log(`  FAIL - ${failures} check(s) failed.`); process.exit(1) }
console.log('  PASS - forms, bookmarks and the OCR text layer all round trip intact.')
