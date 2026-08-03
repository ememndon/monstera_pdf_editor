import { PDFDocument, PDFName, PDFNumber, PDFString, PDFBool, PDFArray, StandardFonts, rgb } from 'pdf-lib'
import type { PDFFont } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type {
  Annotation, HighlightAnn, InkAnn, ShapeAnn,
  TextBoxAnn, StickyNoteAnn, StampAnn, RedactAnn,
  TypewriterAnn, TextEditAnn, PlacedImageAnn,
  CalloutAnn, CloudAnn, PolyAnn, CaretAnn, MeasureAnn, LinkAnn,
} from '../types/annotations'
import { hexToRgb01, rgb255ToHex, newId } from './annotationUtils'

export const NM_PREFIX = 'monstera-'

// ── helpers ──────────────────────────────────────────────────────────────────

function mkC(doc: PDFDocument, hex: string) {
  const [r, g, b] = hexToRgb01(hex)
  return doc.context.obj([r, g, b])
}

// Map a chosen family to a base-14 PDF font name that viewers render natively.
function daFont(font?: string): string {
  return (font === 'Times-Roman' || font === 'Courier') ? font : 'Helvetica'
}

// ── appearance streams for text-bearing annotations ──────────────────────────
// pdf-lib writes bare annotation dictionaries. For anything that shows text that
// is not enough, and it fails in two ways at once:
//   * /C on a FreeText is the BACKGROUND colour, not the text colour. Passing the
//     user's text colour there painted a solid filled box over the page.
//   * a /DA font name only resolves if that name exists in the AcroForm /DR
//     resource dictionary, which we never wrote, so the text could not be laid
//     out at all and was silently dropped.
// The result was a coloured rectangle with no text. Building the /AP ourselves
// makes the annotation render identically in every viewer, and MuPDF's synthesis
// pass deliberately skips annotations that already carry an appearance.

type FontGetter = (family?: string, bold?: boolean) => Promise<PDFFont>

function boldVariant(base: string): string {
  if (base === 'Times-Roman') return 'Times-Bold'
  if (base === 'Courier') return 'Courier-Bold'
  return 'Helvetica-Bold'
}

function makeFontGetter(doc: PDFDocument): FontGetter {
  const cache = new Map<string, PDFFont>()
  return async (family, bold) => {
    const name = bold ? boldVariant(daFont(family)) : daFont(family)
    let f = cache.get(name)
    if (!f) { f = await doc.embedFont(name as StandardFonts); cache.set(name, f) }
    return f
  }
}

// Escape a PDF literal string used inside a content stream.
const escPdf = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

// A /DA that carries the text colour too, so a viewer that re-synthesizes the
// appearance after an edit still gets the right colour and size.
function daString(hex: string, font: string | undefined, size: number): string {
  const [r, g, b] = hexToRgb01(hex)
  return `${r} ${g} ${b} rg /${daFont(font)} ${size} Tf`
}

// Break text into lines. maxWidth <= 0 means "do not wrap", honouring only the
// newlines the user typed.
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = []
  for (const para of text.split(/\r?\n/)) {
    if (!para) { out.push(''); continue }
    if (maxWidth <= 0) { out.push(para); continue }
    let line = ''
    for (const word of para.split(/(\s+)/)) {
      const next = line + word
      if (line && font.widthOfTextAtSize(next, size) > maxWidth) {
        out.push(line.trimEnd())
        line = word.trimStart()
      } else line = next
    }
    out.push(line.trimEnd())
  }
  return out
}

// Register a Form XObject holding `ops` and return the /AP dictionary for it.
function apDict(doc: PDFDocument, width: number, height: number, font: PDFFont, ops: string) {
  const stream = doc.context.flateStream(`q\n${ops}Q\n`, {
    Type: PDFName.of('XObject'),
    Subtype: PDFName.of('Form'),
    FormType: PDFNumber.of(1),
    BBox: doc.context.obj([0, 0, width, height]),
    Resources: doc.context.obj({ Font: doc.context.obj({ F1: font.ref }) }),
  })
  return doc.context.obj({ N: doc.context.register(stream) })
}

// Text laid out top-down inside a box whose origin is the BBox corner.
function textOps(
  lines: string[], font: PDFFont, size: number, hex: string,
  boxH: number, pad: number, align: 'left' | 'center' = 'left', boxW = 0,
): string {
  const [r, g, b] = hexToRgb01(hex)
  const leading = size * 1.15
  let y = boxH - pad - size * 0.85
  let out = `BT\n/F1 ${size} Tf\n${r} ${g} ${b} rg\n`
  for (const line of lines) {
    if (line) {
      const x = align === 'center'
        ? Math.max(0, (boxW - font.widthOfTextAtSize(line, size)) / 2)
        : pad
      out += `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm\n(${escPdf(line)}) Tj\n`
    }
    y -= leading
  }
  return out + 'ET\n'
}

// Stroked rectangle inset by half the line width so the stroke stays inside BBox.
function borderOps(hex: string, lw: number, w: number, h: number): string {
  if (lw <= 0) return ''
  const [r, g, b] = hexToRgb01(hex)
  const i = lw / 2
  return `${r} ${g} ${b} RG\n${lw} w\n${i} ${i} ${(w - lw).toFixed(2)} ${(h - lw).toFixed(2)} re\nS\n`
}

// Pick the base-14 variant (regular/bold/italic/bold-italic) of a family so a
// cover-and-replace text edit can match the original weight/slant when baked.
function stdFontVariant(family?: string, bold?: boolean, italic?: boolean): string {
  if (daFont(family) === 'Times-Roman')
    return bold && italic ? 'Times-BoldItalic' : bold ? 'Times-Bold' : italic ? 'Times-Italic' : 'Times-Roman'
  if (daFont(family) === 'Courier')
    return bold && italic ? 'Courier-BoldOblique' : bold ? 'Courier-Bold' : italic ? 'Courier-Oblique' : 'Courier'
  return bold && italic ? 'Helvetica-BoldOblique' : bold ? 'Helvetica-Bold' : italic ? 'Helvetica-Oblique' : 'Helvetica'
}

// ── round-trip sidecar ───────────────────────────────────────────────────────
// PDF.js does not surface several things we write: /CA opacity (for most
// subtypes), /IT intent, /BE border effect, /CL callout lines, and /NM. Without
// them a reopened file lost each annotation's opacity and its exact tool
// identity (typewriter became a text box, a cloud became a polygon, a
// measurement became a plain line). PDF.js does expose /T, so carry a compact
// JSON sidecar there and prefer it over guesswork when reading back.
export const T_PREFIX = 'Monstera '

interface Sidecar { t: string; o?: number; tip?: [number, number]; u?: string; fs?: number }

let pendingSidecar: Sidecar | null = null

function ensureAnnots(doc: PDFDocument, idx: number): PDFArray {
  const page = doc.getPage(idx)
  const key = PDFName.of('Annots')
  const existing = page.node.lookupMaybe(key, PDFArray)
  if (existing) return existing
  const arr = doc.context.obj([]) as PDFArray
  page.node.set(key, arr)
  return arr
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function registerAnnot(doc: PDFDocument, idx: number, dictLiteral: any) {
  const arr = ensureAnnots(doc, idx)
  const dict = { ...dictLiteral }
  if (pendingSidecar && dict.T === undefined) {
    dict.T = PDFString.of(T_PREFIX + JSON.stringify(pendingSidecar))
  }
  const ref = doc.context.register(doc.context.obj(dict))
  arr.push(ref)
}

function clearAll(doc: PDFDocument) {
  for (let i = 0; i < doc.getPageCount(); i++) {
    doc.getPage(i).node.delete(PDFName.of('Annots'))
  }
}

// ── write ─────────────────────────────────────────────────────────────────────

function writeHighlight(doc: PDFDocument, a: HighlightAnn) {
  const subMap = { highlight: 'Highlight', underline: 'Underline', strikethrough: 'StrikeOut' } as const
  const allX = a.quads.flatMap(q => [q[0], q[2], q[4], q[6]])
  const allY = a.quads.flatMap(q => [q[1], q[3], q[5], q[7]])
  registerAnnot(doc, a.pageNum - 1, {
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of(subMap[a.type]),
    Rect: doc.context.obj([Math.min(...allX), Math.min(...allY), Math.max(...allX), Math.max(...allY)]),
    QuadPoints: doc.context.obj(a.quads.flat()),
    C: mkC(doc, a.color),
    CA: PDFNumber.of(a.opacity),
    Contents: PDFString.of(a.selectedText || ''),
    NM: PDFString.of(NM_PREFIX + a.id),
    F: PDFNumber.of(4),
  })
}

function writeInk(doc: PDFDocument, a: InkAnn) {
  if (a.paths.length === 0) return
  const allPts = a.paths.flat()
  registerAnnot(doc, a.pageNum - 1, {
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Ink'),
    Rect: doc.context.obj([
      Math.min(...allPts.map(p => p[0])) - 2,
      Math.min(...allPts.map(p => p[1])) - 2,
      Math.max(...allPts.map(p => p[0])) + 2,
      Math.max(...allPts.map(p => p[1])) + 2,
    ]),
    InkList: doc.context.obj(a.paths.map(path => doc.context.obj(path.flat()))),
    BS: doc.context.obj({ W: PDFNumber.of(a.lineWidth) }),
    C: mkC(doc, a.color),
    CA: PDFNumber.of(a.opacity),
    NM: PDFString.of(NM_PREFIX + a.id),
    F: PDFNumber.of(4),
  })
}

function writeShape(doc: PDFDocument, a: ShapeAnn) {
  const base: Record<string, unknown> = {
    Type: PDFName.of('Annot'),
    BS: doc.context.obj({ W: PDFNumber.of(a.lineWidth) }),
    C: mkC(doc, a.color),
    CA: PDFNumber.of(a.opacity),
    NM: PDFString.of(NM_PREFIX + a.id),
    F: PDFNumber.of(4),
  }
  if (a.type === 'rectangle' || a.type === 'ellipse') {
    base.Subtype = PDFName.of(a.type === 'rectangle' ? 'Square' : 'Circle')
    base.Rect = doc.context.obj([
      Math.min(a.x1, a.x2), Math.min(a.y1, a.y2),
      Math.max(a.x1, a.x2), Math.max(a.y1, a.y2),
    ])
  } else {
    base.Subtype = PDFName.of('Line')
    base.L = doc.context.obj([a.x1, a.y1, a.x2, a.y2])
    base.Rect = doc.context.obj([
      Math.min(a.x1, a.x2) - 5, Math.min(a.y1, a.y2) - 5,
      Math.max(a.x1, a.x2) + 5, Math.max(a.y1, a.y2) + 5,
    ])
    if (a.type === 'arrow') {
      base.LE = doc.context.obj([PDFName.of('None'), PDFName.of('OpenArrow')])
    }
  }
  registerAnnot(doc, a.pageNum - 1, base)
}

async function writeTextBox(doc: PDFDocument, a: TextBoxAnn, getFont: FontGetter) {
  const font = await getFont(a.font)
  const size = a.fontSize
  const pad = 4
  const lines = wrapText(sanitizeForStandardFont(a.text ?? ''), font, size, a.width - pad * 2)
  // No /C and no border: on screen the box chrome is a near-invisible editing
  // affordance, so painting a filled or outlined box here would put something in
  // the saved file that the user never saw.
  registerAnnot(doc, a.pageNum - 1, {
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('FreeText'),
    Rect: doc.context.obj([a.x, a.y, a.x + a.width, a.y + a.height]),
    Contents: PDFString.of(a.text),
    DA: PDFString.of(daString(a.color, a.font, size)),
    BS: doc.context.obj({ W: PDFNumber.of(0) }),
    CA: PDFNumber.of(a.opacity),
    NM: PDFString.of(NM_PREFIX + a.id),
    F: PDFNumber.of(4),
    AP: apDict(doc, a.width, a.height, font,
      textOps(lines, font, size, a.color, a.height, pad)),
  })
}

function writeStickyNote(doc: PDFDocument, a: StickyNoteAnn) {
  registerAnnot(doc, a.pageNum - 1, {
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Text'),
    Rect: doc.context.obj([a.x, a.y, a.x + 20, a.y + 20]),
    Contents: PDFString.of(a.text),
    C: mkC(doc, a.color),
    CA: PDFNumber.of(a.opacity),
    Name: PDFName.of('Comment'),
    Open: PDFBool.False,
    NM: PDFString.of(NM_PREFIX + a.id),
    F: PDFNumber.of(4),
  })
}

function writeRedact(doc: PDFDocument, a: RedactAnn) {
  registerAnnot(doc, a.pageNum - 1, {
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Redact'),
    Rect: doc.context.obj([
      Math.min(a.x1, a.x2), Math.min(a.y1, a.y2),
      Math.max(a.x1, a.x2), Math.max(a.y1, a.y2),
    ]),
    IC: doc.context.obj([0, 0, 0]),
    NM: PDFString.of(NM_PREFIX + a.id),
    F: PDFNumber.of(4),
  })
}

async function writeTypewriter(doc: PDFDocument, a: TypewriterAnn, getFont: FontGetter) {
  // Typewriter is bare text: transparent background, no border. The old code set
  // /C to the text colour, which a FreeText reads as its background fill, so the
  // saved page showed a solid rectangle instead of the typed words.
  const font = await getFont(a.font)
  const size = a.fontSize
  const pad = 2
  const lines = wrapText(sanitizeForStandardFont(a.text ?? ''), font, size, 0)
  const width = Math.max(4, ...lines.map(l => font.widthOfTextAtSize(l, size))) + pad * 2
  const height = Math.max(1, lines.length) * size * 1.15 + pad * 2
  // The overlay anchors the text block's TOP at y + fontSize * 1.5; mirror that
  // so the saved position matches what was on screen.
  const top = a.y + size * 1.5
  registerAnnot(doc, a.pageNum - 1, {
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('FreeText'),
    Rect: doc.context.obj([a.x, top - height, a.x + width, top]),
    Contents: PDFString.of(a.text),
    DA: PDFString.of(daString(a.color, a.font, size)),
    BS: doc.context.obj({ W: PDFNumber.of(0) }),
    CA: PDFNumber.of(a.opacity),
    NM: PDFString.of(NM_PREFIX + a.id),
    F: PDFNumber.of(4),
    AP: apDict(doc, width, height, font,
      textOps(lines, font, size, a.color, height, pad)),
  })
}

// Drop characters a base-14 font's WinAnsi encoding can't represent, so the
// fallback path never throws on smart quotes / dashes / non-Latin glyphs.
function sanitizeForStandardFont(s: string): string {
  return s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '')
}

// TextEdit (cover-and-replace): paint a white rectangle over the original glyphs
// in the page content, then draw the new text on top in the document's OWN
// embedded font (fontDataB64) at the original baseline. Drawing into the content
// stream — never rewriting existing objects — keeps every other font intact, so
// editing one word can't reflow the rest of the page (the old PDFium failure).
// Falls back to a base-14 match only when the original font can't be embedded.
async function writeTextEdit(doc: PDFDocument, a: TextEditAnn, fontCache: Map<string, PDFFont>) {
  const page = doc.getPage(a.pageNum - 1)
  page.drawRectangle({ x: a.x, y: a.y, width: a.width, height: a.height, color: rgb(1, 1, 1) })
  if (!a.text) return

  const size = a.fontSize || 12
  const baseX = a.baselineX ?? a.x
  const baseY = a.baselineY ?? (a.y + size * 0.2)
  const [r, g, b] = hexToRgb01(a.color)

  let font: PDFFont | null = null
  let text = a.text
  if (a.fontDataB64) {
    try {
      let f = fontCache.get(a.fontDataB64)
      if (!f) {
        f = await doc.embedFont(base64ToBytes(a.fontDataB64), { subset: false })
        fontCache.set(a.fontDataB64, f)
      }
      font = f
    } catch { font = null }
  }
  if (!font) {
    const std = stdFontVariant(a.font, a.bold, a.italic)
    let f = fontCache.get('std:' + std)
    if (!f) { f = await doc.embedFont(std as StandardFonts); fontCache.set('std:' + std, f) }
    font = f
    text = sanitizeForStandardFont(text)
  }
  try {
    page.drawText(text, { x: baseX, y: baseY, size, font, color: rgb(r, g, b), lineHeight: size * 1.15 })
  } catch { /* unencodable text — leave the white cover so the original stays hidden */ }
}

async function writeStamp(doc: PDFDocument, a: StampAnn, getFont: FontGetter) {
  // Previously this wrote only a /Name drawn from a five-entry map, so every
  // other stamp (Today, Received, Revised, Void, For Review, any custom label)
  // fell through to 'Draft' and the viewer painted its built-in DRAFT artwork.
  // Draw the real label ourselves instead, which works for any name.
  const font = await getFont(undefined, true)
  const w = a.width, h = a.height
  const size = Math.min(h * 0.6, 18)
  const label = sanitizeForStandardFont(String(a.stampName ?? '').toUpperCase())
  const lw = 2
  // Vertically centre the cap-height rather than the full line box.
  const ops = borderOps(a.color, lw, w, h)
    + textOps([label], font, size, a.color, h, 0, 'center', w).replace(
        /1 0 0 1 ([\d.]+) [\d.]+ Tm/,
        (_m, x) => `1 0 0 1 ${x} ${((h - size * 0.7) / 2).toFixed(2)} Tm`)
  registerAnnot(doc, a.pageNum - 1, {
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Stamp'),
    Rect: doc.context.obj([a.x - w / 2, a.y - h / 2, a.x + w / 2, a.y + h / 2]),
    C: mkC(doc, a.color),
    CA: PDFNumber.of(a.opacity),
    Contents: PDFString.of(String(a.stampName ?? '')),
    NM: PDFString.of(NM_PREFIX + a.id),
    F: PDFNumber.of(4),
    AP: apDict(doc, w, h, font, ops),
  })
}

async function writeCallout(doc: PDFDocument, a: CalloutAnn, getFont: FontGetter) {
  const x2 = a.x + a.width, y2 = a.y + a.height
  const font = await getFont(a.font)
  const size = a.fontSize
  const pad = 4
  const lines = wrapText(sanitizeForStandardFont(a.text ?? ''), font, size, a.width - pad * 2)

  // The appearance box has to contain the leader tip as well as the text box,
  // otherwise the line would be clipped away.
  const rx0 = Math.min(a.x, a.tipX), ry0 = Math.min(a.y, a.tipY)
  const rx1 = Math.max(x2, a.tipX), ry1 = Math.max(y2, a.tipY)
  const apW = Math.max(1, rx1 - rx0), apH = Math.max(1, ry1 - ry0)
  const [lr, lg, lb] = hexToRgb01(a.color)
  const lw = Math.max(a.lineWidth, 1)

  const leader =
    `${lr} ${lg} ${lb} RG\n${lw} w\n` +
    `${(a.tipX - rx0).toFixed(2)} ${(a.tipY - ry0).toFixed(2)} m\n` +
    `${(a.x - rx0).toFixed(2)} ${(((a.y + y2) / 2) - ry0).toFixed(2)} l\nS\n`
  const box =
    `q\n1 0 0 1 ${(a.x - rx0).toFixed(2)} ${(a.y - ry0).toFixed(2)} cm\n` +
    borderOps(a.color, lw, a.width, a.height) +
    textOps(lines, font, size, a.color, a.height, pad) +
    `Q\n`

  registerAnnot(doc, a.pageNum - 1, {
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('FreeText'),
    Rect: doc.context.obj([rx0, ry0, rx1, ry1]),
    Contents: PDFString.of(a.text),
    DA: PDFString.of(daString(a.color, a.font, size)),
    BS: doc.context.obj({ W: PDFNumber.of(a.lineWidth) }),
    CA: PDFNumber.of(a.opacity),
    CL: doc.context.obj([a.tipX, a.tipY, a.x, (a.y + y2) / 2]),
    IT: PDFName.of('FreeTextCallout'),
    NM: PDFString.of(NM_PREFIX + a.id),
    F: PDFNumber.of(4),
    AP: apDict(doc, apW, apH, font, leader + box),
  })
}

function writeCloud(doc: PDFDocument, a: CloudAnn) {
  if (a.points.length < 2) return
  const allX = a.points.map(p => p[0]), allY = a.points.map(p => p[1])
  registerAnnot(doc, a.pageNum - 1, {
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Polygon'),
    Rect: doc.context.obj([
      Math.min(...allX) - 4, Math.min(...allY) - 4,
      Math.max(...allX) + 4, Math.max(...allY) + 4,
    ]),
    Vertices: doc.context.obj(a.points.flat()),
    BS: doc.context.obj({ W: PDFNumber.of(a.lineWidth) }),
    BE: doc.context.obj({ S: PDFName.of('C'), I: PDFNumber.of(1) }),
    C: mkC(doc, a.color),
    CA: PDFNumber.of(a.opacity),
    NM: PDFString.of(NM_PREFIX + a.id),
    F: PDFNumber.of(4),
  })
}

function writePoly(doc: PDFDocument, a: PolyAnn) {
  if (a.points.length < 2) return
  const allX = a.points.map(p => p[0]), allY = a.points.map(p => p[1])
  registerAnnot(doc, a.pageNum - 1, {
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of(a.type === 'polygon' ? 'Polygon' : 'PolyLine'),
    Rect: doc.context.obj([
      Math.min(...allX) - 4, Math.min(...allY) - 4,
      Math.max(...allX) + 4, Math.max(...allY) + 4,
    ]),
    Vertices: doc.context.obj(a.points.flat()),
    BS: doc.context.obj({ W: PDFNumber.of(a.lineWidth) }),
    C: mkC(doc, a.color),
    CA: PDFNumber.of(a.opacity),
    NM: PDFString.of(NM_PREFIX + a.id),
    F: PDFNumber.of(4),
  })
}

function writeCaret(doc: PDFDocument, a: CaretAnn) {
  registerAnnot(doc, a.pageNum - 1, {
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Caret'),
    Rect: doc.context.obj([a.x, a.y, a.x + a.width, a.y + a.height]),
    C: mkC(doc, a.color),
    CA: PDFNumber.of(a.opacity),
    NM: PDFString.of(NM_PREFIX + a.id),
    F: PDFNumber.of(4),
  })
}

function writeMeasure(doc: PDFDocument, a: MeasureAnn) {
  if (a.points.length < 2) return
  const allX = a.points.map(p => p[0]), allY = a.points.map(p => p[1])
  const isLine = a.type === 'measure-distance'
  if (isLine) {
    const [p0, p1] = a.points
    registerAnnot(doc, a.pageNum - 1, {
      Type: PDFName.of('Annot'),
      Subtype: PDFName.of('Line'),
      Rect: doc.context.obj([
        Math.min(...allX) - 5, Math.min(...allY) - 5,
        Math.max(...allX) + 5, Math.max(...allY) + 5,
      ]),
      L: doc.context.obj([p0[0], p0[1], p1[0], p1[1]]),
      Contents: PDFString.of(a.label),
      BS: doc.context.obj({ W: PDFNumber.of(a.lineWidth) }),
      C: mkC(doc, a.color),
      CA: PDFNumber.of(a.opacity),
      NM: PDFString.of(NM_PREFIX + a.id),
      F: PDFNumber.of(4),
    })
  } else {
    registerAnnot(doc, a.pageNum - 1, {
      Type: PDFName.of('Annot'),
      Subtype: PDFName.of('Polygon'),
      Rect: doc.context.obj([
        Math.min(...allX) - 4, Math.min(...allY) - 4,
        Math.max(...allX) + 4, Math.max(...allY) + 4,
      ]),
      Vertices: doc.context.obj(a.points.flat()),
      Contents: PDFString.of(a.label),
      BS: doc.context.obj({ W: PDFNumber.of(a.lineWidth) }),
      C: mkC(doc, a.color),
      CA: PDFNumber.of(a.opacity),
      NM: PDFString.of(NM_PREFIX + a.id),
      F: PDFNumber.of(4),
    })
  }
}

function writeLink(doc: PDFDocument, a: LinkAnn) {
  const x1 = Math.min(a.x1, a.x2), y1 = Math.min(a.y1, a.y2)
  const x2 = Math.max(a.x1, a.x2), y2 = Math.max(a.y1, a.y2)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let action: any
  if (a.href) {
    action = doc.context.obj({
      Type: PDFName.of('Action'),
      S: PDFName.of('URI'),
      URI: PDFString.of(a.href),
    })
  } else if (a.destPage != null) {
    const pIdx = a.destPage - 1
    const pCount = doc.getPageCount()
    if (pIdx < 0 || pIdx >= pCount) return
    const pageRef = doc.getPage(pIdx).ref
    action = doc.context.obj({
      Type: PDFName.of('Action'),
      S: PDFName.of('GoTo'),
      D: doc.context.obj([pageRef, PDFName.of('XYZ'), PDFNumber.of(0), PDFNumber.of(9999), PDFNumber.of(0)]),
    })
  } else {
    return
  }
  registerAnnot(doc, a.pageNum - 1, {
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Link'),
    Rect: doc.context.obj([x1, y1, x2, y2]),
    A: action,
    Border: doc.context.obj([PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(1)]),
    C: mkC(doc, a.color || '#0000ff'),
    CA: PDFNumber.of(a.opacity),
    NM: PDFString.of(NM_PREFIX + a.id),
    F: PDFNumber.of(4),
    H: PDFName.of('I'),
  })
}

function base64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const [header, b64] = dataUrl.split(',')
  const mime = header.replace('data:', '').replace(';base64', '')
  const raw = atob(b64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return { bytes, mime }
}

export async function writeAnnotationsToPdf(
  bytes: Uint8Array,
  annotations: Annotation[]
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  doc.registerFontkit(fontkit)
  clearAll(doc)

  // Placed images AND image-bearing stamps (drawn/uploaded/typed signatures and
  // custom image stamps) go into the content stream, not the annotation array.
  // A /Stamp annotation that carries only a /Name has no artwork of its own, so
  // the viewer (or MuPDF's appearance synthesis) draws its built-in stamp for
  // that name instead. That is why a saved signature came back as "DRAFT".
  for (const ann of annotations) {
    if (ann.pageNum < 1 || ann.pageNum > doc.getPageCount()) continue

    let img: { url: string; x: number; y: number; width: number; height: number } | null = null
    if (ann.type === 'placed-image') {
      const a = ann as PlacedImageAnn
      img = { url: a.dataUrl, x: a.x, y: a.y, width: a.width, height: a.height }
    } else if (ann.type === 'stamp' && (ann as StampAnn).imageDataUrl) {
      const a = ann as StampAnn
      // StampAnn x/y is the centre of the stamp; drawImage takes bottom-left.
      img = {
        url: a.imageDataUrl as string,
        x: a.x - a.width / 2,
        y: a.y - a.height / 2,
        width: a.width,
        height: a.height,
      }
    }
    if (!img) continue

    const { bytes: imgBytes, mime } = dataUrlToBytes(img.url)
    const embeddedImg = mime === 'image/png'
      ? await doc.embedPng(imgBytes)
      : await doc.embedJpg(imgBytes)
    doc.getPage(ann.pageNum - 1).drawImage(embeddedImg, {
      x: img.x,
      y: img.y,
      width: img.width,
      height: img.height,
    })
  }

  // Edit-text replacements are baked into the content stream too (cover + new
  // text in the original font); fonts are embedded once and reused per program.
  const getFont = makeFontGetter(doc)
  const textEditFontCache = new Map<string, PDFFont>()
  for (const ann of annotations) {
    if (ann.type !== 'text-edit') continue
    if (ann.pageNum < 1 || ann.pageNum > doc.getPageCount()) continue
    await writeTextEdit(doc, ann as TextEditAnn, textEditFontCache)
  }

  for (const ann of annotations) {
    if (ann.pageNum < 1 || ann.pageNum > doc.getPageCount()) continue
    // Carry the tool identity and everything PDF.js will not hand back.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyAnn = ann as any
    pendingSidecar = { t: ann.type, o: ann.opacity }
    if (ann.type === 'callout') pendingSidecar.tip = [anyAnn.tipX, anyAnn.tipY]
    if (typeof anyAnn.unit === 'string') pendingSidecar.u = anyAnn.unit
    if (typeof anyAnn.fontSize === 'number') pendingSidecar.fs = anyAnn.fontSize
    switch (ann.type) {
      case 'highlight': case 'underline': case 'strikethrough':
        writeHighlight(doc, ann as HighlightAnn); break
      case 'ink':
        writeInk(doc, ann as InkAnn); break
      case 'rectangle': case 'ellipse': case 'line': case 'arrow':
        writeShape(doc, ann as ShapeAnn); break
      case 'textbox':
        await writeTextBox(doc, ann as TextBoxAnn, getFont); break
      case 'stickynote':
        writeStickyNote(doc, ann as StickyNoteAnn); break
      case 'stamp':
        // Image stamps are baked into the content stream above. Writing a
        // name-based annotation for them too would make the viewer paint its
        // own stamp artwork on top of the picture.
        if (!(ann as StampAnn).imageDataUrl) await writeStamp(doc, ann as StampAnn, getFont)
        break
      case 'redact':
        writeRedact(doc, ann as RedactAnn); break
      case 'typewriter':
        await writeTypewriter(doc, ann as TypewriterAnn, getFont); break
      case 'text-edit':
        break  // baked into the content stream above
      case 'callout':
        await writeCallout(doc, ann as CalloutAnn, getFont); break
      case 'cloud':
        writeCloud(doc, ann as CloudAnn); break
      case 'polygon': case 'polyline':
        writePoly(doc, ann as PolyAnn); break
      case 'caret':
        writeCaret(doc, ann as CaretAnn); break
      case 'measure-distance': case 'measure-area': case 'measure-perimeter':
        writeMeasure(doc, ann as MeasureAnn); break
      case 'link':
        writeLink(doc, ann as LinkAnn); break
      case 'placed-image':
        break  // handled above via content stream
    }
  }
  return doc.save()
}

// ── read ──────────────────────────────────────────────────────────────────────

// PDF.js v6 moved the annotation text from `contents` to `contentsObj.str`.
// Keep the old property as a fallback so an older build still reads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function annContents(a: any): string {
  const s = a?.contentsObj?.str ?? a?.contents
  return typeof s === 'string' ? s : ''
}

// PDF.js returns quadPoints, vertices and ink paths as Float32Array, and
// Array.isArray() is FALSE for a typed array. Every guard written that way threw
// the data away, which silently dropped highlights, underlines, strikethroughs,
// polygons, polylines and clouds on reopen. Normalise to a plain number[].
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function numArray(v: any): number[] {
  if (!v) return []
  if (Array.isArray(v)) return v.map(Number).filter(Number.isFinite)
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>)
  return []
}

// Pair a flat [x,y,x,y,…] run into points. Also accepts the {x,y} object form
// older PDF.js used for ink lists.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPoints(v: any): Array<[number, number]> {
  if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] !== null && 'x' in v[0]) {
    return v.map((p: { x: number; y: number }) => [p.x, p.y] as [number, number])
  }
  const flat = numArray(v)
  const out: Array<[number, number]> = []
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]])
  return out
}

// Read the /T sidecar we write. Restores the tool identity and the opacity that
// PDF.js does not report for most subtypes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function annSidecar(a: any): Sidecar | null {
  const t = a?.titleObj?.str
  if (typeof t !== 'string' || !t.startsWith(T_PREFIX)) return null
  try {
    const o = JSON.parse(t.slice(T_PREFIX.length))
    return o && typeof o.t === 'string' ? o as Sidecar : null
  } catch { return null }
}

// PDF.js hands colours back as a Uint8ClampedArray indexed [0][1][2], not as
// {r,g,b}. Reading .r/.g/.b gave undefined, so rgb255ToHex produced the invalid
// string "#NaNNaNNaN": SVG then dropped the stroke (no stamp border) and fell
// back to black text, which looked exactly like "the colour was lost on save".
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function annColor(c: any): string | null {
  if (!c) return null
  const r = c[0] ?? c.r, g = c[1] ?? c.g, b = c[2] ?? c.b
  if (![r, g, b].every(v => typeof v === 'number' && Number.isFinite(v))) return null
  return rgb255ToHex(r, g, b)
}

export async function readAnnotationsFromPdf(
  pdfDoc: PDFDocumentProxy,
  numPages: number
): Promise<Annotation[]> {
  const result: Annotation[] = []
  // Named-destination map (the /Names name tree, e.g. Word's "_Toc…" anchors).
  // Used to turn a link's named destination into a page number. Fetched once.
  let allDests: Record<string, unknown[]> = {}
  try { allDests = (await pdfDoc.getDestinations()) as Record<string, unknown[]> } catch { /* none */ }
  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum)
    const anns = await page.getAnnotations({ intent: 'display' })
    for (const a of anns) {
      try {
        const rawId = typeof a.id === 'string' ? a.id : ''
        const id = rawId.startsWith(NM_PREFIX)
          ? rawId.slice(NM_PREFIX.length)
          : newId()
        // PDF.js v6 exposes the annotation text as contentsObj.str; the old
        // `contents` string is gone. Reading the stale property returned
        // undefined for every text-bearing annotation, so reopening a saved file
        // silently emptied every typewriter, text box, sticky note and stamp.
        const contents = annContents(a)
        // /C is absent on our FreeText (it means background fill, not text
        // colour), so fall back to the colour carried in the /DA string.
        const daColor = (a as any).defaultAppearanceData?.fontColor
        const color = annColor(a.color) ?? annColor(daColor) ?? '#ffff00'
        // PDF.js only reports /CA for a few subtypes (Highlight, Ink); for the
        // rest it is undefined, so everything used to reload at the 0.7
        // fallback. Prefer the sidecar, then whatever PDF.js gives, then opaque.
        const side = annSidecar(a)
        const opacity = typeof side?.o === 'number' ? side.o
          : typeof a.opacity === 'number' ? a.opacity
            : 1
        const base = { id, pageNum, color, opacity, createdAt: Date.now() }

        switch (a.subtype) {
          case 'Highlight':
          case 'Underline':
          case 'StrikeOut': {
            const type = a.subtype === 'Highlight' ? 'highlight'
              : a.subtype === 'Underline' ? 'underline' : 'strikethrough' as const
            const rawQ = numArray(a.quadPoints)
            const quads: number[][] = []
            for (let i = 0; i + 7 < rawQ.length; i += 8) quads.push(rawQ.slice(i, i + 8))
            if (quads.length > 0)
              result.push({ ...base, type, quads, selectedText: contents } as any)
            break
          }
          case 'Ink': {
            // Each list is a flat Float32Array of x,y pairs. Mapping p.x/p.y over
            // it yielded [undefined, undefined] for every point, so reopened ink
            // strokes came back with garbage coordinates.
            const inkLists = (a.inkLists as unknown[] | undefined) || []
            const paths = inkLists.map(lst => toPoints(lst)).filter(pts => pts.length > 0)
            if (paths.length > 0)
              result.push({ ...base, type: 'ink', paths, lineWidth: a.borderStyle?.width ?? 2 })
            break
          }
          case 'Square': {
            // Skip white-cover rects written by text-edit
            if (rawId.endsWith('-cover')) break
            const [x1, y1, x2, y2] = a.rect as number[]
            result.push({ ...base, type: 'rectangle', x1, y1, x2, y2, lineWidth: a.borderStyle?.width ?? 2 })
            break
          }
          case 'Circle': {
            const [x1, y1, x2, y2] = a.rect as number[]
            result.push({ ...base, type: 'ellipse', x1, y1, x2, y2, lineWidth: a.borderStyle?.width ?? 2 })
            break
          }
          case 'Line': {
            const coords = (a.lineCoordinates as number[] | undefined) || (a.rect as number[])
            const isArrow = Array.isArray(a.lineEndings) &&
              a.lineEndings.some((e: string) => e === 'OpenArrow')
            if (side?.t === 'measure-distance') {
              result.push({
                ...base, type: 'measure-distance',
                points: [[coords[0], coords[1]], [coords[2], coords[3]]],
                label: contents, unit: (side.u ?? 'pt'),
                lineWidth: a.borderStyle?.width ?? 2,
              } as unknown as MeasureAnn)
            } else {
              result.push({
                ...base,
                type: isArrow ? 'arrow' : 'line',
                x1: coords[0], y1: coords[1], x2: coords[2], y2: coords[3],
                lineWidth: a.borderStyle?.width ?? 2,
              })
            }
            break
          }
          case 'FreeText': {
            const [x1, y1, x2, y2] = a.rect as number[]
            const fs = side?.fs ?? (a as any).defaultAppearanceData?.fontSize ?? 12
            // /IT and /CL are not exposed by PDF.js, so a typewriter and a
            // callout both used to reload as a plain text box. The sidecar keeps
            // the real tool, and the callout's leader tip with it.
            if (side?.t === 'typewriter') {
              result.push({ ...base, type: 'typewriter', x: x1, y: y1, text: contents, fontSize: fs } as TypewriterAnn)
            } else if (side?.t === 'callout' && side.tip) {
              result.push({
                ...base, type: 'callout',
                x: x1, y: y1, width: x2 - x1, height: y2 - y1,
                tipX: side.tip[0], tipY: side.tip[1],
                text: contents, fontSize: fs,
                lineWidth: a.borderStyle?.width ?? 1,
              } as CalloutAnn)
            } else {
              result.push({
                ...base, type: 'textbox',
                x: x1, y: y1, width: x2 - x1, height: y2 - y1,
                text: contents, fontSize: fs,
              })
            }
            break
          }
          case 'Text': {
            const [x, y] = a.rect as number[]
            result.push({ ...base, type: 'stickynote', x, y, text: contents })
            break
          }
          case 'Stamp': {
            const [x1, y1, x2, y2] = a.rect as number[]
            // The label lives in /Contents (we write it there). /Name is
            // deliberately absent so no viewer substitutes its own artwork, and
            // PDF.js does not surface it anyway, so reading a.name always gave
            // 'Draft' and every reopened stamp turned into DRAFT.
            const sn = (contents || (a as any).name || 'Draft') as any
            result.push({
              ...base, type: 'stamp',
              x: (x1 + x2) / 2, y: (y1 + y2) / 2,
              width: Math.max(80, x2 - x1), height: Math.max(30, y2 - y1),
              stampName: sn,
            })
            break
          }
          case 'Redact': {
            const [x1, y1, x2, y2] = a.rect as number[]
            result.push({ ...base, type: 'redact', x1, y1, x2, y2 } as RedactAnn)
            break
          }
          case 'Polygon': {
            const pts = toPoints((a as any).vertices)
            if (pts.length >= 2) {
              // /BE and /IT are not exposed by PDF.js, so a cloud used to reload
              // as a plain polygon. The sidecar carries the real tool.
              const isCloud = side?.t === 'cloud' || (a as any).borderEffect?.style === 'C'
              const isMeasure = side?.t?.startsWith('measure')
                || contents.includes(' pt') || contents.includes(' mm') || contents.includes(' in')
              if (isCloud) {
                result.push({ ...base, type: 'cloud', points: pts, lineWidth: a.borderStyle?.width ?? 2 } as CloudAnn)
              } else if (isMeasure) {
                result.push({ ...base, type: 'measure-perimeter', points: pts, lineWidth: a.borderStyle?.width ?? 2, label: contents, unit: 'pt' } as MeasureAnn)
              } else {
                result.push({ ...base, type: 'polygon', points: pts, lineWidth: a.borderStyle?.width ?? 2 } as PolyAnn)
              }
            }
            break
          }
          case 'PolyLine': {
            const pts = toPoints((a as any).vertices)
            if (pts.length >= 2)
              result.push({ ...base, type: 'polyline', points: pts, lineWidth: a.borderStyle?.width ?? 2 } as PolyAnn)
            break
          }
          case 'Caret': {
            const [x1, y1, x2, y2] = a.rect as number[]
            result.push({ ...base, type: 'caret', x: x1, y: y1, width: x2 - x1, height: y2 - y1 } as CaretAnn)
            break
          }
          case 'Link': {
            const [x1, y1, x2, y2] = a.rect as number[]
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const url: string | undefined = (a as any).url || (a as any).unsafeUrl || undefined
            // Internal GoTo links (e.g. a table-of-contents entry) carry a `dest`
            // instead of a URL. Resolve it to a 1-indexed page so clicking the
            // link can navigate within the document.
            let destPage: number | undefined
            if (!url) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const dest = (a as any).dest
              try {
                let explicit: unknown[] | null = null
                if (typeof dest === 'string') {
                  // Named destination: resolve via the document's destination map
                  // (handles the /Names name tree), falling back to the singular API.
                  const fromMap = allDests[dest]
                  if (Array.isArray(fromMap)) explicit = fromMap
                  else {
                    const resolved = await pdfDoc.getDestination(dest)
                    if (Array.isArray(resolved)) explicit = resolved
                  }
                } else if (Array.isArray(dest)) {
                  explicit = dest
                }
                if (explicit && explicit[0] && typeof explicit[0] === 'object') {
                  const pageIdx = await pdfDoc.getPageIndex(
                    explicit[0] as Parameters<typeof pdfDoc.getPageIndex>[0]
                  )
                  destPage = pageIdx + 1
                }
              } catch { /* unresolvable destination */ }
            }
            result.push({
              ...base,
              type: 'link',
              color: base.color !== '#ffff00' ? base.color : '#0000ff',
              opacity: 0.3,
              x1, y1, x2, y2,
              href: url,
              destPage,
            } as LinkAnn)
            break
          }
        }
      } catch { /* skip malformed */ }
    }
  }
  return result
}
