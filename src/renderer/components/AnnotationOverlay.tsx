import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { usePdfStore } from '../store/usePdfStore'
import { useSettingsStore } from '../store/useSettingsStore'
import ContextMenu, { type ContextMenuEntry } from './ContextMenu'
import { canvasToPdf, pdfToCanvas, newId } from '../utils/annotationUtils'
import { loadPdfFont, bytesToBase64 } from '../utils/pdfFonts'
import { logger } from '../utils/logger'
import { copyText } from '../utils/copyText'
import type {
  Annotation, HighlightAnn, InkAnn,
  ShapeAnn, TextBoxAnn, StickyNoteAnn, StampAnn, RedactAnn,
  TypewriterAnn, TextEditAnn, PlacedImageAnn,
  CalloutAnn, CloudAnn, PolyAnn, CaretAnn, MeasureAnn, LinkAnn,
} from '../types/annotations'

interface Props {
  pageNum: number
  scale: number
  pageW: number
  pageH: number
}

type DrawPhase =
  | { k: 'idle' }
  | { k: 'shape'; sx: number; sy: number; cx: number; cy: number }
  | { k: 'ink'; cur: Array<[number, number]>; done: Array<Array<[number, number]>> }
  | { k: 'textbox-size'; sx: number; sy: number; cx: number; cy: number }
  | { k: 'textbox-edit'; x: number; y: number; w: number; h: number; text: string }
  | { k: 'typewriter-edit'; x: number; y: number; text: string }
  | { k: 'text-edit-size'; sx: number; sy: number; cx: number; cy: number }
  | { k: 'text-edit-edit'; x: number; y: number; w: number; h: number; text: string; fontSize?: number; color?: string; bg?: string; fontFamily?: string; fontDataB64?: string; baselineX?: number; baselineY?: number; linePoint?: { x: number; y: number }; lineBBox?: { x1: number; y1: number; x2: number; y2: number }; editPoint?: { x: number; y: number }; editRect?: { x1: number; y1: number; x2: number; y2: number }; sample?: FontSample }
  | { k: 'callout-size'; sx: number; sy: number; cx: number; cy: number }
  | { k: 'callout-edit'; x: number; y: number; w: number; h: number; text: string; tipSvgX: number; tipSvgY: number }
  | { k: 'poly'; pts: Array<[number, number]>; curX: number; curY: number }
  | { k: 'link-pending'; x1: number; y1: number; x2: number; y2: number; href: string; destPage: string }
  | { k: 'snapshot'; sx: number; sy: number; cx: number; cy: number }

type ImageDrag =
  | { k: 'idle' }
  | { k: 'move'; id: string; startSvgX: number; startSvgY: number; origAnnX: number; origAnnY: number }
  | { k: 'resize'; id: string; corner: 'br'; startSvgX: number; startSvgY: number; origW: number; origH: number }

type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

// Handle layout: fractional position within the selection box + the cursor it shows.
const RESIZE_HANDLES: { h: ResizeHandle; fx: number; fy: number; cursor: string }[] = [
  { h: 'nw', fx: 0,   fy: 0,   cursor: 'nwse-resize' },
  { h: 'n',  fx: 0.5, fy: 0,   cursor: 'ns-resize' },
  { h: 'ne', fx: 1,   fy: 0,   cursor: 'nesw-resize' },
  { h: 'e',  fx: 1,   fy: 0.5, cursor: 'ew-resize' },
  { h: 'se', fx: 1,   fy: 1,   cursor: 'nwse-resize' },
  { h: 's',  fx: 0.5, fy: 1,   cursor: 'ns-resize' },
  { h: 'sw', fx: 0,   fy: 1,   cursor: 'nesw-resize' },
  { h: 'w',  fx: 0,   fy: 0.5, cursor: 'ew-resize' },
]

// Annotation types that support box-resize via handles. (placed-image keeps its own
// corner handle; stickynote is a fixed icon; markup is bound to the underlying text.)
const RESIZABLE_TYPES = new Set([
  'rectangle', 'ellipse', 'line', 'arrow', 'redact', 'link',
  'textbox', 'text-edit', 'callout', 'stamp', 'ink', 'placed-image',
  'polygon', 'polyline', 'cloud',
  'measure-distance', 'measure-area', 'measure-perimeter', 'typewriter',
])

// PDFium engine availability (true in-place text editing), cached per session.
let _pdfiumAvail: boolean | null = null
async function pdfiumReady(): Promise<boolean> {
  if (_pdfiumAvail !== null) return _pdfiumAvail
  try { _pdfiumAvail = (await window.electronAPI.pdfiumStatus()).available }
  catch { _pdfiumAvail = false }
  return _pdfiumAvail
}

// Map a base-14 font family to its CSS equivalent for on-canvas rendering.
function cssFont(font?: string): string {
  if (font === 'Times-Roman') return 'serif'
  if (font === 'Courier') return 'monospace'
  return 'sans-serif'
}

export interface FontSample {
  cssFamily: string                                   // computed font-family list (reuse PDF.js face)
  fontName: 'Helvetica' | 'Times-Roman' | 'Courier'   // base-14 family for baking
  bold: boolean
  italic: boolean
}

// Sample the typeface of a rendered PDF.js text-layer span so the cover-and-
// replace fallback can redraw in a matching font (not a generic serif). PDF.js
// bakes weight/slant into its loaded face, so the computed weight is usually 400
// even for bold text — we confirm boldness by width, since bold glyphs are wider.
function classifyFont(cs: CSSStyleDeclaration, text: string, widthPx: number, sizePx: number): FontSample {
  const fam = cs.fontFamily || 'sans-serif'
  const lower = fam.toLowerCase()
  const generic: 'serif' | 'sans-serif' | 'monospace' =
    lower.includes('monospace') ? 'monospace'
      : lower.includes('sans-serif') || lower.includes('sans') ? 'sans-serif'
        : lower.includes('serif') ? 'serif' : 'sans-serif'
  const fontName = generic === 'serif' ? 'Times-Roman' : generic === 'monospace' ? 'Courier' : 'Helvetica'
  const italic = /italic|oblique/.test(cs.fontStyle)
  let bold = parseInt(cs.fontWeight, 10) >= 600 || cs.fontWeight === 'bold'
  if (!bold && text.trim() && widthPx > 0 && sizePx > 0) {
    try {
      const ctx = document.createElement('canvas').getContext('2d')
      if (ctx) {
        ctx.font = `400 ${sizePx}px ${generic}`; const wn = ctx.measureText(text).width
        ctx.font = `700 ${sizePx}px ${generic}`; const wb = ctx.measureText(text).width
        if (wb > wn + 0.5) bold = Math.abs(widthPx - wb) < Math.abs(widthPx - wn)
      }
    } catch { /* keep the style-weight result */ }
  }
  return { cssFamily: fam, fontName, bold, italic }
}

// Renders a committed text-edit replacement onto a <canvas> and shows it as an
// <image>. Canvas reliably paints fonts added via document.fonts (an SVG <div>
// in <foreignObject> does not always repaint when a face activates), and lets us
// scale each line to fit the cell so a substitute font can never wrap-and-clip
// (the "13-3/8 → 13-" truncation). Rasterised at devicePixelRatio so it stays
// crisp; the saved PDF still uses real vector text via pdf-lib.
function TextEditRaster({ a, x, y, w, h, scale }: {
  a: TextEditAnn; x: number; y: number; w: number; h: number; scale: number
}) {
  const [href, setHref] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const fontPx = (a.fontSize || 12) * scale
    const useFace = !!(a.fontFamily || a.cssFamily)   // a loaded/PDF.js face encodes weight+slant
    const weight = useFace ? '' : (a.bold ? '700 ' : '')
    const style = useFace ? '' : (a.italic ? 'italic ' : '')
    const stack = a.fontFamily
      ? `'${a.fontFamily}', ${a.cssFamily ?? cssFont(a.font)}`
      : (a.cssFamily ?? cssFont(a.font))
    const fontStr = `${style}${weight}${fontPx}px ${stack}`
    ;(async () => {
      try { await document.fonts.load(fontStr, a.text || ' ') } catch { /* paint with whatever resolves */ }
      if (cancelled) return
      const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3)
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.ceil(w * dpr))
      canvas.height = Math.max(1, Math.ceil(h * dpr))
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.scale(dpr, dpr)
      ctx.font = fontStr
      ctx.textBaseline = 'top'
      ctx.fillStyle = a.color || '#000'
      const padX = 2
      const lh = fontPx * 1.2
      const leadTop = (lh - fontPx) / 2     // match the old div's line-height centring
      const maxW = Math.max(1, w - padX * 2)
      ;(a.text || '').split('\n').forEach((line, i) => {
        const mw = ctx.measureText(line).width
        const xs = mw > maxW && mw > 0 ? maxW / mw : 1   // squeeze to fit, never overflow
        ctx.save()
        ctx.translate(padX, i * lh + leadTop)
        if (xs !== 1) ctx.scale(xs, 1)
        ctx.fillText(line, 0, 0)
        ctx.restore()
      })
      if (!cancelled) setHref(canvas.toDataURL())
    })()
    return () => { cancelled = true }
  }, [a.text, a.fontFamily, a.cssFamily, a.font, a.fontSize, a.color, a.bold, a.italic, w, h, scale])
  if (!href) return null
  return <image href={href} x={x} y={y} width={w} height={h} preserveAspectRatio="none" opacity={a.opacity} />
}


// ── Helpers ─────────────────────────────────────────────────────────────────

function StampShape({ color, stampName, w, h }: { color: string; stampName: string; w: number; h: number }) {
  return (
    <>
      <rect x={-w / 2} y={-h / 2} width={w} height={h} fill="none" stroke={color} strokeWidth={2} rx={4} />
      <text textAnchor="middle" dominantBaseline="middle" fill={color}
        fontSize={Math.min(h * 0.6, 18)} fontWeight="bold" fontFamily="sans-serif" letterSpacing={1}>
        {stampName.toUpperCase()}
      </text>
    </>
  )
}

function makeCloudPath(svgPts: Array<[number, number]>, close = true): string {
  if (svgPts.length < 2) return ''
  const pts = close ? [...svgPts, svgPts[0]] : svgPts
  let d = `M${svgPts[0][0].toFixed(1)},${svgPts[0][1].toFixed(1)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i], p1 = pts[i + 1]
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1]
    const len = Math.sqrt(dx * dx + dy * dy)
    const bumps = Math.max(1, Math.round(len / 14))
    for (let b = 0; b < bumps; b++) {
      const t1 = (b + 1) / bumps
      const ex = p0[0] + dx * t1, ey = p0[1] + dy * t1
      const r = (len / bumps / 2).toFixed(1)
      d += ` A${r},${r} 0 0,0 ${ex.toFixed(1)},${ey.toFixed(1)}`
    }
  }
  if (close) d += ' Z'
  return d
}

function measureLabel(
  type: 'measure-distance' | 'measure-area' | 'measure-perimeter',
  pts: Array<[number, number]>,
  unit: string,
  scale = 1
): string {
  if (type === 'measure-distance' && pts.length >= 2) {
    const dx = pts[1][0] - pts[0][0], dy = pts[1][1] - pts[0][1]
    const d = Math.sqrt(dx * dx + dy * dy) * scale
    return `${d.toFixed(2)} ${unit}`
  }
  if (type === 'measure-perimeter' && pts.length >= 2) {
    let total = 0
    for (let i = 0; i < pts.length; i++) {
      const p0 = pts[i], p1 = pts[(i + 1) % pts.length]
      const dx = p1[0] - p0[0], dy = p1[1] - p0[1]
      total += Math.sqrt(dx * dx + dy * dy)
    }
    return `P: ${(total * scale).toFixed(2)} ${unit}`
  }
  if (type === 'measure-area' && pts.length >= 3) {
    let area = 0
    for (let i = 0; i < pts.length; i++) {
      const p0 = pts[i], p1 = pts[(i + 1) % pts.length]
      area += p0[0] * p1[1] - p1[0] * p0[1]
    }
    return `A: ${(Math.abs(area) / 2 * scale * scale).toFixed(2)} ${unit}²`
  }
  return ''
}

// Translate any annotation by (dx, dy) in PDF points. Returns a patch for
// updateAnnotation that shifts every geometry field the type uses.
function translatePatch(ann: Annotation, dx: number, dy: number): Partial<Annotation> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = ann as any
  switch (ann.type) {
    case 'rectangle': case 'ellipse': case 'line': case 'arrow': case 'redact': case 'link':
      return { x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy } as Partial<Annotation>
    case 'highlight': case 'underline': case 'strikethrough':
      return { quads: a.quads.map((q: number[]) =>
        [q[0]+dx, q[1]+dy, q[2]+dx, q[3]+dy, q[4]+dx, q[5]+dy, q[6]+dx, q[7]+dy]) } as Partial<Annotation>
    case 'ink':
      return { paths: a.paths.map((p: Array<[number, number]>) =>
        p.map(([x, y]) => [x + dx, y + dy] as [number, number])) } as Partial<Annotation>
    case 'polygon': case 'polyline': case 'cloud':
    case 'measure-distance': case 'measure-area': case 'measure-perimeter':
      return { points: a.points.map(([x, y]: [number, number]) =>
        [x + dx, y + dy] as [number, number]) } as Partial<Annotation>
    case 'callout':
      return { x: a.x + dx, y: a.y + dy, tipX: a.tipX + dx, tipY: a.tipY + dy } as Partial<Annotation>
    default:
      // x/y-anchored: stickynote, stamp, typewriter, textbox, text-edit, caret, placed-image
      return { x: a.x + dx, y: a.y + dy } as Partial<Annotation>
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function AnnotationOverlay({ pageNum, scale, pageW, pageH }: Props) {
  const { settings } = useSettingsStore()
  const measureUnit = settings.measureUnit ?? 'pt'
  const measureScale = settings.measureScale ?? 1

  const activeTool = usePdfStore(s => s.activeTool)
  const panMode = usePdfStore(s => s.panMode)
  const annotations = usePdfStore(s => s.annotations)
  const selectedAnnotationId = usePdfStore(s => s.selectedAnnotationId)
  const toolColor = usePdfStore(s => s.toolColor)
  const toolOpacity = usePdfStore(s => s.toolOpacity)
  const toolLineWidth = usePdfStore(s => s.toolLineWidth)
  const toolFontSize = usePdfStore(s => s.toolFontSize)
  const toolFont = usePdfStore(s => s.toolFont)
  const stampName = usePdfStore(s => s.stampName)
  const customStampDataUrl = usePdfStore(s => s.customStampDataUrl)
  const openStickyNoteId = usePdfStore(s => s.openStickyNoteId)
  const redactBlurred = usePdfStore(s => s.redactBlurred)

  const addAnnotation = usePdfStore(s => s.addAnnotation)
  const updateAnnotation = usePdfStore(s => s.updateAnnotation)
  const deleteAnnotation = usePdfStore(s => s.deleteAnnotation)
  const setSelectedAnnotation = usePdfStore(s => s.setSelectedAnnotation)
  const setOpenStickyNote = usePdfStore(s => s.setOpenStickyNote)
  const copyAnnotation = usePdfStore(s => s.copyAnnotation)
  const pasteAnnotation = usePdfStore(s => s.pasteAnnotation)
  const duplicateAnnotation = usePdfStore(s => s.duplicateAnnotation)
  const bringAnnotationToFront = usePdfStore(s => s.bringAnnotationToFront)
  const sendAnnotationToBack = usePdfStore(s => s.sendAnnotationToBack)
  const annotationClipboard = usePdfStore(s => s.annotationClipboard)

  const svgRef = useRef<SVGSVGElement>(null)
  const lastNudgeRef = useRef(0)   // groups an arrow-key nudge burst into one undo step
  const cancelEditRef = useRef(false)
  const [draw, setDraw] = useState<DrawPhase>({ k: 'idle' })
  const [imgDrag, setImgDrag] = useState<ImageDrag>({ k: 'idle' })
  // Outlines of every editable text object on this page, shown while the Edit Text
  // tool is active (PDF-XChange style) so the user can see what's clickable.
  const [editBoxes, setEditBoxes] = useState<{ x1: number; y1: number; x2: number; y2: number; nested: boolean }[]>([])
  // Drag-to-move for a selected annotation (any type except placed-image, which
  // has its own move/resize handles). Uses window listeners so it works even in
  // text-select mode where the overlay SVG is otherwise pointer-events:none.
  const moveRef = useRef<{ id: string; sx: number; sy: number; orig: Annotation; moved: boolean } | null>(null)
  // Resize a selected annotation by dragging one of its 8 handles.
  const resizeRef = useRef<{
    id: string; handle: ResizeHandle; origAnn: Annotation;
    origSvg: { x: number; y: number; w: number; h: number }; startX: number; startY: number; pushed: boolean
  } | null>(null)
  // Right-click context menus (annotation actions, and text-selection actions).
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; annId: string | null } | null>(null)
  const [textMenu, setTextMenu] = useState<{ x: number; y: number } | null>(null)

  const W = pageW * scale
  const H = pageH * scale

  const pageAnnotations = annotations.filter(a => a.pageNum === pageNum)

  // Tool categories
  const POLY_TOOLS = ['polygon', 'polyline', 'cloud', 'measure-distance', 'measure-area', 'measure-perimeter']
  const isPolyTool = POLY_TOOLS.includes(activeTool ?? '')
  const isMarkupTool = activeTool === 'highlight' || activeTool === 'underline' || activeTool === 'strikethrough'
  const isTypewriterTool = activeTool === 'typewriter'
  const isTextEditTool = activeTool === 'text-edit'
  const isCalloutTool = activeTool === 'callout'
  const isCaretTool = activeTool === 'caret'

  // Drag-based drawing tools (all except select, eraser, markup, typewriter, caret, poly)
  const isDragDrawTool = activeTool !== null &&
    !['select', 'eraser', 'highlight', 'underline', 'strikethrough',
      'typewriter', 'place-image', 'caret', 'object-edit', ...POLY_TOOLS].includes(activeTool)

  // ── Coordinate helpers ──────────────────────────────────────────────────

  const toPdf = useCallback((svgX: number, svgY: number) =>
    canvasToPdf(svgX, svgY, scale, pageH), [scale, pageH])

  const toSvg = useCallback((pdfX: number, pdfY: number) =>
    pdfToCanvas(pdfX, pdfY, scale, pageH), [scale, pageH])

  // Fetch editable-text outlines when the Edit Text tool turns on (cleared when
  // off). Only in-view pages mount this overlay, so the work stays bounded.
  useEffect(() => {
    if (!isTextEditTool) { setEditBoxes([]); return }
    let cancelled = false
    ;(async () => {
      try {
        if (!(await pdfiumReady())) return
        const bytes = usePdfStore.getState().pdfBytes
        if (!bytes) return
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        const boxes = await window.electronAPI.pdfiumTextBoxes(ab, pageNum - 1)
        if (!cancelled) setEditBoxes(boxes)
      } catch { if (!cancelled) setEditBoxes([]) }
    })()
    return () => { cancelled = true }
  }, [isTextEditTool, pageNum])

  const getSvgXY = (e: React.MouseEvent): [number, number] => {
    const rect = svgRef.current!.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }

  // Edit Text: read the original text + its font size/colour that lie under a
  // dragged region (from the PDF.js text layer) so the edit box is pre-filled
  // with the existing words instead of forcing the user to retype from scratch.
  const readRegionText = (sx: number, sy: number, ex: number, ey: number):
    { text: string; fontSize?: number; color?: string; bg?: string; sample?: FontSample } => {
    const svg = svgRef.current
    const wrapper = svg?.closest('.pdf-page-wrapper')
    const layer = wrapper?.querySelector<HTMLElement>('.text-layer')
    const svgRect = svg?.getBoundingClientRect()
    if (!layer || !svgRect) return { text: '' }
    const selL = svgRect.left + Math.min(sx, ex)
    const selR = svgRect.left + Math.max(sx, ex)
    const selT = svgRect.top + Math.min(sy, ey)
    const selB = svgRect.top + Math.max(sy, ey)
    const spans = Array.from(layer.querySelectorAll<HTMLElement>('span'))
    const hits: { el: HTMLElement; r: DOMRect }[] = []
    for (const el of spans) {
      if (!el.textContent) continue
      const r = el.getBoundingClientRect()
      // intersection test (require meaningful vertical + horizontal overlap)
      const ox = Math.min(selR, r.right) - Math.max(selL, r.left)
      const oy = Math.min(selB, r.bottom) - Math.max(selT, r.top)
      if (ox > 1 && oy > r.height * 0.3) hits.push({ el, r })
    }
    if (hits.length === 0) return { text: '' }
    // Group into lines by vertical position, then order left→right
    hits.sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)
    const lines: { y: number; items: typeof hits }[] = []
    for (const h of hits) {
      const line = lines.find(l => Math.abs(l.y - h.r.top) < h.r.height * 0.6)
      if (line) line.items.push(h)
      else lines.push({ y: h.r.top, items: [h] })
    }
    const text = lines
      .map(l => l.items.sort((a, b) => a.r.left - b.r.left).map(i => i.el.textContent).join(''))
      .join('\n')
      .replace(/\s+\n/g, '\n').trim()
    const cs = getComputedStyle(hits[0].el)
    const pxToHex = (c: string): string | undefined => {
      const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
      if (!m) return undefined
      const h = (n: string) => parseInt(n, 10).toString(16).padStart(2, '0')
      return `#${h(m[1])}${h(m[2])}${h(m[3])}`
    }
    const fontPx = parseFloat(cs.fontSize)
    return {
      text,
      fontSize: fontPx > 0 ? Math.round((fontPx / scale) * 10) / 10 : undefined,
      color: sampleInkColor(hits[0].r) ?? pxToHex(cs.color),
      sample: classifyFont(cs, hits[0].el.textContent ?? '', hits[0].r.width, fontPx),
    }
  }

  // Text-layer spans are color:transparent, so CSS can never tell us the real
  // ink colour — sample it from the rendered page canvas instead: histogram the
  // non-background pixels inside the rect and take the most common colour.
  const sampleInkColor = (clientRect: { left: number; top: number; width: number; height: number }): string | undefined => {
    const wrapper = svgRef.current?.closest('.pdf-page-wrapper')
    const canvas = wrapper?.querySelector<HTMLCanvasElement>('.pdf-page-canvas')
    if (!canvas) return undefined
    const cr = canvas.getBoundingClientRect()
    if (cr.width <= 0 || cr.height <= 0) return undefined
    const fx = canvas.width / cr.width, fy = canvas.height / cr.height
    const x = Math.max(0, Math.round((clientRect.left - cr.left) * fx))
    const y = Math.max(0, Math.round((clientRect.top - cr.top) * fy))
    const w = Math.min(canvas.width - x, Math.max(1, Math.round(clientRect.width * fx)))
    const h = Math.min(canvas.height - y, Math.max(1, Math.round(clientRect.height * fy)))
    if (w <= 0 || h <= 0) return undefined
    try {
      const data = canvas.getContext('2d')?.getImageData(x, y, w, h).data
      if (!data) return undefined
      const counts = new Map<string, number>()
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2]
        if (r > 235 && g > 235 && b > 235) continue
        // quantise so antialiased edge pixels pool with the core ink colour
        const key = `${r >> 4},${g >> 4},${b >> 4}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      let best: string | null = null, bestN = 0
      for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n }
      if (!best || bestN < 4) return undefined
      const [r, g, b] = best.split(',').map(v => (parseInt(v, 10) << 4) + 8)
      const hex = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')
      return `#${hex(r)}${hex(g)}${hex(b)}`
    } catch { return undefined }
  }

  // Find the single text-layer run under a click point. Used as the cover-and-
  // replace fallback for the Edit Text tool when PDFium is unavailable (or finds
  // no object), so clicking text always opens an editor instead of doing nothing.
  const readTextSpanAt = (sx: number, sy: number):
    { text: string; x: number; y: number; w: number; h: number; fontSize?: number; color?: string; sample?: FontSample } | null => {
    const svg = svgRef.current
    const layer = svg?.closest('.pdf-page-wrapper')?.querySelector<HTMLElement>('.text-layer')
    const svgRect = svg?.getBoundingClientRect()
    if (!layer || !svgRect) return null
    const ptX = svgRect.left + sx, ptY = svgRect.top + sy
    let best: { el: HTMLElement; r: DOMRect } | null = null
    for (const el of Array.from(layer.querySelectorAll<HTMLElement>('span'))) {
      if (!el.textContent?.trim()) continue
      const r = el.getBoundingClientRect()
      if (ptX >= r.left - 1 && ptX <= r.right + 1 && ptY >= r.top - 2 && ptY <= r.bottom + 2) { best = { el, r }; break }
    }
    if (!best) return null
    const cs = getComputedStyle(best.el)
    const pxToHex = (c: string): string | undefined => {
      const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
      if (!m) return undefined
      const h = (n: string) => parseInt(n, 10).toString(16).padStart(2, '0')
      return `#${h(m[1])}${h(m[2])}${h(m[3])}`
    }
    const fontPx = parseFloat(cs.fontSize)
    return {
      text: best.el.textContent ?? '',
      x: best.r.left - svgRect.left,
      y: best.r.top - svgRect.top,
      w: best.r.width,
      h: best.r.height,
      fontSize: fontPx > 0 ? Math.round((fontPx / scale) * 10) / 10 : undefined,
      color: sampleInkColor(best.r) ?? pxToHex(cs.color),
      sample: classifyFont(cs, best.el.textContent ?? '', best.r.width, fontPx),
    }
  }

  // Choose the font for a cover-and-replace edit. Prefer an INSTALLED system font
  // matching the original (complete glyph set → renders on screen by family name
  // and embeds cleanly into the saved PDF); fall back to the embedded program
  // (which may be an unusable subset), then to the DOM sample.
  const resolveEditFont = async (
    fontName: string,
    embedded: ArrayBuffer | null,
    domSample?: FontSample,
  ): Promise<{ fontFamily?: string; fontDataB64?: string; sample?: FontSample }> => {
    const bold = /bold|black|heavy|semibold/i.test(fontName) || !!domSample?.bold
    const italic = /italic|oblique/i.test(fontName) || !!domSample?.italic
    const generic = domSample?.fontName === 'Times-Roman' ? 'serif'
      : domSample?.fontName === 'Courier' ? 'monospace' : 'sans-serif'

    // Face the new text in the document's OWN embedded program when we can — it is
    // the exact typeface + weight of the surrounding text (e.g. a table's "Aptos
    // Narrow,Bold"), so the edit is visually seamless. Back it with the matching
    // INSTALLED font (complete glyph set) for any glyph the subset lacks, and embed
    // that complete font into the saved file so every typed character is present.
    let embFam: string | undefined
    if (embedded && embedded.byteLength > 0) embFam = (await loadPdfFont(embedded)) ?? undefined

    let sysFam: string | undefined        // loaded FontFace family for the installed font
    let sysName: string | undefined       // installed family NAME (Chromium may resolve it directly)
    let sysB64: string | undefined        // full installed-font bytes → embed into the saved PDF
    try {
      const sys = fontName ? await window.electronAPI.resolveSystemFont(fontName, bold, italic) : null
      if (sys) {
        sysName = sys.family
        sysB64 = bytesToBase64(sys.data)   // base64 first, before FontFace can claim the buffer
        sysFam = (await loadPdfFont(sys.data)) ?? undefined
      }
    } catch { /* no installed match — the embedded face / DOM sample still apply */ }

    // Primary on-screen face: embedded program, else the installed font. The CSS
    // stack then lists every remaining same-family face so whichever Chromium can
    // actually paint wins — all of them are the same typeface, so it stays seamless.
    const primary = embFam ?? sysFam
    const q = (n?: string) => (n ? `'${n}'` : null)
    const fallbacks = [
      primary === embFam ? q(sysFam) : null,   // the other loaded face
      q(sysName),                              // installed family, by name
      domSample?.cssFamily ?? null,            // PDF.js text-layer face
      generic,
    ].filter((v): v is string => !!v)
    const sample: FontSample = { cssFamily: fallbacks.join(', '),
      fontName: domSample?.fontName ?? 'Helvetica', bold, italic }
    // Embed the complete installed font when available (all glyphs); else the
    // embedded program; else nothing → the save path falls back to a base-14 match.
    const fontDataB64 = sysB64 ?? (embFam && embedded ? bytesToBase64(embedded) : undefined)
    return { fontFamily: primary, fontDataB64, sample }
  }

  // ── Poly tool: click to add points, dblclick to finish ──────────────────

  const handlePolyClick = (e: React.MouseEvent) => {
    if (!isPolyTool) return
    if (e.button !== 0) return
    e.stopPropagation()
    const [cx, cy] = getSvgXY(e)
    // measure-distance auto-finishes on second click
    if (activeTool === 'measure-distance') {
      if (draw.k === 'poly' && draw.pts.length === 1) {
        commitPoly([...draw.pts, [cx, cy] as [number, number]])
        return
      }
      setDraw({ k: 'poly', pts: [[cx, cy] as [number, number]], curX: cx, curY: cy })
      return
    }
    setDraw(d => {
      if (d.k === 'poly') return { ...d, pts: [...d.pts, [cx, cy] as [number, number]], curX: cx, curY: cy }
      return { k: 'poly', pts: [[cx, cy] as [number, number]], curX: cx, curY: cy }
    })
  }

  const handlePolyDblClick = (e: React.MouseEvent) => {
    if (!isPolyTool || draw.k !== 'poly') return
    e.stopPropagation()
    // Remove the last point (added by the second click of the double-click)
    const pts = draw.pts.slice(0, -1)
    commitPoly(pts)
  }

  const commitPoly = (svgPts: Array<[number, number]>) => {
    const tool = activeTool
    if (!tool || svgPts.length < 2) { setDraw({ k: 'idle' }); return }

    const pdfPts = svgPts.map(([x, y]) => toPdf(x, y) as [number, number])

    if (tool === 'measure-distance') {
      const label = measureLabel('measure-distance', pdfPts, measureUnit, measureScale)
      const ann: MeasureAnn = {
        id: newId(), type: 'measure-distance', pageNum,
        color: toolColor, opacity: toolOpacity, lineWidth: toolLineWidth,
        points: pdfPts, label, unit: measureUnit, createdAt: Date.now(),
      }
      addAnnotation(ann)
    } else if (tool === 'measure-area') {
      if (pdfPts.length < 3) { setDraw({ k: 'idle' }); return }
      const label = measureLabel('measure-area', pdfPts, measureUnit, measureScale)
      const ann: MeasureAnn = {
        id: newId(), type: 'measure-area', pageNum,
        color: toolColor, opacity: toolOpacity, lineWidth: toolLineWidth,
        points: pdfPts, label, unit: measureUnit, createdAt: Date.now(),
      }
      addAnnotation(ann)
    } else if (tool === 'measure-perimeter') {
      const label = measureLabel('measure-perimeter', pdfPts, measureUnit, measureScale)
      const ann: MeasureAnn = {
        id: newId(), type: 'measure-perimeter', pageNum,
        color: toolColor, opacity: toolOpacity, lineWidth: toolLineWidth,
        points: pdfPts, label, unit: measureUnit, createdAt: Date.now(),
      }
      addAnnotation(ann)
    } else if (tool === 'cloud') {
      const ann: CloudAnn = {
        id: newId(), type: 'cloud', pageNum,
        color: toolColor, opacity: toolOpacity, lineWidth: toolLineWidth,
        points: pdfPts, createdAt: Date.now(),
      }
      addAnnotation(ann)
    } else if (tool === 'polygon' || tool === 'polyline') {
      const ann: PolyAnn = {
        id: newId(), type: tool, pageNum,
        color: toolColor, opacity: toolOpacity, lineWidth: toolLineWidth,
        points: pdfPts, createdAt: Date.now(),
      }
      addAnnotation(ann)
    }
    setDraw({ k: 'idle' })
  }

  // ── Mouse handlers ──────────────────────────────────────────────────────

  const handleTypewriterClick = (e: React.MouseEvent) => {
    if (!isTypewriterTool) return
    if (e.button !== 0) return
    // If an editor is already open, let its onBlur commit it — never open a
    // second editor or commit twice (this handler fires on click, after the
    // previous editor's blur has already run).
    if (draw.k === 'typewriter-edit') return
    e.stopPropagation()
    const [sx, sy] = getSvgXY(e)
    setDraw({ k: 'typewriter-edit', x: sx, y: sy, text: '' })
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()

    // An editor is open: clicking the page should let its blur commit the edit,
    // not start a brand-new selection that throws the edit away.
    if (draw.k === 'text-edit-edit' || draw.k === 'textbox-edit'
        || draw.k === 'callout-edit' || draw.k === 'typewriter-edit') {
      return
    }

    if (isTextEditTool) {
      const [sx, sy] = getSvgXY(e)
      setDraw({ k: 'text-edit-size', sx, sy, cx: sx, cy: sy })
      return
    }
    if (isCalloutTool) {
      const [sx, sy] = getSvgXY(e)
      setDraw({ k: 'callout-size', sx, sy, cx: sx, cy: sy })
      return
    }
    if (!activeTool || !isDragDrawTool) return

    const [sx, sy] = getSvgXY(e)

    if (activeTool === 'ink') {
      setDraw({ k: 'ink', cur: [[sx, sy]], done: [] })
    } else if (activeTool === 'textbox') {
      setDraw({ k: 'textbox-size', sx, sy, cx: sx, cy: sy })
    } else if (activeTool === 'stickynote') {
      const [px, py] = toPdf(sx, sy)
      const ann: StickyNoteAnn = {
        id: newId(), type: 'stickynote', pageNum,
        color: toolColor, opacity: toolOpacity, createdAt: Date.now(),
        x: px, y: py, text: '',
      }
      addAnnotation(ann)
      setOpenStickyNote(ann.id)
    } else if (activeTool === 'stamp') {
      const [px, py] = toPdf(sx, sy)
      const ann: StampAnn = {
        id: newId(), type: 'stamp', pageNum,
        color: toolColor, opacity: toolOpacity, createdAt: Date.now(),
        x: px, y: py, width: 120, height: 40,
        stampName,
        imageDataUrl: stampName === 'Custom' ? (customStampDataUrl ?? undefined) : undefined,
      }
      addAnnotation(ann)
    } else if (activeTool === 'snapshot') {
      setDraw({ k: 'snapshot', sx, sy, cx: sx, cy: sy })
    } else {
      setDraw({ k: 'shape', sx, sy, cx: sx, cy: sy })
    }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (imgDrag.k === 'move') {
      const [cx, cy] = getSvgXY(e)
      const dPdfX = (cx - imgDrag.startSvgX) / scale
      const dPdfY = -(cy - imgDrag.startSvgY) / scale
      updateAnnotation(imgDrag.id, {
        x: imgDrag.origAnnX + dPdfX,
        y: imgDrag.origAnnY + dPdfY,
      } as Partial<PlacedImageAnn>)
      return
    }
    if (imgDrag.k === 'resize') {
      const [cx, cy] = getSvgXY(e)
      updateAnnotation(imgDrag.id, {
        width: Math.max(20, imgDrag.origW + (cx - imgDrag.startSvgX) / scale),
        height: Math.max(20, imgDrag.origH + (cy - imgDrag.startSvgY) / scale),
      } as Partial<PlacedImageAnn>)
      return
    }

    if (draw.k === 'idle') return
    const [cx, cy] = getSvgXY(e)
    if (draw.k === 'shape' || draw.k === 'snapshot' || draw.k === 'textbox-size' || draw.k === 'text-edit-size' || draw.k === 'callout-size') {
      setDraw(d => ({ ...d, cx, cy } as DrawPhase))
    } else if (draw.k === 'ink') {
      setDraw(d => ({ ...(d as { k: 'ink'; cur: Array<[number,number]>; done: Array<Array<[number,number]>> }),
        cur: [...(d as any).cur, [cx, cy] as [number, number]] }))
    } else if (draw.k === 'poly') {
      setDraw(d => ({ ...(d as any), curX: cx, curY: cy }))
    }
  }

  const handleMouseUp = (e: React.MouseEvent) => {
    if (imgDrag.k !== 'idle') { setImgDrag({ k: 'idle' }); return }
    if (isMarkupTool) { commitTextSelection(); return }
    if (draw.k === 'idle') return
    const [ex, ey] = getSvgXY(e)

    if (draw.k === 'callout-size') {
      if (Math.abs(ex - draw.sx) < 20 || Math.abs(ey - draw.sy) < 20) { setDraw({ k: 'idle' }); return }
      const x = Math.min(draw.sx, ex), y = Math.min(draw.sy, ey)
      const w = Math.abs(ex - draw.sx), h = Math.abs(ey - draw.sy)
      const tipSvgX = x - 40, tipSvgY = y + h + 40
      setDraw({ k: 'callout-edit', x, y, w, h, text: '', tipSvgX, tipSvgY })
      return
    }

    if (draw.k === 'snapshot') {
      if (Math.abs(ex - draw.sx) >= 8 && Math.abs(ey - draw.sy) >= 8) {
        const svg = svgRef.current
        const wrapper = svg?.closest('.pdf-page-wrapper')
        const canvas = wrapper?.querySelector<HTMLCanvasElement>('canvas.pdf-page-canvas')
        if (canvas) {
          // canvas intrinsic pixels may differ from CSS pixels (HiDPI render scale)
          const ratioX = canvas.width / canvas.clientWidth
          const ratioY = canvas.height / canvas.clientHeight
          const rx = Math.round(Math.min(draw.sx, ex) * ratioX)
          const ry = Math.round(Math.min(draw.sy, ey) * ratioY)
          const rw = Math.round(Math.abs(ex - draw.sx) * ratioX)
          const rh = Math.round(Math.abs(ey - draw.sy) * ratioY)
          const temp = document.createElement('canvas')
          temp.width = rw; temp.height = rh
          const ctx2 = temp.getContext('2d')!
          ctx2.drawImage(canvas, rx, ry, rw, rh, 0, 0, rw, rh)
          temp.toBlob(async blob => {
            if (!blob) return
            try {
              const buf = await blob.arrayBuffer()
              const path = await window.electronAPI.saveFileDialog(`snapshot-page${pageNum}.png`)
              if (path) await window.electronAPI.writeFile(path, buf)
            } catch { /* user cancelled or save failed */ }
          }, 'image/png')
        }
      }
      setDraw({ k: 'idle' })
      usePdfStore.getState().setActiveTool(null)
      return
    }

    if (draw.k === 'shape') {
      const [x1, y1] = toPdf(draw.sx, draw.sy)
      const [x2, y2] = toPdf(ex, ey)
      if (Math.abs(ex - draw.sx) < 4 && Math.abs(ey - draw.sy) < 4) { setDraw({ k: 'idle' }); return }
      if (activeTool === 'redact') {
        addAnnotation({ id: newId(), pageNum, type: 'redact', color: '#000000', opacity: 1,
          x1, y1, x2, y2, blurred: redactBlurred, createdAt: Date.now() } as RedactAnn)
        setDraw({ k: 'idle' }); return
      }
      if (activeTool === 'link') {
        setDraw({ k: 'link-pending', x1, y1, x2, y2, href: '', destPage: '' })
        return
      }
      addAnnotation({
        id: newId(), pageNum, type: activeTool as ShapeAnn['type'],
        color: toolColor, opacity: toolOpacity, lineWidth: toolLineWidth,
        x1, y1, x2, y2, createdAt: Date.now(),
      } as ShapeAnn)
      setDraw({ k: 'idle' })
    } else if (draw.k === 'ink') {
      const allPaths = draw.cur.length > 1
        ? [...draw.done, draw.cur.map(([x, y]) => toPdf(x, y) as [number, number])]
        : draw.done
      if (allPaths.length > 0) {
        addAnnotation({ id: newId(), type: 'ink', pageNum,
          color: toolColor, opacity: toolOpacity, lineWidth: toolLineWidth,
          paths: allPaths, createdAt: Date.now() } as InkAnn)
      }
      setDraw({ k: 'idle' })
    } else if (draw.k === 'textbox-size') {
      if (Math.abs(ex - draw.sx) < 20 || Math.abs(ey - draw.sy) < 20) { setDraw({ k: 'idle' }); return }
      setDraw({ k: 'textbox-edit', x: Math.min(draw.sx, ex), y: Math.min(draw.sy, ey),
        w: Math.abs(ex - draw.sx), h: Math.abs(ey - draw.sy), text: '' })
    } else if (draw.k === 'text-edit-size') {
      const sx = draw.sx, sy = draw.sy
      // Click (not drag): edit the single text object under the cursor in place,
      // sized exactly to it — the PDF-XChange-style "click into text" workflow.
      if (Math.abs(ex - sx) < 6 && Math.abs(ey - sy) < 6) {
        const [px, py] = toPdf(sx, sy)
        ;(async () => {
          try {
            if (await pdfiumReady()) {
              const bytes = usePdfStore.getState().pdfBytes
              if (bytes) {
                const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
                // Line-first (Adobe/PDF-XChange behaviour): a click selects the whole
                // visual line for editing. On commit only the changed run(s) are
                // rewritten, so every face/colour on the line survives the edit.
                // Nested (editable=false) lines take this path too: the main process
                // routes them to Form XObject content-stream surgery (in-place-form /
                // extended / substituted). Gating on editable here made that whole
                // pipeline unreachable from the UI.
                const openLineEditor = async (line: Awaited<ReturnType<typeof window.electronAPI.pdfiumLineAt>>, atX: number, atY: number) => {
                  let fontFamily: string | undefined
                  let fontDataB64: string | undefined
                  let sample = line.editable ? undefined : readTextSpanAt(sx, sy)?.sample
                  if (!line.editable) {
                    // Prepare cover-and-replace font info up front so the overlay
                    // fallback keeps its fidelity when surgery has to bail out.
                    const eff = await resolveEditFont(line.fontName, line.fontLoadable ? line.fontData : null, sample)
                    fontFamily = eff.fontFamily; fontDataB64 = eff.fontDataB64; sample = eff.sample ?? sample
                  } else if (line.fontLoadable && line.fontData.byteLength > 0) {
                    fontFamily = (await loadPdfFont(line.fontData)) ?? undefined
                  }
                  const [lx1, ly2] = toSvg(line.x1, line.y2)
                  const [lx2, ly1] = toSvg(line.x2, line.y1)
                  setDraw({ k: 'text-edit-edit', x: lx1, y: ly2,
                    w: Math.max(24, lx2 - lx1), h: Math.max(10, ly1 - ly2),
                    text: line.text, fontSize: line.fontSize, color: line.color, fontFamily, fontDataB64, sample,
                    linePoint: { x: atX, y: atY },
                    // PDF page-space bbox of the clicked line — lets the main process
                    // disambiguate byte-identical duplicate lines by position.
                    lineBBox: { x1: line.x1, y1: line.y1, x2: line.x2, y2: line.y2 } })
                }
                try {
                  const line = await window.electronAPI.pdfiumLineAt(ab, pageNum - 1, px, py)
                  if (line.found) { await openLineEditor(line, px, py); return }
                } catch (err) {
                  logger.warn('edit-click line probe threw, falling to single-object', err)
                }
                const obj = await window.electronAPI.pdfiumTextObjectAt(ab, pageNum - 1, px, py)
                if (obj.found) {
                  // The line hit-test is stricter than the object hit-test (a click
                  // just off the glyph boxes misses it). The object was hit, so retry
                  // the line probe at the object's centre — line-level editing must
                  // stay the primary path or nested-text surgery never engages.
                  try {
                    const ocx = (obj.x1 + obj.x2) / 2, ocy = (obj.y1 + obj.y2) / 2
                    const line2 = await window.electronAPI.pdfiumLineAt(ab, pageNum - 1, ocx, ocy)
                    if (line2.found) { await openLineEditor(line2, ocx, ocy); return }
                  } catch (err) {
                    logger.warn('edit-click line re-probe threw', err)
                  }
                  let fontFamily: string | undefined
                  let fontDataB64: string | undefined
                  let sample = obj.nested ? readTextSpanAt(sx, sy)?.sample : undefined
                  if (obj.nested) {
                    // Form-nested text can't be saved in place. Redraw it (cover-and-
                    // replace) in the document's own embedded program when loadable,
                    // backed by the matching installed font for missing glyphs + save.
                    const eff = await resolveEditFont(obj.fontName, obj.fontLoadable ? obj.fontData : null, sample)
                    fontFamily = eff.fontFamily; fontDataB64 = eff.fontDataB64; sample = eff.sample ?? sample
                  } else if (obj.fontLoadable && obj.fontData.byteLength > 0) {
                    fontFamily = (await loadPdfFont(obj.fontData)) ?? undefined
                    if (fontFamily) fontDataB64 = bytesToBase64(obj.fontData)
                  }
                  const [ox1, oy2] = toSvg(obj.x1, obj.y2) // top-left
                  const [ox2, oy1] = toSvg(obj.x2, obj.y1) // bottom-right
                  setDraw({ k: 'text-edit-edit', x: ox1, y: oy2,
                    w: Math.max(24, ox2 - ox1), h: Math.max(10, oy1 - oy2),
                    text: obj.text, fontSize: obj.fontSize, color: obj.color, fontFamily, fontDataB64,
                    baselineX: obj.matrix[4], baselineY: obj.matrix[5], sample,
                    ...(obj.nested ? {} : { editPoint: { x: px, y: py } }) })
                  return
                }
              }
            }
          } catch { /* fall through to DOM cover-and-replace */ }
          // PDFium unavailable or no text object found → edit the text run under
          // the cursor via the PDF.js text layer (cover-and-replace on commit).
          const span = readTextSpanAt(sx, sy)
          if (span) {
            setDraw({ k: 'text-edit-edit', x: span.x, y: span.y,
              w: Math.max(24, span.w), h: Math.max(10, span.h),
              text: span.text, fontSize: span.fontSize, color: span.color, sample: span.sample })
          } else {
            setDraw({ k: 'idle' })
          }
        })()
        return
      }
      if (Math.abs(ex - sx) < 10 || Math.abs(ey - sy) < 10) { setDraw({ k: 'idle' }); return }
      const bx = Math.min(sx, ex), by = Math.min(sy, ey)
      const bw = Math.abs(ex - sx), bh = Math.abs(ey - sy)
      // Immediate prefill from the PDF.js text layer (instant box)
      const dom = readRegionText(sx, sy, ex, ey)
      setDraw({ k: 'text-edit-edit', x: bx, y: by, w: bw, h: bh,
        text: dom.text, fontSize: dom.fontSize, color: dom.color, sample: dom.sample })
      // Upgrade the prefill to exactly the text PDFium will replace, so what the
      // user edits == what gets written back (no partial-line data loss).
      const [px1, py2] = toPdf(bx, by)
      const [px2, py1] = toPdf(bx + bw, by + bh)
      ;(async () => {
        try {
          if (!(await pdfiumReady())) return
          const store = usePdfStore.getState()
          const bytes = await store.getBakedBytes()
          const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
          const res = await window.electronAPI.pdfiumTextInRegion(ab, pageNum - 1, { x1: px1, y1: py1, x2: px2, y2: py2 })
          if (res.found) {
            let fontFamily: string | undefined
            let fontDataB64: string | undefined
            let sampleOverride: FontSample | undefined
            if (res.nested) {
              const eff = await resolveEditFont(res.fontName, res.fontLoadable ? res.fontData : null, dom.sample)
              fontFamily = eff.fontFamily; fontDataB64 = eff.fontDataB64; sampleOverride = eff.sample
            } else if (res.fontLoadable && res.fontData.byteLength > 0) {
              fontFamily = (await loadPdfFont(res.fontData)) ?? undefined
              if (fontFamily) fontDataB64 = bytesToBase64(res.fontData)
            }
            setDraw(d => (d.k === 'text-edit-edit' && d.text === dom.text)
              ? { ...d, text: res.text, fontSize: res.fontSize || d.fontSize,
                  color: res.color || d.color, fontFamily, fontDataB64,
                  baselineX: res.matrix[4], baselineY: res.matrix[5],
                  ...(sampleOverride ? { sample: sampleOverride } : {}),
                  // top-level → true in-place; nested form text → cover-and-replace
                  ...(res.nested ? {} : { editRect: { x1: px1, y1: py1, x2: px2, y2: py2 } }) }
              : d)
          }
        } catch { /* keep DOM prefill */ }
      })()
    }
  }

  // ── Text selection markup ────────────────────────────────────────────────

  const commitTextSelection = (typeOverride?: 'highlight' | 'underline' | 'strikethrough') => {
    const type = typeOverride ?? (isMarkupTool ? (activeTool as HighlightAnn['type']) : null)
    if (!type) return
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return
    const range = sel.getRangeAt(0)
    const svgBounds = svgRef.current!.getBoundingClientRect()
    const rects = Array.from(range.getClientRects()).filter(r => r.width > 1)
    if (rects.length === 0) { sel.removeAllRanges(); return }
    const quads = rects.map(r => {
      const [x_ul, y_ul] = toPdf(r.left - svgBounds.left, r.top - svgBounds.top)
      const [x_ur, y_ur] = toPdf(r.right - svgBounds.left, r.top - svgBounds.top)
      const [x_ll, y_ll] = toPdf(r.left - svgBounds.left, r.bottom - svgBounds.top)
      const [x_lr, y_lr] = toPdf(r.right - svgBounds.left, r.bottom - svgBounds.top)
      return [x_ul, y_ul, x_ur, y_ur, x_ll, y_ll, x_lr, y_lr]
    })
    // Highlights read best semi-transparent; underline/strike want full opacity.
    const op = typeOverride ? (type === 'highlight' ? 0.4 : 1) : toolOpacity
    const col = typeOverride && type === 'highlight' && toolColor === '#ffcc00' ? '#ffeb3b' : toolColor
    addAnnotation({ id: newId(), pageNum, type,
      color: col, opacity: op,
      quads, selectedText: sel.toString(), createdAt: Date.now() } as HighlightAnn)
    sel.removeAllRanges()
  }

  // The markup tools (highlight/underline/strikethrough) let the user select text
  // in the PDF.js text layer below — which means the mouseup lands on the text
  // layer, not on this overlay. So listen at the document level and commit the
  // selection only if it started inside THIS page's wrapper.
  const commitMarkupRef = useRef(commitTextSelection)
  commitMarkupRef.current = commitTextSelection
  useEffect(() => {
    if (!isMarkupTool) return
    const onUp = () => {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return
      const wrapper = svgRef.current?.closest('.pdf-page-wrapper')
      if (!wrapper || !sel.anchorNode || !wrapper.contains(sel.anchorNode)) return
      commitMarkupRef.current()
    }
    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [isMarkupTool])

  // ── Drag-to-move a selected annotation ───────────────────────────────────

  const beginMove = (ann: Annotation, e: React.MouseEvent) => {
    if (e.button !== 0) return
    if (activeTool && activeTool !== 'select') return // only in select / no-tool modes
    e.stopPropagation()
    e.preventDefault()
    setSelectedAnnotation(ann.id)
    moveRef.current = { id: ann.id, sx: e.clientX, sy: e.clientY, orig: ann, moved: false }
    const onMove = (ev: MouseEvent) => {
      const m = moveRef.current
      if (!m) return
      if (!m.moved) {
        if (Math.abs(ev.clientX - m.sx) < 3 && Math.abs(ev.clientY - m.sy) < 3) return
        m.moved = true
        usePdfStore.getState().pushUndo() // one undo step per move, captured at first drag
      }
      const dx = (ev.clientX - m.sx) / scale
      const dy = -(ev.clientY - m.sy) / scale
      updateAnnotation(m.id, translatePatch(m.orig, dx, dy))
    }
    const onUp = () => {
      moveRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Bounding box in PDF points of an annotation. null = no movable/resizable box.
  const pdfBounds = (ann: Annotation): { minX: number; minY: number; maxX: number; maxY: number } | null => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = ann as any
    let minX: number, minY: number, maxX: number, maxY: number
    switch (ann.type) {
      case 'rectangle': case 'ellipse': case 'line': case 'arrow': case 'redact': case 'link':
        minX = Math.min(a.x1, a.x2); maxX = Math.max(a.x1, a.x2)
        minY = Math.min(a.y1, a.y2); maxY = Math.max(a.y1, a.y2); break
      case 'highlight': case 'underline': case 'strikethrough': {
        const xs: number[] = [], ys: number[] = []
        for (const q of a.quads) { xs.push(q[0], q[2], q[4], q[6]); ys.push(q[1], q[3], q[5], q[7]) }
        if (!xs.length) return null
        minX = Math.min(...xs); maxX = Math.max(...xs); minY = Math.min(...ys); maxY = Math.max(...ys); break
      }
      case 'ink': {
        const pts = (a.paths as Array<Array<[number, number]>>).flat()
        if (!pts.length) return null
        minX = Math.min(...pts.map(p => p[0])); maxX = Math.max(...pts.map(p => p[0]))
        minY = Math.min(...pts.map(p => p[1])); maxY = Math.max(...pts.map(p => p[1])); break
      }
      case 'polygon': case 'polyline': case 'cloud':
      case 'measure-distance': case 'measure-area': case 'measure-perimeter': {
        const pts = a.points as Array<[number, number]>
        if (!pts.length) return null
        minX = Math.min(...pts.map(p => p[0])); maxX = Math.max(...pts.map(p => p[0]))
        minY = Math.min(...pts.map(p => p[1])); maxY = Math.max(...pts.map(p => p[1])); break
      }
      case 'textbox': case 'text-edit': case 'callout': case 'placed-image':
        minX = a.x; maxX = a.x + a.width; minY = a.y; maxY = a.y + a.height; break
      case 'stamp':
        minX = a.x - a.width / 2; maxX = a.x + a.width / 2
        minY = a.y - a.height / 2; maxY = a.y + a.height / 2; break
      case 'stickynote':
        minX = a.x; maxX = a.x + 22; minY = a.y; maxY = a.y + 22; break
      case 'typewriter':
        minX = a.x; maxX = a.x + Math.max(40, (a.text?.length || 4) * a.fontSize * 0.6)
        minY = a.y; maxY = a.y + a.fontSize * 1.6; break
      case 'caret':
        minX = a.x; maxX = a.x + (a.width || 10); minY = a.y - (a.height || 14); maxY = a.y; break
      default:
        return null
    }
    return { minX, minY, maxX, maxY }
  }

  // SVG-space box (with a small inset) used for the move target + selection chrome.
  const moveHandleBox = (ann: Annotation): { x: number; y: number; w: number; h: number } | null => {
    const b = pdfBounds(ann)
    if (!b) return null
    const [sx1, sy1] = toSvg(b.minX, b.maxY) // top-left in svg
    const [sx2, sy2] = toSvg(b.maxX, b.minY) // bottom-right in svg
    return { x: sx1 - 2, y: sy1 - 2, w: (sx2 - sx1) + 4, h: (sy2 - sy1) + 4 }
  }

  const isResizable = (ann: Annotation) => RESIZABLE_TYPES.has(ann.type)

  // Map every geometry field of an annotation from its old PDF bounding box to a new
  // one (linear scale + translate). Powers the 8-handle resize for all shapes/text.
  type Box = { minX: number; minY: number; maxX: number; maxY: number }
  const remapPatch = (ann: Annotation, oldBox: Box, newBox: Box): Partial<Annotation> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = ann as any
    const ow = oldBox.maxX - oldBox.minX
    const oh = oldBox.maxY - oldBox.minY
    const fx = ow > 0.01 ? (newBox.maxX - newBox.minX) / ow : 1
    const fy = oh > 0.01 ? (newBox.maxY - newBox.minY) / oh : 1
    const mapX = (x: number) => ow > 0.01 ? newBox.minX + (x - oldBox.minX) * fx : x + (newBox.minX - oldBox.minX)
    const mapY = (y: number) => oh > 0.01 ? newBox.minY + (y - oldBox.minY) * fy : y + (newBox.minY - oldBox.minY)
    switch (ann.type) {
      case 'rectangle': case 'ellipse': case 'line': case 'arrow': case 'redact': case 'link':
        return { x1: mapX(a.x1), y1: mapY(a.y1), x2: mapX(a.x2), y2: mapY(a.y2) } as Partial<Annotation>
      case 'ink':
        return { paths: a.paths.map((p: Array<[number, number]>) =>
          p.map(([x, y]) => [mapX(x), mapY(y)] as [number, number])) } as Partial<Annotation>
      case 'polygon': case 'polyline': case 'cloud':
        return { points: a.points.map(([x, y]: [number, number]) =>
          [mapX(x), mapY(y)] as [number, number]) } as Partial<Annotation>
      case 'measure-distance': case 'measure-area': case 'measure-perimeter': {
        const pts = a.points.map(([x, y]: [number, number]) => [mapX(x), mapY(y)] as [number, number])
        return { points: pts, label: measureLabel(ann.type, pts, measureUnit, measureScale) } as Partial<Annotation>
      }
      case 'textbox': case 'text-edit': case 'placed-image':
        return { x: mapX(a.x), y: mapY(a.y), width: Math.max(8, a.width * fx), height: Math.max(8, a.height * fy) } as Partial<Annotation>
      case 'callout':
        return { x: mapX(a.x), y: mapY(a.y), width: Math.max(8, a.width * fx), height: Math.max(8, a.height * fy),
          tipX: mapX(a.tipX), tipY: mapY(a.tipY) } as Partial<Annotation>
      case 'stamp':
        return { x: mapX(a.x), y: mapY(a.y), width: Math.max(8, a.width * fx), height: Math.max(8, a.height * fy) } as Partial<Annotation>
      case 'typewriter':
        return { x: mapX(a.x), y: mapY(a.y), fontSize: Math.max(5, a.fontSize * (fx + fy) / 2) } as Partial<Annotation>
      default:
        return {}
    }
  }

  const beginResize = (ann: Annotation, handle: ResizeHandle, e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    setSelectedAnnotation(ann.id)
    const b = pdfBounds(ann)
    if (!b) return
    const [sx1, sy1] = toSvg(b.minX, b.maxY)
    const [sx2, sy2] = toSvg(b.maxX, b.minY)
    const [startX, startY] = getSvgXY(e)
    resizeRef.current = { id: ann.id, handle, origAnn: ann,
      origSvg: { x: sx1, y: sy1, w: sx2 - sx1, h: sy2 - sy1 }, startX, startY, pushed: false }
    const onMove = (ev: MouseEvent) => {
      const r = resizeRef.current
      if (!r || !svgRef.current) return
      const rect = svgRef.current.getBoundingClientRect()
      const dx = (ev.clientX - rect.left) - r.startX
      const dy = (ev.clientY - rect.top) - r.startY
      if (!r.pushed) {
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return
        r.pushed = true
        usePdfStore.getState().pushUndo()
      }
      let left = r.origSvg.x, top = r.origSvg.y
      let right = r.origSvg.x + r.origSvg.w, bottom = r.origSvg.y + r.origSvg.h
      if (r.handle.includes('w')) left += dx
      if (r.handle.includes('e')) right += dx
      if (r.handle.includes('n')) top += dy
      if (r.handle.includes('s')) bottom += dy
      if (right - left < 6) { if (r.handle.includes('w')) left = right - 6; else right = left + 6 }
      if (bottom - top < 6) { if (r.handle.includes('n')) top = bottom - 6; else bottom = top + 6 }
      const [pMinX, pMaxY] = toPdf(left, top)
      const [pMaxX, pMinY] = toPdf(right, bottom)
      const oldBox = pdfBounds(r.origAnn)
      if (!oldBox) return
      updateAnnotation(r.id, remapPatch(r.origAnn, oldBox, { minX: pMinX, minY: pMinY, maxX: pMaxX, maxY: pMaxY }))
    }
    const onUp = () => {
      resizeRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Transparent bounding-box hit-areas so any annotation can be selected by
  // clicking anywhere on it (shapes are fill:none/stroke-only otherwise) and dragged
  // to move in one gesture. The selected one is skipped — its chrome handles it.
  const renderSelectHitAreas = () => {
    if (activeTool && activeTool !== 'select') return null
    return pageAnnotations.map(ann => {
      if (ann.id === selectedAnnotationId) return null
      if (ann.type === 'placed-image') return null // its <image> handles select/move
      const box = moveHandleBox(ann)
      if (!box || box.w < 1 || box.h < 1) return null
      return (
        <rect key={'hit-' + ann.id} x={box.x} y={box.y} width={box.w} height={box.h}
          fill="rgba(0,0,0,0.001)" stroke="none" pointerEvents="all" style={{ cursor: 'move' }}
          onMouseDown={e => {
            if (e.button !== 0) return
            if (ann.type === 'stickynote') setOpenStickyNote(ann.id)
            beginMove(ann, e)
          }}
          onContextMenu={e => openAnnotMenu(ann.id, e)} />
      )
    })
  }

  // Selection chrome: move target + dashed outline + 8 resize handles.
  const renderSelectionChrome = () => {
    if (activeTool && activeTool !== 'select') return null
    if (!selectedAnnotationId) return null
    const ann = pageAnnotations.find(a => a.id === selectedAnnotationId)
    if (!ann) return null
    const box = moveHandleBox(ann)
    if (!box || box.w < 2 || box.h < 2) return null
    const hs = 8
    // Note: do NOT gate these on moveRef/resizeRef. Those are refs, so clearing them
    // on mouseup doesn't re-render — gating here left the handles hidden after a
    // click-select. The move rect + handles are safe to keep mounted during a drag
    // (the drag runs on window listeners; no new mousedown fires until released).
    return (
      <g>
        <rect x={box.x} y={box.y} width={box.w} height={box.h}
          fill="rgba(0,0,0,0.001)" stroke="none" pointerEvents="all"
          style={{ cursor: 'move' }}
          onMouseDown={e => beginMove(ann, e)}
          onContextMenu={e => openAnnotMenu(ann.id, e)} />
        <rect x={box.x} y={box.y} width={box.w} height={box.h}
          fill="none" stroke="#4a9eff" strokeWidth={1} strokeDasharray="4,3" pointerEvents="none" />
        {isResizable(ann) && RESIZE_HANDLES.map(hd => (
          <rect key={hd.h}
            x={box.x + box.w * hd.fx - hs / 2} y={box.y + box.h * hd.fy - hs / 2}
            width={hs} height={hs} rx={1.5}
            fill="#fff" stroke="#4a9eff" strokeWidth={1.5} pointerEvents="all"
            style={{ cursor: hd.cursor }}
            onMouseDown={e => beginResize(ann, hd.h, e)} />
        ))}
      </g>
    )
  }

  // ── Click handlers ───────────────────────────────────────────────────────

  const handleAnnotClick = (ann: Annotation, e: React.MouseEvent) => {
    e.stopPropagation()
    if (activeTool === 'eraser') {
      deleteAnnotation(ann.id)
    } else if (activeTool === 'select' || !activeTool) {
      setSelectedAnnotation(selectedAnnotationId === ann.id ? null : ann.id)
      if (ann.type === 'stickynote') setOpenStickyNote(openStickyNoteId === ann.id ? null : ann.id)
    }
  }

  const handleSvgClick = (e: React.MouseEvent) => {
    if (isCaretTool && e.button === 0) {
      e.stopPropagation()
      const [sx, sy] = getSvgXY(e)
      const [px, py] = toPdf(sx, sy)
      addAnnotation({
        id: newId(), type: 'caret', pageNum,
        color: toolColor, opacity: toolOpacity, createdAt: Date.now(),
        x: px, y: py - 12, width: 10, height: 14,
      } as CaretAnn)
      return
    }
    if (e.target === svgRef.current) {
      setSelectedAnnotation(null)
      setOpenStickyNote(null)
    }
  }

  // ── Right-click context menus ────────────────────────────────────────────

  const openAnnotMenu = (annId: string, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    setSelectedAnnotation(annId)
    setCtxMenu({ x: e.clientX, y: e.clientY, annId })
  }

  // Right-click anywhere on the page (select / no-tool modes): hit-test the topmost
  // annotation under the cursor → object menu, else an empty-area paste menu.
  const handleSvgContextMenu = (e: React.MouseEvent) => {
    if (activeTool && activeTool !== 'select') return
    const [sx, sy] = getSvgXY(e)
    let hit: Annotation | null = null
    for (let i = pageAnnotations.length - 1; i >= 0; i--) {
      const box = moveHandleBox(pageAnnotations[i])
      if (box && sx >= box.x && sx <= box.x + box.w && sy >= box.y && sy <= box.y + box.h) { hit = pageAnnotations[i]; break }
    }
    e.preventDefault()
    if (hit) { setSelectedAnnotation(hit.id); setCtxMenu({ x: e.clientX, y: e.clientY, annId: hit.id }) }
    else setCtxMenu({ x: e.clientX, y: e.clientY, annId: null })
  }

  const buildAnnotMenuItems = (annId: string | null): ContextMenuEntry[] => {
    if (!annId) {
      return [{ label: 'Paste here', action: () => pasteAnnotation(pageNum), disabled: !annotationClipboard }]
    }
    return [
      { label: 'Cut', action: () => { copyAnnotation(annId); deleteAnnotation(annId) } },
      { label: 'Copy', action: () => copyAnnotation(annId) },
      { label: 'Duplicate', action: () => duplicateAnnotation(annId) },
      { label: 'Paste', action: () => pasteAnnotation(pageNum), disabled: !annotationClipboard },
      'separator',
      { label: 'Bring to Front', action: () => bringAnnotationToFront(annId) },
      { label: 'Send to Back', action: () => sendAnnotationToBack(annId) },
      'separator',
      { label: 'Delete', action: () => deleteAnnotation(annId) },
    ]
  }

  const buildTextMenuItems = (): ContextMenuEntry[] => {
    const txt = window.getSelection()?.toString() ?? ''
    return [
      { label: 'Copy', action: () => { void copyText(txt) } },
      'separator',
      { label: 'Highlight', action: () => commitTextSelection('highlight') },
      { label: 'Underline', action: () => commitTextSelection('underline') },
      { label: 'Strikethrough', action: () => commitTextSelection('strikethrough') },
    ]
  }

  // Right-click on selected text (text-select mode) → copy / markup menu. Listens at
  // document level because the mouseup/selection lives in the PDF.js text layer below.
  useEffect(() => {
    const isTextSelect = activeTool === null && !panMode
    if (!isTextSelect) return
    const onCtx = (e: MouseEvent) => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
      const wrapper = svgRef.current?.closest('.pdf-page-wrapper')
      if (!wrapper || !sel.anchorNode || !wrapper.contains(sel.anchorNode)) return
      e.preventDefault()
      setTextMenu({ x: e.clientX, y: e.clientY })
    }
    document.addEventListener('contextmenu', onCtx)
    return () => document.removeEventListener('contextmenu', onCtx)
  }, [activeTool, panMode])

  // ── Commit helpers ───────────────────────────────────────────────────────

  const commitTextBox = (text: string) => {
    if (draw.k !== 'textbox-edit') return
    if (text.trim()) {
      const [x, y_top] = toPdf(draw.x, draw.y)
      const [, y_bot] = toPdf(draw.x, draw.y + draw.h)
      const [x2] = toPdf(draw.x + draw.w, draw.y)
      addAnnotation({ id: newId(), type: 'textbox', pageNum,
        color: toolColor, opacity: toolOpacity, font: toolFont,
        x, y: y_bot, width: x2 - x, height: y_top - y_bot,
        text, fontSize: toolFontSize, createdAt: Date.now() } as TextBoxAnn)
    }
    setDraw({ k: 'idle' })
  }

  const commitTypewriter = (text: string) => {
    if (draw.k !== 'typewriter-edit') return
    if (text.trim()) {
      const [px] = toPdf(draw.x, draw.y)
      const [, py_bot] = toPdf(draw.x, draw.y + toolFontSize * scale * 1.5)
      addAnnotation({ id: newId(), type: 'typewriter', pageNum,
        color: toolColor, opacity: toolOpacity, font: toolFont,
        x: px, y: py_bot, text, fontSize: toolFontSize, createdAt: Date.now() } as TypewriterAnn)
    }
    setDraw({ k: 'idle' })
  }

  const commitTextEdit = async (text: string) => {
    if (draw.k !== 'text-edit-edit') return
    const d = draw
    const trimmed = text.trim()
    setDraw({ k: 'idle' })
    if (!trimmed) return

    // Line-level edit: PDFium diffs the new line text against the old one and
    // rewrites ONLY the changed run(s) — untouched runs keep their font and
    // colour byte-for-byte, and runs right of the edit shift by the width delta.
    if (d.linePoint) {
      try {
        const store = usePdfStore.getState()
        const bytes = store.pdfBytes
        if (bytes && await pdfiumReady()) {
          const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
          const res = await window.electronAPI.pdfiumReplaceLine(ab, pageNum - 1, d.linePoint.x, d.linePoint.y, text, d.lineBBox)
          await store.applyContentEdit(new Uint8Array(res.bytes), pageNum)
          // Outcome (in-place / extended / substituted) is deliberately not
          // surfaced — substitution is silent, like Acrobat/XChange (user
          // request 2026-07-14). The outcome still reaches the log below.
          logger.debug('line edit outcome', res.outcome, res.substituteFamily)
          return
        }
      } catch (err) {
        logger.error('line edit fell back to overlay', err)
      }
    }

    // Primary path: TRUE in-place edit via PDFium. FPDFText_SetText rewrites the
    // clicked text object's string while reusing its own embedded font, size and
    // colour, so the edited text keeps the original typeface exactly — and an
    // incremental save leaves every other object (and its font) byte-for-byte
    // intact (verified: scripts/prove-inplace-edit.mjs). This is the engine the
    // tool relies on; the overlay below is only a fallback when it's unavailable.
    if (d.editPoint || d.editRect) {
      try {
        const store = usePdfStore.getState()
        const bytes = store.pdfBytes
        if (bytes && await pdfiumReady()) {
          const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
          const edited = d.editPoint
            ? await window.electronAPI.pdfiumEditTextAt(ab, pageNum - 1, d.editPoint.x, d.editPoint.y, text)
            : await window.electronAPI.pdfiumEditText(ab, pageNum - 1, d.editRect!, text)
          await store.applyContentEdit(new Uint8Array(edited), pageNum)
          return
        }
      } catch { /* fall through to the cover-and-replace overlay */ }
    }

    // Fallback (PDFium unavailable or in-place rejected): cover-and-replace
    // overlay, redrawn in the document's OWN embedded font (fontDataB64) at the
    // original baseline, or a base-14 match when the font can't be embedded.
    // Never rewrites existing page content, so it can't corrupt other fonts.
    const [x, y_top] = toPdf(d.x, d.y)
    const [, y_bot] = toPdf(d.x, d.y + d.h)
    const [x2] = toPdf(d.x + d.w, d.y)
    addAnnotation({ id: newId(), type: 'text-edit', pageNum,
      color: d.color ?? toolColor, opacity: toolOpacity,
      x, y: y_bot, width: x2 - x, height: y_top - y_bot,
      text, fontSize: d.fontSize ?? toolFontSize,
      fontDataB64: d.fontDataB64, fontFamily: d.fontFamily,
      baselineX: d.baselineX, baselineY: d.baselineY,
      font: d.sample?.fontName, cssFamily: d.sample?.cssFamily,
      bold: d.sample?.bold, italic: d.sample?.italic,
      createdAt: Date.now() } as TextEditAnn)
  }

  const commitCallout = (text: string) => {
    if (draw.k !== 'callout-edit') return
    if (text.trim()) {
      const [x, y_top] = toPdf(draw.x, draw.y)
      const [, y_bot] = toPdf(draw.x, draw.y + draw.h)
      const [x2] = toPdf(draw.x + draw.w, draw.y)
      const [tipX, tipY] = toPdf(draw.tipSvgX, draw.tipSvgY)
      addAnnotation({ id: newId(), type: 'callout', pageNum,
        color: toolColor, opacity: toolOpacity,
        x, y: y_bot, width: x2 - x, height: y_top - y_bot,
        text, fontSize: toolFontSize, lineWidth: toolLineWidth,
        tipX, tipY, createdAt: Date.now() } as CalloutAnn)
    }
    setDraw({ k: 'idle' })
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA'
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const { selectedAnnotationId: sid, deleteAnnotation: del, setSelectedAnnotation: setSel } = usePdfStore.getState()
        if (sid && !typing) {
          del(sid); setSel(null)
        }
      }
      // Arrow-key nudge of the selected annotation: 1 pt, or 10 pt with Shift.
      // Only the page that owns the selection acts (each page has its own listener).
      if (!typing && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const st = usePdfStore.getState()
        const sid = st.selectedAnnotationId
        const ann = sid ? st.annotations.find(a => a.id === sid) : null
        if (ann && ann.pageNum === pageNum) {
          e.preventDefault()
          const now = Date.now()
          if (now - lastNudgeRef.current > 800) st.pushUndo()   // group a burst into one undo step
          lastNudgeRef.current = now
          const step = e.shiftKey ? 10 : 1
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
          const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0   // PDF y is up
          st.updateAnnotation(sid!, translatePatch(ann, dx, dy))
        }
      }
      if (e.key === 'Escape') {
        usePdfStore.getState().setSelectedAnnotation(null)
        usePdfStore.getState().setOpenStickyNote(null)
        setDraw({ k: 'idle' })
      }
      // Enter finishes poly drawing
      if (e.key === 'Enter' && draw.k === 'poly') {
        commitPoly(draw.pts)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [draw]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Rendering helpers ────────────────────────────────────────────────────

  const annStyle = (_ann: Annotation) => ({
    cursor: activeTool === 'eraser' ? 'cell'
      : activeTool === 'select' || !activeTool ? 'pointer' : 'crosshair',
  })

  const selBorder = (ann: Annotation) =>
    selectedAnnotationId === ann.id ? { filter: 'drop-shadow(0 0 3px #4a9eff)' } : {}

  function getBBoxStyle(ann: InkAnn) {
    const pts = ann.paths.flat()
    if (pts.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
    const [sx1, sy1] = toSvg(Math.min(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1])))
    const [sx2, sy2] = toSvg(Math.max(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])))
    return { x: sx1 - 4, y: sy1 - 4, width: sx2 - sx1 + 8, height: sy2 - sy1 + 8 }
  }

  // ── Annotation rendering ─────────────────────────────────────────────────

  const renderAnn = (ann: Annotation) => {
    const sel = selectedAnnotationId === ann.id

    if (ann.type === 'highlight' || ann.type === 'underline' || ann.type === 'strikethrough') {
      const a = ann as HighlightAnn
      return (
        <g key={a.id} onClick={e => handleAnnotClick(a, e)} style={{ ...annStyle(a), ...selBorder(a) }}>
          {a.quads.map((q, qi) => {
            const [lx, ly] = toSvg(q[0], q[1])
            const [rx, ry] = toSvg(q[2], q[3])
            const [blx, bly] = toSvg(q[4], q[5])
            const [brx, bry] = toSvg(q[6], q[7])
            if (a.type === 'highlight')
              return <polygon key={qi} points={`${lx},${ly} ${rx},${ry} ${brx},${bry} ${blx},${bly}`}
                fill={a.color} fillOpacity={a.opacity} stroke="none" pointerEvents="all" />
            if (a.type === 'underline')
              return <line key={qi} x1={blx} y1={bly} x2={brx} y2={bry}
                stroke={a.color} strokeWidth={Math.max(1, scale)} strokeOpacity={a.opacity} pointerEvents="stroke" />
            const mx = (lx + blx) / 2, my = (ly + bly) / 2
            const mx2 = (rx + brx) / 2, my2 = (ry + bry) / 2
            return <line key={qi} x1={mx} y1={my} x2={mx2} y2={my2}
              stroke={a.color} strokeWidth={Math.max(1, scale)} strokeOpacity={a.opacity} pointerEvents="stroke" />
          })}
        </g>
      )
    }

    if (ann.type === 'ink') {
      const a = ann as InkAnn
      return (
        <g key={a.id} onClick={e => handleAnnotClick(a, e)} style={{ ...annStyle(a), ...selBorder(a) }}>
          {a.paths.map((path, pi) => (
            <polyline key={pi} points={path.map(([px, py]) => toSvg(px, py).join(',')).join(' ')}
              fill="none" stroke={a.color} strokeWidth={a.lineWidth * scale} strokeOpacity={a.opacity}
              strokeLinecap="round" strokeLinejoin="round" pointerEvents="stroke" />
          ))}
          {sel && <rect {...getBBoxStyle(a)} fill="none" stroke="#4a9eff" strokeWidth={1} strokeDasharray="4,2" />}
        </g>
      )
    }

    if (ann.type === 'rectangle') {
      const a = ann as ShapeAnn
      const [svgX1, svgY1] = toSvg(Math.min(a.x1, a.x2), Math.max(a.y1, a.y2))
      const [svgX2, svgY2] = toSvg(Math.max(a.x1, a.x2), Math.min(a.y1, a.y2))
      return <rect key={a.id} x={svgX1} y={svgY1} width={svgX2 - svgX1} height={svgY2 - svgY1}
        fill="none" stroke={a.color} strokeWidth={a.lineWidth * scale} strokeOpacity={a.opacity}
        strokeDasharray={sel ? '6,3' : undefined}
        onClick={e => handleAnnotClick(a, e)} style={annStyle(a)} pointerEvents="stroke" />
    }

    if (ann.type === 'ellipse') {
      const a = ann as ShapeAnn
      const [cx, cy] = toSvg((a.x1 + a.x2) / 2, (a.y1 + a.y2) / 2)
      return <ellipse key={a.id} cx={cx} cy={cy}
        rx={Math.abs(a.x2 - a.x1) / 2 * scale} ry={Math.abs(a.y2 - a.y1) / 2 * scale}
        fill="none" stroke={a.color} strokeWidth={a.lineWidth * scale} strokeOpacity={a.opacity}
        strokeDasharray={sel ? '6,3' : undefined}
        onClick={e => handleAnnotClick(a, e)} style={annStyle(a)} pointerEvents="stroke" />
    }

    if (ann.type === 'line' || ann.type === 'arrow') {
      const a = ann as ShapeAnn
      const [x1, y1] = toSvg(a.x1, a.y1)
      const [x2, y2] = toSvg(a.x2, a.y2)
      const mid = `M${pageNum}-${a.id}`
      return (
        <g key={a.id} onClick={e => handleAnnotClick(a, e)} style={annStyle(a)}>
          {a.type === 'arrow' && (
            <defs>
              <marker id={mid} markerWidth={10} markerHeight={7} refX={9} refY={3.5} orient="auto">
                <polygon points="0 0, 10 3.5, 0 7" fill={a.color} fillOpacity={a.opacity} />
              </marker>
            </defs>
          )}
          <line x1={x1} y1={y1} x2={x2} y2={y2}
            stroke={a.color} strokeWidth={a.lineWidth * scale} strokeOpacity={a.opacity}
            strokeDasharray={sel ? '6,3' : undefined}
            markerEnd={a.type === 'arrow' ? `url(#${mid})` : undefined}
            pointerEvents="stroke" />
        </g>
      )
    }

    if (ann.type === 'textbox') {
      const a = ann as TextBoxAnn
      const [svgX, svgY_top] = toSvg(a.x, a.y + a.height)
      return (
        <foreignObject key={a.id} x={svgX} y={svgY_top} width={a.width * scale} height={a.height * scale}
          onClick={e => handleAnnotClick(a, e)} style={annStyle(a)}>
          <div style={{
            width: '100%', height: '100%', padding: 4,
            fontSize: a.fontSize * scale, color: a.color, opacity: a.opacity,
            fontFamily: cssFont(a.font), border: sel ? '1px dashed #4a9eff' : '1px solid rgba(255,255,255,0.2)',
            boxSizing: 'border-box', overflow: 'hidden', wordBreak: 'break-word',
            background: 'rgba(255,255,220,0.08)', pointerEvents: 'all', whiteSpace: 'pre-wrap',
          }}>{a.text}</div>
        </foreignObject>
      )
    }

    if (ann.type === 'stickynote') {
      const a = ann as StickyNoteAnn
      const [sx, sy] = toSvg(a.x, a.y)
      const sz = 22 * scale
      return (
        <g key={a.id} transform={`translate(${sx},${sy - sz})`}
          onClick={e => handleAnnotClick(a, e)} style={{ ...annStyle(a), ...selBorder(a) }}>
          <rect x={0} y={0} width={sz} height={sz} rx={4}
            fill={a.color} fillOpacity={Math.min(1, a.opacity + 0.2)} />
          <text x={sz / 2} y={sz / 2} textAnchor="middle" dominantBaseline="middle"
            fontSize={sz * 0.55} pointerEvents="none">💬</text>
        </g>
      )
    }

    if (ann.type === 'redact') {
      const a = ann as RedactAnn
      const [svgX1, svgY1] = toSvg(Math.min(a.x1, a.x2), Math.max(a.y1, a.y2))
      const [svgX2, svgY2] = toSvg(Math.max(a.x1, a.x2), Math.min(a.y1, a.y2))
      const w = svgX2 - svgX1, h = svgY2 - svgY1
      const filterId = `blur-${a.id}`
      if (a.blurred) {
        return (
          <g key={a.id} onClick={e => handleAnnotClick(a, e)} style={annStyle(a)}>
            <defs>
              <filter id={filterId} x="-5%" y="-5%" width="110%" height="110%">
                <feGaussianBlur stdDeviation="6" />
              </filter>
            </defs>
            <rect x={svgX1} y={svgY1} width={w} height={h}
              fill="rgba(100,100,120,0.55)" filter={`url(#${filterId})`}
              stroke={sel ? '#4a9eff' : '#8888cc'} strokeWidth={sel ? 2 : 1.5}
              strokeDasharray={sel ? '6,3' : '4,3'} pointerEvents="all" />
            {h > 16 && <text x={svgX1 + w / 2} y={svgY1 + h / 2}
              textAnchor="middle" dominantBaseline="middle"
              fill="#aaaadd" fontSize={Math.min(11, h * 0.5)}
              fontWeight="bold" fontFamily="sans-serif" pointerEvents="none">BLUR</text>}
          </g>
        )
      }
      return (
        <g key={a.id} onClick={e => handleAnnotClick(a, e)} style={annStyle(a)}>
          <defs>
            <pattern id={`rp-${a.id}`} patternUnits="userSpaceOnUse" width={10} height={10} patternTransform="rotate(45)">
              <rect width={10} height={10} fill="#1a1a1a" />
              <line x1={0} y1={0} x2={0} y2={10} stroke="#ff4444" strokeWidth={3} />
            </pattern>
          </defs>
          <rect x={svgX1} y={svgY1} width={w} height={h}
            fill={`url(#rp-${a.id})`}
            stroke={sel ? '#4a9eff' : '#ff4444'} strokeWidth={sel ? 2 : 1.5}
            strokeDasharray={sel ? '6,3' : undefined} pointerEvents="all" />
          {h > 16 && <text x={svgX1 + w / 2} y={svgY1 + h / 2}
            textAnchor="middle" dominantBaseline="middle"
            fill="#ff4444" fontSize={Math.min(11, h * 0.5)}
            fontWeight="bold" fontFamily="sans-serif" pointerEvents="none">REDACT</text>}
        </g>
      )
    }

    if (ann.type === 'stamp') {
      const a = ann as StampAnn
      const [sx, sy] = toSvg(a.x, a.y)
      const w = a.width * scale, h = a.height * scale
      return (
        <g key={a.id} transform={`translate(${sx},${sy})`}
          onClick={e => handleAnnotClick(a, e)} style={{ ...annStyle(a), opacity: a.opacity }}>
          {sel && <rect x={-w/2-2} y={-h/2-2} width={w+4} height={h+4}
            fill="none" stroke="#4a9eff" strokeWidth={1} strokeDasharray="4,2" />}
          {a.stampName === 'Custom' && a.imageDataUrl
            ? <image href={a.imageDataUrl} x={-w/2} y={-h/2} width={w} height={h} />
            : <StampShape color={a.color} stampName={a.stampName} w={w} h={h} />}
        </g>
      )
    }

    if (ann.type === 'typewriter') {
      const a = ann as TypewriterAnn
      const [svgX, svgY] = toSvg(a.x, a.y + a.fontSize * 1.5)
      return (
        <foreignObject key={a.id} x={svgX} y={svgY} width={W - svgX} height={a.fontSize * scale * 3}
          onClick={e => handleAnnotClick(a, e)} style={annStyle(a)}>
          <div style={{
            fontSize: a.fontSize * scale, color: a.color, opacity: a.opacity,
            fontFamily: cssFont(a.font), whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            border: sel ? '1px dashed #4a9eff' : 'none', outline: 'none', padding: 2, boxSizing: 'border-box',
          }}>{a.text}</div>
        </foreignObject>
      )
    }

    if (ann.type === 'text-edit') {
      const a = ann as TextEditAnn
      const [svgX, svgY_top] = toSvg(a.x, a.y + a.height)
      const w = a.width * scale, h = a.height * scale
      return (
        <g key={a.id} onClick={e => handleAnnotClick(a, e)} style={annStyle(a)}>
          <rect x={svgX} y={svgY_top} width={w} height={h} fill="white" />
          <TextEditRaster a={a} x={svgX} y={svgY_top} w={w} h={h} scale={scale} />
          {sel && <rect x={svgX} y={svgY_top} width={w} height={h} fill="none"
            stroke="#4a9eff" strokeWidth={1} strokeDasharray="4,2" />}
        </g>
      )
    }

    if (ann.type === 'placed-image') {
      const a = ann as PlacedImageAnn
      const [svgX, svgY_top] = toSvg(a.x, a.y + a.height)
      const svgW = a.width * scale, svgH = a.height * scale
      return (
        <g key={a.id}
          onClick={e => { if (imgDrag.k === 'idle') handleAnnotClick(a, e) }}
          style={{ cursor: activeTool === 'eraser' ? 'cell' : 'move', opacity: a.opacity }}>
          <image href={a.dataUrl} x={svgX} y={svgY_top} width={svgW} height={svgH}
            onMouseDown={e => {
              if (activeTool === 'eraser') return
              e.stopPropagation()
              setSelectedAnnotation(a.id)
              const [sx, sy] = getSvgXY(e)
              setImgDrag({ k: 'move', id: a.id, startSvgX: sx, startSvgY: sy, origAnnX: a.x, origAnnY: a.y })
            }} />
          {/* Selection outline + 8 resize handles are drawn by renderSelectionChrome. */}
        </g>
      )
    }

    // ── Batch 2 new types ────────────────────────────────────────────────

    if (ann.type === 'callout') {
      const a = ann as CalloutAnn
      const [svgX, svgY_top] = toSvg(a.x, a.y + a.height)
      const svgW = a.width * scale, svgH = a.height * scale
      const [tipSvgX, tipSvgY] = toSvg(a.tipX, a.tipY)
      const attachX = svgX, attachY = svgY_top + svgH / 2
      return (
        <g key={a.id} onClick={e => handleAnnotClick(a, e)} style={{ ...annStyle(a), ...selBorder(a) }}>
          <line x1={tipSvgX} y1={tipSvgY} x2={attachX} y2={attachY}
            stroke={a.color} strokeWidth={a.lineWidth * scale} strokeOpacity={a.opacity} pointerEvents="stroke" />
          <rect x={svgX} y={svgY_top} width={svgW} height={svgH}
            fill="rgba(255,255,220,0.9)" stroke={a.color} strokeWidth={a.lineWidth * scale}
            strokeOpacity={a.opacity} strokeDasharray={sel ? '5,3' : undefined} pointerEvents="all" />
          <foreignObject x={svgX+2} y={svgY_top+2} width={Math.max(0,svgW-4)} height={Math.max(0,svgH-4)}>
            <div style={{
              fontSize: a.fontSize * scale, color: a.color, fontFamily: 'sans-serif',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: 2,
            }}>{a.text}</div>
          </foreignObject>
        </g>
      )
    }

    if (ann.type === 'cloud') {
      const a = ann as CloudAnn
      if (a.points.length < 2) return null
      const svgPts = a.points.map(([px, py]) => toSvg(px, py) as [number, number])
      const d = makeCloudPath(svgPts, true)
      return <path key={a.id} d={d} fill="none"
        stroke={a.color} strokeWidth={a.lineWidth * scale} strokeOpacity={a.opacity}
        strokeDasharray={sel ? '6,3' : undefined}
        onClick={e => handleAnnotClick(a, e)} style={annStyle(a)} pointerEvents="stroke" />
    }

    if (ann.type === 'polygon' || ann.type === 'polyline') {
      const a = ann as PolyAnn
      if (a.points.length < 2) return null
      const svgPts = a.points.map(([px, py]) => toSvg(px, py).join(',')).join(' ')
      const Tag = a.type === 'polygon' ? 'polygon' : 'polyline'
      return <Tag key={a.id} points={svgPts} fill="none"
        stroke={a.color} strokeWidth={a.lineWidth * scale} strokeOpacity={a.opacity}
        strokeDasharray={sel ? '6,3' : undefined} strokeLinejoin="round"
        onClick={e => handleAnnotClick(a, e)} style={annStyle(a)} pointerEvents="stroke" />
    }

    if (ann.type === 'caret') {
      const a = ann as CaretAnn
      const [sx, sy] = toSvg(a.x, a.y)
      const sz = Math.max(10, a.height * scale)
      return (
        <g key={a.id} onClick={e => handleAnnotClick(a, e)} style={{ ...annStyle(a), ...selBorder(a) }}>
          <polygon points={`${sx},${sy} ${sx + sz/2},${sy - sz} ${sx + sz},${sy}`}
            fill={a.color} fillOpacity={a.opacity * 0.5}
            stroke={a.color} strokeWidth={1.5} strokeOpacity={a.opacity} />
          <line x1={sx} y1={sy + 2} x2={sx + sz} y2={sy + 2}
            stroke={a.color} strokeWidth={1.5} strokeOpacity={a.opacity} />
        </g>
      )
    }

    if (ann.type === 'measure-distance' || ann.type === 'measure-area' || ann.type === 'measure-perimeter') {
      const a = ann as MeasureAnn
      if (a.points.length < 2) return null
      const svgPts = a.points.map(([px, py]) => toSvg(px, py) as [number, number])
      const midX = svgPts.reduce((s, p) => s + p[0], 0) / svgPts.length
      const midY = svgPts.reduce((s, p) => s + p[1], 0) / svgPts.length
      const ptStr = svgPts.map(p => p.join(',')).join(' ')
      const isLine = a.type === 'measure-distance'
      return (
        <g key={a.id} onClick={e => handleAnnotClick(a, e)} style={{ ...annStyle(a), ...selBorder(a) }}>
          {isLine
            ? <line x1={svgPts[0][0]} y1={svgPts[0][1]} x2={svgPts[1][0]} y2={svgPts[1][1]}
                stroke={a.color} strokeWidth={a.lineWidth * scale} strokeOpacity={a.opacity}
                strokeDasharray="4,2" pointerEvents="stroke" />
            : <polygon points={ptStr} fill="rgba(74,158,255,0.06)"
                stroke={a.color} strokeWidth={a.lineWidth * scale} strokeOpacity={a.opacity}
                strokeDasharray="4,2" pointerEvents="all" />}
          {/* Endpoint dots */}
          {svgPts.map((p, i) => (
            <circle key={i} cx={p[0]} cy={p[1]} r={3 * scale}
              fill={a.color} fillOpacity={a.opacity} pointerEvents="none" />
          ))}
          {/* Label */}
          <rect x={midX - 28} y={midY - 10} width={56} height={18} rx={3}
            fill="rgba(0,0,0,0.65)" pointerEvents="none" />
          <text x={midX} y={midY + 5} textAnchor="middle"
            fill={a.color} fontSize={10 * scale} fontFamily="monospace" pointerEvents="none">
            {a.label}
          </text>
        </g>
      )
    }

    if (ann.type === 'link') {
      const a = ann as LinkAnn
      const [svgX1, svgY1] = toSvg(Math.min(a.x1, a.x2), Math.max(a.y1, a.y2))
      const [svgX2, svgY2] = toSvg(Math.max(a.x1, a.x2), Math.min(a.y1, a.y2))
      // Navigation + hover happen in the dedicated LinkLayer (above the text
      // layer). Here we only draw editing chrome — a faint dashed outline when
      // the Link tool is active or this link is selected. We never paint a fill
      // or a text label, which would cover the underlying document text.
      const showOutline = sel || activeTool === 'link'
      return (
        <g key={a.id} onClick={e => handleAnnotClick(a, e)} style={annStyle(a)}>
          <rect x={svgX1} y={svgY1} width={svgX2 - svgX1} height={svgY2 - svgY1}
            fill="transparent"
            stroke={showOutline ? (sel ? '#4a9eff' : '#0066ff') : 'none'}
            strokeWidth={sel ? 2 : 1} strokeOpacity={0.7}
            strokeDasharray={showOutline ? '4,3' : undefined}
            pointerEvents="all" />
        </g>
      )
    }

    return null
  }

  // ── Preview while drawing ────────────────────────────────────────────────

  const renderPreview = () => {
    if (draw.k === 'poly' && draw.pts.length >= 1) {
      const { pts, curX, curY } = draw
      const allPts = [...pts, [curX, curY] as [number, number]]
      const ptStr = allPts.map(p => p.join(',')).join(' ')
      const tool = activeTool
      if (tool === 'cloud') {
        return <path d={makeCloudPath(allPts, false)} fill="none"
          stroke={toolColor} strokeWidth={toolLineWidth * scale} strokeOpacity={toolOpacity} strokeDasharray="4,3" />
      }
      if (tool === 'polygon' || tool === 'measure-area' || tool === 'measure-perimeter') {
        return <>
          <polygon points={ptStr} fill="rgba(74,158,255,0.05)"
            stroke={toolColor} strokeWidth={toolLineWidth * scale} strokeOpacity={toolOpacity} strokeDasharray="4,3" />
          {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={3} fill={toolColor} fillOpacity={0.7} />)}
          <circle cx={curX} cy={curY} r={3} fill={toolColor} fillOpacity={0.4} />
        </>
      }
      if (tool === 'measure-distance') {
        const p0 = pts[0], p1 = [curX, curY] as [number, number]
        const pdfP0 = toPdf(p0[0], p0[1]), pdfP1 = toPdf(curX, curY)
        const dx = pdfP1[0] - pdfP0[0], dy = pdfP1[1] - pdfP0[1]
        const d = Math.sqrt(dx*dx + dy*dy).toFixed(1)
        const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2
        return <>
          <line x1={p0[0]} y1={p0[1]} x2={curX} y2={curY}
            stroke={toolColor} strokeWidth={toolLineWidth * scale} strokeOpacity={toolOpacity} strokeDasharray="4,3" />
          <rect x={mx-26} y={my-10} width={52} height={18} rx={3} fill="rgba(0,0,0,0.6)" />
          <text x={mx} y={my+5} textAnchor="middle" fill={toolColor} fontSize={10*scale} fontFamily="monospace">
            {d} pt
          </text>
        </>
      }
      // polyline
      return <>
        <polyline points={ptStr} fill="none"
          stroke={toolColor} strokeWidth={toolLineWidth * scale} strokeOpacity={toolOpacity} strokeDasharray="4,3" />
        {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={3} fill={toolColor} fillOpacity={0.7} />)}
      </>
    }

    if (draw.k === 'snapshot') {
      const { sx, sy, cx, cy } = draw
      const x = Math.min(sx, cx), y = Math.min(sy, cy)
      const w = Math.abs(cx - sx), h = Math.abs(cy - sy)
      return <rect x={x} y={y} width={w} height={h}
        fill="rgba(74,158,255,0.08)" stroke="#4a9eff" strokeWidth={1.5} strokeDasharray="6,3" />
    }

    if (draw.k === 'callout-size') {
      const { sx, sy, cx, cy } = draw
      const x = Math.min(sx, cx), y = Math.min(sy, cy)
      const w = Math.abs(cx - sx), h = Math.abs(cy - sy)
      return <rect x={x} y={y} width={w} height={h}
        fill="rgba(255,255,220,0.2)" stroke="#4a9eff" strokeWidth={1.5} strokeDasharray="4,3" />
    }

    if (draw.k === 'text-edit-size') {
      const { sx, sy, cx, cy } = draw
      return <rect x={Math.min(sx,cx)} y={Math.min(sy,cy)}
        width={Math.abs(cx-sx)} height={Math.abs(cy-sy)}
        fill="rgba(255,255,255,0.7)" stroke="#ff8800" strokeWidth={1.5} strokeDasharray="4,3" />
    }

    if (draw.k === 'shape' || draw.k === 'textbox-size') {
      const { sx, sy, cx, cy } = draw
      const x = Math.min(sx, cx), y = Math.min(sy, cy)
      const w = Math.abs(cx - sx), h = Math.abs(cy - sy)
      const sw = toolLineWidth * scale
      if (activeTool === 'link')
        return <rect x={x} y={y} width={w} height={h}
          fill="rgba(0,100,255,0.08)" stroke="#0064ff" strokeWidth={1.5} strokeDasharray="4,3" />
      if (activeTool === 'redact')
        return <rect x={x} y={y} width={w} height={h}
          fill="rgba(255,40,40,0.18)" stroke="#ff4444" strokeWidth={1.5} strokeDasharray="4,3" />
      if (activeTool === 'rectangle' || draw.k === 'textbox-size')
        return <rect x={x} y={y} width={w} height={h}
          fill={draw.k === 'textbox-size' ? 'rgba(74,158,255,0.05)' : 'none'}
          stroke={draw.k === 'textbox-size' ? '#4a9eff' : toolColor}
          strokeWidth={draw.k === 'textbox-size' ? 1 : sw}
          strokeOpacity={toolOpacity} strokeDasharray="4,3" />
      if (activeTool === 'ellipse')
        return <ellipse cx={sx + (cx-sx)/2} cy={sy + (cy-sy)/2}
          rx={w/2} ry={h/2} fill="none"
          stroke={toolColor} strokeWidth={sw} strokeOpacity={toolOpacity} strokeDasharray="4,3" />
      if (activeTool === 'line')
        return <line x1={sx} y1={sy} x2={cx} y2={cy}
          stroke={toolColor} strokeWidth={sw} strokeOpacity={toolOpacity} strokeDasharray="4,3" />
      if (activeTool === 'arrow')
        return (
          <g>
            <defs>
              <marker id="pa" markerWidth={10} markerHeight={7} refX={9} refY={3.5} orient="auto">
                <polygon points="0 0, 10 3.5, 0 7" fill={toolColor} fillOpacity={toolOpacity} />
              </marker>
            </defs>
            <line x1={sx} y1={sy} x2={cx} y2={cy}
              stroke={toolColor} strokeWidth={sw} strokeOpacity={toolOpacity}
              markerEnd="url(#pa)" strokeDasharray="4,3" />
          </g>
        )
    }

    if (draw.k === 'ink' && draw.cur.length > 1) {
      const pts = draw.cur.map(([x, y]) => `${x},${y}`).join(' ')
      return <polyline points={pts} fill="none"
        stroke={toolColor} strokeWidth={toolLineWidth * scale} strokeOpacity={toolOpacity}
        strokeLinecap="round" strokeLinejoin="round" />
    }

    return null
  }

  // ── Popups & edit overlays ───────────────────────────────────────────────

  const renderStickyPopup = () => {
    const ann = pageAnnotations.find(a => a.id === openStickyNoteId && a.type === 'stickynote') as StickyNoteAnn | undefined
    if (!ann) return null
    const [sx, sy] = toSvg(ann.x, ann.y)
    const popW = 220, popH = 140
    const px = Math.min(sx, W - popW - 8), py = Math.max(8, sy - popH - 28)
    return (
      <foreignObject x={px} y={py} width={popW} height={popH} style={{ pointerEvents: 'all' }}>
        <div style={{ width: '100%', height: '100%', background: '#fefcbf', borderRadius: 6,
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ background: ann.color, padding: '4px 8px', fontSize: 11, color: '#000', fontWeight: 600 }}>Note</div>
          <textarea style={{ flex: 1, padding: 8, border: 'none', outline: 'none', resize: 'none',
            fontFamily: 'inherit', fontSize: 12, background: 'transparent', color: '#1a1a1a' }}
            value={ann.text} onChange={e => updateAnnotation(ann.id, { text: e.target.value })}
            placeholder="Type a note…" autoFocus />
        </div>
      </foreignObject>
    )
  }

  const renderTextBoxEdit = () => {
    if (draw.k !== 'textbox-edit') return null
    const { x, y, w, h } = draw
    const rtl = settings.rtlText
    return (
      <foreignObject x={x} y={y} width={w} height={h} style={{ pointerEvents: 'all' }}>
        <textarea style={{ width: '100%', height: '100%', background: 'rgba(255,255,220,0.9)', color: toolColor,
          border: '2px solid #4a9eff', outline: 'none', resize: 'none', fontFamily: 'sans-serif',
          fontSize: toolFontSize * scale, padding: 4, boxSizing: 'border-box',
          direction: rtl ? 'rtl' : 'ltr', textAlign: rtl ? 'right' : 'left' }}
          autoFocus value={draw.text}
          onChange={e => setDraw(d => ({ ...(d as any), text: e.target.value } as DrawPhase))}
          onBlur={e => commitTextBox(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') setDraw({ k: 'idle' }) }}
          placeholder="Type text…" />
      </foreignObject>
    )
  }

  const renderTypewriterEdit = () => {
    if (draw.k !== 'typewriter-edit') return null
    const { x, y, text } = draw
    const rtl = settings.rtlText
    return (
      <foreignObject x={x} y={y} width={Math.max(120, W - x - 8)} height={toolFontSize * scale * 4}
        style={{ pointerEvents: 'all' }}>
        <input type="text" style={{ width: '100%', background: 'transparent', color: toolColor,
          border: 'none', borderBottom: `2px solid ${toolColor}`, outline: 'none',
          fontFamily: 'sans-serif', fontSize: toolFontSize * scale, padding: 2,
          direction: rtl ? 'rtl' : 'ltr', textAlign: rtl ? 'right' : 'left' }}
          autoFocus value={text}
          onChange={e => setDraw(d => ({ ...(d as any), text: e.target.value } as DrawPhase))}
          onBlur={e => commitTypewriter(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') setDraw({ k: 'idle' })
            if (e.key === 'Enter' && !e.shiftKey) commitTypewriter((e.target as HTMLInputElement).value)
          }}
          placeholder="Type here…" />
      </foreignObject>
    )
  }

  const renderTextEditBox = () => {
    if (draw.k !== 'text-edit-edit') return null
    const { x, y, w, h } = draw
    const fs = (draw.fontSize ?? toolFontSize)
    const col = draw.color ?? toolColor
    // Caret-in-place mode: editor rendered in the real page font, tight border.
    const inPlace = !!draw.fontFamily
    const fam = draw.fontFamily ? `'${draw.fontFamily}', ${draw.sample?.cssFamily ?? 'serif'}`
      : draw.sample?.cssFamily ?? 'serif'
    const boxH = Math.max(h, fs * scale + 8)
    return (
      <g>
        <foreignObject x={x} y={y} width={w} height={boxH} style={{ pointerEvents: 'all' }}>
          <textarea style={{ width: '100%', height: '100%', background: 'white', color: col,
            border: inPlace ? '1px solid #4a9eff' : '2px solid #ff8800', outline: 'none', resize: 'none',
            fontFamily: fam, fontSize: fs * scale, lineHeight: inPlace ? 1.0 : 1.2,
            fontWeight: (draw.fontFamily || draw.sample?.cssFamily) ? undefined : (draw.sample?.bold ? 700 : 400),
            fontStyle: (draw.fontFamily || draw.sample?.cssFamily) ? undefined : (draw.sample?.italic ? 'italic' : 'normal'),
            padding: '0 1px', boxSizing: 'border-box', overflow: 'hidden' }}
            autoFocus value={draw.text}
            onFocus={e => e.currentTarget.select()}
            onChange={e => setDraw(d => ({ ...(d as any), text: e.target.value } as DrawPhase))}
            onBlur={e => {
              if (cancelEditRef.current) { cancelEditRef.current = false; setDraw({ k: 'idle' }); return }
              commitTextEdit(e.target.value)
            }}
            onKeyDown={e => {
              if (e.key === 'Escape') { e.preventDefault(); cancelEditRef.current = true; e.currentTarget.blur() }
              else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur() }
            }}
            placeholder="Edit text…" />
        </foreignObject>
        <foreignObject x={x} y={y + boxH + 2} width={Math.max(w, 220)} height={18} style={{ pointerEvents: 'none' }}>
          <div style={{ fontSize: 11, fontFamily: 'sans-serif', color: '#ff8800', fontWeight: 600,
            background: 'rgba(0,0,0,0.04)', whiteSpace: 'nowrap' }}>
            Enter = apply · Shift+Enter = new line · Esc = cancel
          </div>
        </foreignObject>
      </g>
    )
  }

  const renderCalloutEdit = () => {
    if (draw.k !== 'callout-edit') return null
    const { x, y, w, h, tipSvgX, tipSvgY } = draw
    return (
      <>
        <line x1={tipSvgX} y1={tipSvgY} x2={x} y2={y + h / 2}
          stroke={toolColor} strokeWidth={toolLineWidth * scale} strokeOpacity={toolOpacity} strokeDasharray="4,3" />
        <circle cx={tipSvgX} cy={tipSvgY} r={5} fill={toolColor} fillOpacity={0.6} />
        <foreignObject x={x} y={y} width={w} height={h} style={{ pointerEvents: 'all' }}>
          <textarea style={{ width: '100%', height: '100%', background: 'rgba(255,255,220,0.95)',
            color: toolColor, border: `2px solid ${toolColor}`, outline: 'none', resize: 'none',
            fontFamily: 'sans-serif', fontSize: toolFontSize * scale, padding: 4, boxSizing: 'border-box' }}
            autoFocus value={draw.text}
            onChange={e => setDraw(d => ({ ...(d as any), text: e.target.value } as DrawPhase))}
            onBlur={e => commitCallout(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') setDraw({ k: 'idle' }) }}
            placeholder="Callout text…" />
        </foreignObject>
      </>
    )
  }

  const commitLink = () => {
    if (draw.k !== 'link-pending') return
    const { x1, y1, x2, y2, href, destPage } = draw
    const trimHref = href.trim()
    const pageNum_ = parseInt(destPage, 10)
    if (!trimHref && isNaN(pageNum_)) { setDraw({ k: 'idle' }); return }
    const ann: LinkAnn = {
      id: newId(), type: 'link', pageNum,
      color: '#0055cc', opacity: 0.3, createdAt: Date.now(),
      x1, y1, x2, y2,
      ...(trimHref ? { href: trimHref } : { destPage: pageNum_ }),
    }
    addAnnotation(ann)
    setDraw({ k: 'idle' })
  }

  const renderLinkPending = () => {
    if (draw.k !== 'link-pending') return null
    const [svgX1, svgY1] = toSvg(Math.min(draw.x1, draw.x2), Math.max(draw.y1, draw.y2))
    const [svgX2, svgY2] = toSvg(Math.max(draw.x1, draw.x2), Math.min(draw.y1, draw.y2))
    const formW = 280, formH = 130
    const fx = Math.min(svgX1, W - formW - 8), fy = Math.max(8, svgY1 - formH - 8)
    return (
      <>
        <rect x={svgX1} y={svgY1} width={svgX2 - svgX1} height={svgY2 - svgY1}
          fill="rgba(0,85,204,0.12)" stroke="#0055cc" strokeWidth={1.5} strokeDasharray="4,3" />
        <foreignObject x={fx} y={fy} width={formW} height={formH} style={{ pointerEvents: 'all' }}>
          <div style={{ background: 'var(--bg-secondary, #2a2a2a)', border: '1px solid var(--border, #444)',
            borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 6,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)', fontSize: 12, color: 'var(--text, #e0e0e0)' }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>Add Link</div>
            <input type="text" placeholder="URL (https://…)"
              value={draw.href}
              onChange={e => setDraw(d => ({ ...(d as any), href: e.target.value } as DrawPhase))}
              autoFocus
              style={{ background: 'var(--bg-primary, #1e1e1e)', color: 'inherit', border: '1px solid var(--border, #555)',
                borderRadius: 4, padding: '3px 6px', fontSize: 12, outline: 'none', width: '100%', boxSizing: 'border-box' }}
              onKeyDown={e => { if (e.key === 'Enter') commitLink(); if (e.key === 'Escape') setDraw({ k: 'idle' }) }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ whiteSpace: 'nowrap', fontSize: 11, opacity: 0.7 }}>or page:</span>
              <input type="number" placeholder="page #" min={1}
                value={draw.destPage}
                onChange={e => setDraw(d => ({ ...(d as any), destPage: e.target.value } as DrawPhase))}
                style={{ background: 'var(--bg-primary, #1e1e1e)', color: 'inherit', border: '1px solid var(--border, #555)',
                  borderRadius: 4, padding: '3px 6px', fontSize: 12, outline: 'none', width: 80, boxSizing: 'border-box' }}
                onKeyDown={e => { if (e.key === 'Enter') commitLink(); if (e.key === 'Escape') setDraw({ k: 'idle' }) }} />
            </div>
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button onClick={() => setDraw({ k: 'idle' })}
                style={{ padding: '3px 10px', fontSize: 11, background: 'transparent', border: '1px solid var(--border, #555)',
                  borderRadius: 4, color: 'inherit', cursor: 'pointer' }}>Cancel</button>
              <button onClick={commitLink}
                style={{ padding: '3px 10px', fontSize: 11, background: '#0055cc', border: 'none',
                  borderRadius: 4, color: '#fff', cursor: 'pointer' }}>OK</button>
            </div>
          </div>
        </foreignObject>
      </>
    )
  }

  // ── Pointer events setup ─────────────────────────────────────────────────

  // Text-select mode (left-palette "Text": no tool + pan off) must let mouse events
  // fall through to the PDF.js text layer below, so the SVG overlay goes transparent.
  const textSelectMode = activeTool === null && !panMode
  const svgPointerEvents: React.CSSProperties['pointerEvents'] =
    activeTool === 'object-edit'
      ? 'none'
      : textSelectMode
      ? 'none'
      : isDragDrawTool || isTextEditTool || isCalloutTool || isPolyTool || isCaretTool || imgDrag.k !== 'idle'
        || draw.k === 'link-pending'
      ? 'all'
      : isMarkupTool ? 'none' : 'all'

  const needsDragHandlers = isDragDrawTool || isTextEditTool || isCalloutTool || imgDrag.k !== 'idle'

  return (
    <div
      className="annot-overlay"
      style={{ position: 'absolute', top: 0, left: 0, width: W, height: H, pointerEvents: 'none' }}
    >
      <svg
        ref={svgRef}
        width={W} height={H}
        style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible', pointerEvents: svgPointerEvents }}
        onMouseDown={needsDragHandlers ? handleMouseDown : undefined}
        onMouseMove={needsDragHandlers || draw.k === 'poly' ? handleMouseMove : undefined}
        onMouseUp={needsDragHandlers ? handleMouseUp : undefined}
        onClick={
          isPolyTool ? handlePolyClick :
          isTypewriterTool ? handleTypewriterClick :
          isCaretTool ? handleSvgClick :
          (!activeTool || activeTool === 'select' || activeTool === 'eraser') ? handleSvgClick : undefined
        }
        onDoubleClick={isPolyTool ? handlePolyDblClick : undefined}
        onContextMenu={handleSvgContextMenu}
      >
        {isTextEditTool && editBoxes.map((b, i) => {
          const [bx1, by2] = toSvg(b.x1, b.y2) // top-left
          const [bx2, by1] = toSvg(b.x2, b.y1) // bottom-right
          return <rect key={`etb-${i}`} x={bx1} y={by2}
            width={Math.max(1, bx2 - bx1)} height={Math.max(1, by1 - by2)}
            fill="none" stroke="#4a9eff" strokeWidth={1} strokeOpacity={0.45}
            pointerEvents="none" rx={1} />
        })}
        {pageAnnotations.map(renderAnn)}
        {renderSelectHitAreas()}
        {renderSelectionChrome()}
        {renderPreview()}
        {renderStickyPopup()}
        {renderTextBoxEdit()}
        {renderTypewriterEdit()}
        {renderTextEditBox()}
        {renderCalloutEdit()}
        {renderLinkPending()}
        {/* Poly drawing: hint for first click */}
        {draw.k === 'poly' && draw.pts.length > 0 && (
          <text x={draw.curX + 8} y={draw.curY - 6} fill={toolColor} fontSize={10}
            fontFamily="sans-serif" pointerEvents="none" opacity={0.7}>
            {draw.pts.length} pt{draw.pts.length > 1 ? 's' : ''} — DblClick or Enter to finish
          </text>
        )}
        {/* Measure distance: auto-finish after 2 clicks */}
        {draw.k === 'poly' && activeTool === 'measure-distance' && draw.pts.length === 1 && (
          <text x={draw.curX + 8} y={draw.curY - 6} fill={toolColor} fontSize={10}
            fontFamily="sans-serif" pointerEvents="none" opacity={0.7}>Click second point</text>
        )}
      </svg>

      {ctxMenu && createPortal(
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y}
          items={buildAnnotMenuItems(ctxMenu.annId)} onClose={() => setCtxMenu(null)} />,
        document.body)}
      {textMenu && createPortal(
        <ContextMenu x={textMenu.x} y={textMenu.y}
          items={buildTextMenuItems()} onClose={() => setTextMenu(null)} />,
        document.body)}
    </div>
  )
}
