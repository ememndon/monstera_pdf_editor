import { useMemo } from 'react'
import { ClipboardList, Copy, Download } from 'lucide-react'
import { usePdfStore } from '../store/usePdfStore'
import type { Annotation } from '../types/annotations'
import { copyText } from '../utils/copyText'

const TYPE_LABELS: Record<string, string> = {
  highlight: 'Highlight', underline: 'Underline', strikethrough: 'Strikethrough',
  ink: 'Ink / Pen', rectangle: 'Rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow',
  polygon: 'Polygon', polyline: 'Polyline', cloud: 'Cloud',
  textbox: 'Text Box', stickynote: 'Sticky Note', stamp: 'Stamp',
  callout: 'Callout', caret: 'Caret', typewriter: 'Typewriter', 'text-edit': 'Text Edit',
  redact: 'Redaction', 'placed-image': 'Image',
  'measure-distance': 'Measurement (Distance)', 'measure-area': 'Measurement (Area)',
  'measure-perimeter': 'Measurement (Perimeter)',
}

function getText(ann: Annotation): string {
  switch (ann.type) {
    case 'highlight': case 'underline': case 'strikethrough': return ann.selectedText || ''
    case 'textbox': return ann.text
    case 'stickynote': return ann.text
    case 'typewriter': return ann.text
    case 'text-edit': return ann.text
    case 'callout': return ann.text
    case 'stamp': return ann.stampName
    case 'measure-distance': case 'measure-area': case 'measure-perimeter': return ann.label
    default: return ''
  }
}

interface Props {
  onClose: () => void
}

export default function SummarizeCommentsDialog({ onClose }: Props) {
  const annotations = usePdfStore(s => s.annotations)
  const fileName    = usePdfStore(s => s.fileName)

  const byType = useMemo(() => {
    const map: Record<string, number> = {}
    for (const a of annotations) map[a.type] = (map[a.type] || 0) + 1
    return map
  }, [annotations])

  const withText = useMemo(() =>
    annotations.filter(a => getText(a).trim())
      .sort((a, b) => a.pageNum - b.pageNum),
    [annotations])

  const buildReport = () => {
    const lines: string[] = [
      `Comment Summary — ${fileName}`,
      `Generated: ${new Date().toLocaleString()}`,
      `Total annotations: ${annotations.length}`,
      '',
      '── By Type ──',
      ...Object.entries(byType).map(([t, n]) => `  ${TYPE_LABELS[t] ?? t}: ${n}`),
    ]
    if (withText.length > 0) {
      lines.push('', '── Text Content ──')
      for (const a of withText) {
        lines.push(`[Page ${a.pageNum}] ${TYPE_LABELS[a.type] ?? a.type}: ${getText(a)}`)
      }
    }
    return lines.join('\n')
  }

  const copyToClipboard = async () => {
    await copyText(buildReport())
  }

  const saveToFile = async () => {
    const path = await window.electronAPI.saveFileDialog(
      fileName.replace(/\.pdf$/i, '_comments.txt')
    )
    if (!path) return
    const enc = new TextEncoder()
    await window.electronAPI.writeFile(path, enc.encode(buildReport()).buffer)
  }

  return (
    <div className="modal-overlay">
      <div className="modal-box" style={{ width: 560, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-title"><ClipboardList size={18} /> Comment Summary</div>

        {/* Stats */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          <div style={statBox}>
            <span style={statNum}>{annotations.length}</span>
            <span style={statLbl}>Total</span>
          </div>
          {Object.entries(byType).slice(0, 6).map(([t, n]) => (
            <div key={t} style={statBox}>
              <span style={statNum}>{n}</span>
              <span style={statLbl}>{(TYPE_LABELS[t] ?? t).split(' ')[0]}</span>
            </div>
          ))}
        </div>

        {/* Annotations with text */}
        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid var(--border)',
          borderRadius: 4, background: 'var(--bg-secondary)' }}>
          {annotations.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              No annotations in this document.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', position: 'sticky', top: 0,
                  background: 'var(--bg-ribbon)' }}>
                  <th style={th}>Page</th>
                  <th style={th}>Type</th>
                  <th style={th}>Content</th>
                </tr>
              </thead>
              <tbody>
                {[...annotations].sort((a, b) => a.pageNum - b.pageNum).map(a => (
                  <tr key={a.id} style={{ borderBottom: '1px solid var(--border-light)' }}>
                    <td style={{ ...td, textAlign: 'center', fontWeight: 600 }}>{a.pageNum}</td>
                    <td style={td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <div style={{ width: 10, height: 10, borderRadius: 2, background: a.color, flexShrink: 0 }} />
                        {TYPE_LABELS[a.type] ?? a.type}
                      </div>
                    </td>
                    <td style={{ ...td, color: 'var(--text-muted)', maxWidth: 200,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {getText(a) || <span style={{ opacity: 0.4 }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="modal-actions" style={{ marginTop: 14 }}>
          <button className="modal-btn-secondary" onClick={onClose}>Close</button>
          <button className="modal-btn-secondary" onClick={copyToClipboard} disabled={annotations.length === 0}>
            <Copy size={14} /> Copy to Clipboard
          </button>
          <button className="modal-btn-primary" onClick={saveToFile} disabled={annotations.length === 0}>
            <Download size={14} /> Save as .txt
          </button>
        </div>
      </div>
    </div>
  )
}

const statBox: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center',
  padding: '6px 12px', background: 'var(--bg-secondary)',
  border: '1px solid var(--border)', borderRadius: 6, minWidth: 56,
}
const statNum: React.CSSProperties = { fontSize: 20, fontWeight: 700, color: 'var(--accent)', lineHeight: 1 }
const statLbl: React.CSSProperties = { fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }
const th: React.CSSProperties = { padding: '6px 10px', textAlign: 'left', fontWeight: 600,
  color: 'var(--text-muted)', fontSize: 11 }
const td: React.CSSProperties = { padding: '5px 10px', verticalAlign: 'middle' }
