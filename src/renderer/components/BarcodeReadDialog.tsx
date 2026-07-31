import { useEffect, useState } from 'react'
import StatusText from './StatusText'
import { usePdfStore } from '../store/usePdfStore'
import { readBarcodesFromCanvas, type BarcodeResult } from '../utils/barcodeRead'
import { copyText } from '../utils/copyText'

export default function BarcodeReadDialog({ onClose }: { onClose: () => void }) {
  const currentPage = usePdfStore(s => s.currentPage)
  const [results, setResults] = useState<BarcodeResult[] | null>(null)
  const [status, setStatus] = useState('Scanning current page…')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const canvas = document.querySelector<HTMLCanvasElement>(
          `.pdf-page-wrapper[data-page="${currentPage}"] canvas.pdf-page-canvas`,
        )
        if (!canvas) { setStatus('Could not read the current page — scroll it into view and retry.'); return }
        const found = await readBarcodesFromCanvas(canvas)
        if (cancelled) return
        setResults(found)
        setStatus(found.length ? `Found ${found.length} code${found.length !== 1 ? 's' : ''} on page ${currentPage}.` : `No barcodes or QR codes found on page ${currentPage}.`)
      } catch (e: any) {
        if (!cancelled) setStatus(`Error: ${e?.message ?? 'decode failed'}`)
      }
    })()
    return () => { cancelled = true }
  }, [currentPage])

  const isUrl = (t: string) => /^(https?:\/\/|www\.)/i.test(t)

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-box" style={{ width: 480, maxHeight: '70vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-title">▦ Read Barcodes / QR</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}><StatusText status={status} /></div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {results && results.map((r, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 4px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 10, color: 'var(--text-dim)', minWidth: 70 }}>{r.format}</span>
              <span style={{ flex: 1, fontSize: 13, wordBreak: 'break-all', color: 'var(--text-primary)' }}>{r.text}</span>
              <button className="modal-btn-secondary" style={{ fontSize: 11, padding: '2px 8px' }}
                onClick={() => void copyText(r.text)}>Copy</button>
              {isUrl(r.text) && (
                <button className="modal-btn-secondary" style={{ fontSize: 11, padding: '2px 8px' }}
                  onClick={() => window.electronAPI.binsOpenUrl(r.text.startsWith('http') ? r.text : 'https://' + r.text).catch(() => {})}>Open</button>
              )}
            </div>
          ))}
        </div>

        <div className="modal-actions">
          <button className="modal-btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
