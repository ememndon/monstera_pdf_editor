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

// Pick the base-14 variant (regular/bold/italic/bold-italic) of a family so a
// cover-and-replace text edit can match the original weight/slant when baked.
function stdFontVariant(family?: string, bold?: boolean, italic?: boolean): string {
  if (daFont(family) === 'Times-Roman')
    return bold && italic ? 'Times-BoldItalic' : bold ? 'Times-Bold' : italic ? 'Times-Italic' : 'Times-Roman'
  if (daFont(family) === 'Courier')
    return bold && italic ? 'Courier-BoldOblique' : bold ? 'Courier-Bold' : italic ? 'Courier-Oblique' : 'Courier'
  return bold && italic ? 'Helvetica-BoldOblique' : bold ? 'Helvetica-Bold' : italic ? 'Helvetica-Oblique' : 'Helvetica'
}

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
  const ref = doc.context.register(doc.context.obj(dictLiteral))
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

function writeTextBox(doc: PDFDocument, a: TextBoxAnn) {
  registerAnnot(doc, a.pageNum - 1, {
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('FreeText'),
    Rect: doc.context.obj([a.x, a.y, a.x + a.width, a.y + a.height]),
    Contents: PDFString.of(a.text),
    DA: PDFString.of(`/${daFont(a.font)} ${a.fontSize} Tf`),
    BS: doc.context.obj({ W: PDFNumber.of(1) }),
    C: mkC(doc, a.color),
    CA: PDFNumber.of(a.opacity),
    NM: PDFString.of(NM_PREFIX + a.id),
    F: PDFNumber.of(4),
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

function writeTypewriter(doc: PDFDocument, a: TypewriterAnn) {
  // Typewriter saves as FreeText with transparent background (no border, no fill)
  registerAnnot(doc, a.pageNum - 1, {
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('FreeText'),
    Rect: doc.context.obj([a.x, a.y, a.x + 400, a.y + a.fontSize * 2]),
    Contents: PDFString.of(a.text),
    DA: PDFString.of(`/${daFont(a.font)} ${a.fontSize} Tf`),
    BS: doc.context.obj({ W: PDFNumber.of(0) }),
    C: mkC(doc, a.color),
    CA: PDFNumber.of(a.opacity),
    NM: PDFString.of(NM_PREFIX + a.id),
    F: PDFNumber.of(4),
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

function writeStamp(doc: PDFDocument, a: StampAnn) {
  const nameMap: Record<string, string> = {
    Approved: 'Approved', Draft: 'Draft', Confidential: 'Confidential',
    Rejected: 'Rejected', Custom: 'NotApproved',
  }
  registerAnnot(doc, a.pageNum - 1, {
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Stamp'),
    Rect: doc.context.obj([
      a.x - a.width / 2, a.y - a.height / 2,
      a.x + a.width / 2, a.y + a.height / 2,
    ]),
    Name: PDFName.of(nameMap[a.stampName] || 'Draft'),
    C: mkC(doc, a.color),
    CA: PDFNumber.of(a.opacity),
    Contents: PDFString.of(a.stampName),
    NM: PDFString.of(NM_PREFIX + a.id),
    F: PDFNumber.of(4),
  })
}

function writeCallout(doc: PDFDocument, a: CalloutAnn) {
  const x2 = a.x + a.width, y2 = a.y + a.height
  registerAnnot(doc, a.pageNum - 1, {
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('FreeText'),
    Rect: doc.context.obj([a.x, a.y, x2, y2]),
    Contents: PDFString.of(a.text),
    DA: PDFString.of(`/${daFont(a.font)} ${a.fontSize} Tf`),
    BS: doc.context.obj({ W: PDFNumber.of(a.lineWidth) }),
    C: mkC(doc, a.color),
    CA: PDFNumber.of(a.opacity),
    CL: doc.context.obj([a.tipX, a.tipY, a.x, (a.y + y2) / 2]),
    IT: PDFName.of('FreeTextCallout'),
    NM: PDFString.of(NM_PREFIX + a.id),
    F: PDFNumber.of(4),
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
  const textEditFontCache = new Map<string, PDFFont>()
  for (const ann of annotations) {
    if (ann.type !== 'text-edit') continue
    if (ann.pageNum < 1 || ann.pageNum > doc.getPageCount()) continue
    await writeTextEdit(doc, ann as TextEditAnn, textEditFontCache)
  }

  for (const ann of annotations) {
    if (ann.pageNum < 1 || ann.pageNum > doc.getPageCount()) continue
    switch (ann.type) {
      case 'highlight': case 'underline': case 'strikethrough':
        writeHighlight(doc, ann as HighlightAnn); break
      case 'ink':
        writeInk(doc, ann as InkAnn); break
      case 'rectangle': case 'ellipse': case 'line': case 'arrow':
        writeShape(doc, ann as ShapeAnn); break
      case 'textbox':
        writeTextBox(doc, ann as TextBoxAnn); break
      case 'stickynote':
        writeStickyNote(doc, ann as StickyNoteAnn); break
      case 'stamp':
        // Image stamps are baked into the content stream above. Writing a
        // name-based annotation for them too would make the viewer paint its
        // own stamp artwork on top of the picture.
        if (!(ann as StampAnn).imageDataUrl) writeStamp(doc, ann as StampAnn)
        break
      case 'redact':
        writeRedact(doc, ann as RedactAnn); break
      case 'typewriter':
        writeTypewriter(doc, ann as TypewriterAnn); break
      case 'text-edit':
        break  // baked into the content stream above
      case 'callout':
        writeCallout(doc, ann as CalloutAnn); break
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
        const color = a.color
          ? rgb255ToHex(a.color.r, a.color.g, a.color.b)
          : '#ffff00'
        const opacity = typeof a.opacity === 'number' ? a.opacity : 0.7
        const base = { id, pageNum, color, opacity, createdAt: Date.now() }

        switch (a.subtype) {
          case 'Highlight':
          case 'Underline':
          case 'StrikeOut': {
            const type = a.subtype === 'Highlight' ? 'highlight'
              : a.subtype === 'Underline' ? 'underline' : 'strikethrough' as const
            const rawQ: number[] = Array.isArray(a.quadPoints) ? a.quadPoints : []
            const quads: number[][] = []
            for (let i = 0; i + 7 < rawQ.length; i += 8) quads.push(rawQ.slice(i, i + 8))
            if (quads.length > 0)
              result.push({ ...base, type, quads, selectedText: a.contents || '' } as any)
            break
          }
          case 'Ink': {
            const inkLists = (a.inkLists as Array<Array<{x:number;y:number}>> | undefined) || []
            const paths = inkLists.map(lst => lst.map(p => [p.x, p.y] as [number, number]))
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
            result.push({
              ...base,
              type: isArrow ? 'arrow' : 'line',
              x1: coords[0], y1: coords[1], x2: coords[2], y2: coords[3],
              lineWidth: a.borderStyle?.width ?? 2,
            })
            break
          }
          case 'FreeText': {
            const [x1, y1, x2, y2] = a.rect as number[]
            result.push({
              ...base, type: 'textbox',
              x: x1, y: y1, width: x2 - x1, height: y2 - y1,
              text: a.contents || '',
              fontSize: (a as any).defaultAppearanceData?.fontSize ?? 12,
            })
            break
          }
          case 'Text': {
            const [x, y] = a.rect as number[]
            result.push({ ...base, type: 'stickynote', x, y, text: a.contents || '' })
            break
          }
          case 'Stamp': {
            const [x1, y1, x2, y2] = a.rect as number[]
            const sn = (a.name || 'Draft') as any
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
            const rawVerts: number[] = Array.isArray((a as any).vertices) ? (a as any).vertices : []
            const pts: Array<[number,number]> = []
            for (let vi = 0; vi + 1 < rawVerts.length; vi += 2) pts.push([rawVerts[vi], rawVerts[vi+1]])
            if (pts.length >= 2) {
              const isCloud = (a as any).borderEffect?.style === 'C'
              const isMeasure = typeof a.contents === 'string' && (a.contents.includes(' pt') || a.contents.includes(' mm') || a.contents.includes(' in'))
              if (isCloud) {
                result.push({ ...base, type: 'cloud', points: pts, lineWidth: a.borderStyle?.width ?? 2 } as CloudAnn)
              } else if (isMeasure) {
                result.push({ ...base, type: 'measure-perimeter', points: pts, lineWidth: a.borderStyle?.width ?? 2, label: a.contents || '', unit: 'pt' } as MeasureAnn)
              } else {
                result.push({ ...base, type: 'polygon', points: pts, lineWidth: a.borderStyle?.width ?? 2 } as PolyAnn)
              }
            }
            break
          }
          case 'PolyLine': {
            const rawVerts: number[] = Array.isArray((a as any).vertices) ? (a as any).vertices : []
            const pts: Array<[number,number]> = []
            for (let vi = 0; vi + 1 < rawVerts.length; vi += 2) pts.push([rawVerts[vi], rawVerts[vi+1]])
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
