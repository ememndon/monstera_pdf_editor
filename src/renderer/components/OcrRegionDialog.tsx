import { useRef, useState, useEffect } from 'react'
import { ScanText, Copy, Check } from 'lucide-react'
import { usePdfStore } from '../store/usePdfStore'
import { createWorker } from 'tesseract.js'
import { tesseractOptions } from '../utils/tesseractPaths'
import { OCR_LANGUAGES } from '../utils/ocrUtils'

interface Props { onClose: () => void }

export default function OcrRegionDialog({ onClose }: Props) {
  const pdfDoc    = usePdfStore(s => s.pdfDoc)
  const pageSizes = usePdfStore(s => s.pageSizes)
  const currentPage = usePdfStore(s => s.currentPage)
  const addAnnotation = usePdfStore(s => s.addAnnotation)

  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const selBoxRef    = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const dragging     = useRef(false)
  const startPt      = useRef({ x: 0, y: 0 })

  const [rendered,   setRendered]  = useState(false)
  const [selection,  setSelection] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [language,   setLanguage]  = useState('eng')
  const [running,    setRunning]   = useState(false)
  const [result,     setResult]    = useState('')
  const [copyDone,   setCopyDone]  = useState(false)

  const SCALE = 1.5

  useEffect(() => {
    if (!pdfDoc) return
    pdfDoc.getPage(currentPage).then(page => {
      const vp     = page.getViewport({ scale: SCALE })
      const canvas = canvasRef.current!
      canvas.width  = Math.ceil(vp.width)
      canvas.height = Math.ceil(vp.height)
      page.render({ canvas, viewport: vp }).promise.then(() => setRendered(true))
    })
  }, [pdfDoc, currentPage])

  const getCanvasPos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const scaleX = canvasRef.current!.width  / rect.width
    const scaleY = canvasRef.current!.height / rect.height
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY }
  }

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const pos = getCanvasPos(e)
    startPt.current = pos
    dragging.current = true
    setSelection(null); setResult('')
  }

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragging.current) return
    const pos = getCanvasPos(e)
    const x = Math.min(startPt.current.x, pos.x)
    const y = Math.min(startPt.current.y, pos.y)
    const w = Math.abs(pos.x - startPt.current.x)
    const h = Math.abs(pos.y - startPt.current.y)
    selBoxRef.current = { x, y, w, h }
    setSelection({ x, y, w, h })
    // Redraw overlay
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    pdfDoc?.getPage(currentPage).then(page => {
      const vp = page.getViewport({ scale: SCALE })
      page.render({ canvas, viewport: vp }).promise.then(() => {
        ctx.strokeStyle = '#4a9eff'
        ctx.lineWidth   = 2
        ctx.setLineDash([4, 2])
        ctx.strokeRect(x, y, w, h)
        ctx.fillStyle = 'rgba(74,158,255,0.12)'
        ctx.fillRect(x, y, w, h)
        ctx.setLineDash([])
      })
    })
  }

  const onMouseUp = () => { dragging.current = false }

  const runOcr = async () => {
    const sel = selBoxRef.current
    const canvas = canvasRef.current
    if (!sel || !canvas || sel.w < 10 || sel.h < 10) return
    setRunning(true); setResult('')
    try {
      const crop = document.createElement('canvas')
      crop.width  = sel.w; crop.height = sel.h
      crop.getContext('2d')!.drawImage(canvas, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h)
      const worker = await createWorker(language, 1, tesseractOptions())
      const { data } = await worker.recognize(crop)
      await worker.terminate()
      setResult(data.text.trim())
    } catch (e: any) {
      setResult(`Error: ${e.message}`)
    } finally {
      setRunning(false)
    }
  }

  const insertAsAnnotation = () => {
    if (!result || !selection) return
    const { newId } = require('../utils/annotationUtils')
    const ps = pageSizes[currentPage - 1]
    const x = selection.x / SCALE / (canvasRef.current!.width / ps.width) / SCALE
    const y = (canvasRef.current!.height - selection.y - selection.h) / SCALE
    addAnnotation({
      id: newId(), type: 'typewriter', pageNum: currentPage,
      x, y, text: result,
      color: '#000000', opacity: 1, lineWidth: 1, fontSize: 12,
    } as any)
    onClose()
  }

  const copyText = () => {
    navigator.clipboard.writeText(result)
    setCopyDone(true)
    setTimeout(() => setCopyDone(false), 1500)
  }

  return (
    <div className="modal-overlay">
      <div className="modal-box" style={{ width: 680, maxHeight: '92vh', overflowY: 'auto' }}>
        <div className="modal-title"><ScanText size={18} /> OCR Selected Region</div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
          Drag to select a region on page {currentPage}, then run OCR on just that area.
        </p>

        <div className="modal-field" style={{ marginBottom: 8 }}>
          <label className="modal-label" style={{ display: 'inline', marginRight: 8 }}>Language:</label>
          <select className="annot-select" style={{ fontSize: 12 }}
            value={language} onChange={e => setLanguage(e.target.value)}>
            {OCR_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </div>

        <div style={{ overflow: 'auto', maxHeight: 420, border: '1px solid var(--border)', borderRadius: 4 }}>
          <canvas ref={canvasRef}
            style={{ display: 'block', cursor: 'crosshair', maxWidth: '100%' }}
            onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} />
        </div>

        {!rendered && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>Rendering page…</div>}

        {result && (
          <div style={{ marginTop: 10 }}>
            <label className="modal-label">Recognized text</label>
            <textarea readOnly value={result}
              style={{ width: '100%', height: 80, fontSize: 12, padding: 8, resize: 'vertical',
                background: 'var(--bg-secondary)', color: 'var(--text-primary)',
                border: '1px solid var(--border)', borderRadius: 4, boxSizing: 'border-box' }} />
          </div>
        )}

        <div className="modal-actions" style={{ marginTop: 12 }}>
          <button className="modal-btn-secondary" onClick={onClose}>Close</button>
          {result && (
            <>
              <button className="modal-btn-secondary" onClick={copyText}>
                {copyDone ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy Text</>}
              </button>
              <button className="modal-btn-secondary" onClick={insertAsAnnotation}>
                Insert as Annotation
              </button>
            </>
          )}
          <button className="modal-btn-primary" onClick={runOcr}
            disabled={!selection || running || !rendered}>
            {running ? 'Running OCR…' : 'Run OCR on Selection'}
          </button>
        </div>
      </div>
    </div>
  )
}
