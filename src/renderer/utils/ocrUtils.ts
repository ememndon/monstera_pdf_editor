import { createWorker } from 'tesseract.js'
import { tesseractOptions } from './tesseractPaths'
import type { PDFDocumentProxy } from 'pdfjs-dist'

export interface OcrWord {
  text: string
  x: number   // pts from left edge of page
  y: number   // pts from bottom edge (PDF convention)
  w: number   // width in pts
  h: number   // height in pts
}

export const OCR_LANGUAGES = [
  { code: 'eng',     label: 'English' },
  { code: 'fra',     label: 'French' },
  { code: 'deu',     label: 'German' },
  { code: 'spa',     label: 'Spanish' },
  { code: 'por',     label: 'Portuguese' },
  { code: 'ita',     label: 'Italian' },
  { code: 'nld',     label: 'Dutch' },
  { code: 'rus',     label: 'Russian' },
  { code: 'jpn',     label: 'Japanese' },
  { code: 'chi_sim', label: 'Chinese (Simplified)' },
  { code: 'chi_tra', label: 'Chinese (Traditional)' },
  { code: 'kor',     label: 'Korean' },
  { code: 'ara',     label: 'Arabic' },
]

const SCANNED_CHAR_THRESHOLD = 15
export const OCR_RENDER_SCALE = 2.0

interface RecognizedBlocks {
  blocks?: Array<{
    paragraphs?: Array<{
      lines?: Array<{
        words?: Array<{ text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }>
      }>
    }>
  }> | null
}

export function wordsFromRecognition(data: RecognizedBlocks, scaleX: number, scaleY: number, pageH: number): OcrWord[] {
  const words: OcrWord[] = []
  for (const block of (data.blocks ?? [])) {
    for (const para of (block.paragraphs ?? [])) {
      for (const line of (para.lines ?? [])) {
        for (const word of (line.words ?? [])) {
          if (!word.text.trim() || word.confidence < 20) continue
          const { x0, y0, x1, y1 } = word.bbox
          words.push({
            text: word.text,
            x: x0 * scaleX,
            y: pageH - y1 * scaleY,       // flip Y: Tesseract y=0 top → PDF y=0 bottom
            w: (x1 - x0) * scaleX,
            h: (y1 - y0) * scaleY,
          })
        }
      }
    }
  }
  return words
}

export async function isPageScanned(pdfDoc: PDFDocumentProxy, pageNum: number): Promise<boolean> {
  const page = await pdfDoc.getPage(pageNum)
  const content = await page.getTextContent()
  const chars = content.items.reduce(
    (sum, item) => sum + (('str' in item) ? (item as { str: string }).str.length : 0),
    0
  )
  return chars < SCANNED_CHAR_THRESHOLD
}

export async function detectScannedPages(
  pdfDoc: PDFDocumentProxy,
  numPages: number
): Promise<number[]> {
  const scanned: number[] = []
  for (let p = 1; p <= numPages; p++) {
    if (await isPageScanned(pdfDoc, p)) scanned.push(p)
  }
  return scanned
}

export async function runOcrOnPages(
  pdfDoc: PDFDocumentProxy,
  pageSizes: Array<{ width: number; height: number }>,
  pageNums: number[],
  language: string,
  onPageDone: (pageNum: number, words: OcrWord[]) => void,
  onProgress: (done: number, total: number, pageProgress: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const worker = await createWorker(language, 1, {
    ...tesseractOptions(),
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') {
        onProgress(-1, pageNums.length, m.progress)
      }
    },
  })

  try {
    for (let i = 0; i < pageNums.length; i++) {
      if (signal?.aborted) break

      const pageNum = pageNums[i]
      const pageSize = pageSizes[pageNum - 1]
      const pageW = pageSize?.width ?? 612
      const pageH = pageSize?.height ?? 792

      onProgress(i, pageNums.length, 0)

      const page = await pdfDoc.getPage(pageNum)
      const viewport = page.getViewport({ scale: OCR_RENDER_SCALE })
      const canvas = document.createElement('canvas')
      canvas.width = viewport.width
      canvas.height = viewport.height
      await page.render({ canvas, viewport, annotationMode: 0 }).promise

      // tesseract.js v6+: word lists are no longer in the default output —
      // request the blocks tree and flatten it ourselves.
      const { data } = await worker.recognize(canvas, {}, { blocks: true })

      const words = wordsFromRecognition(data, pageW / canvas.width, pageH / canvas.height, pageH)

      onPageDone(pageNum, words)
      onProgress(i + 1, pageNums.length, 1)
    }
  } finally {
    await worker.terminate()
  }
}
