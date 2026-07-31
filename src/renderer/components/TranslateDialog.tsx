import { useState } from 'react'
import { Globe, X, ArrowLeft, ArrowRight, Download } from 'lucide-react'
import { usePdfStore } from '../store/usePdfStore'
import { copyText } from '../utils/copyText'

const LANGUAGES = [
  { code: 'es', name: 'Spanish' }, { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' }, { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' }, { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' }, { code: 'ko', name: 'Korean' },
  { code: 'ru', name: 'Russian' }, { code: 'ar', name: 'Arabic' },
  { code: 'nl', name: 'Dutch' }, { code: 'pl', name: 'Polish' },
  { code: 'sv', name: 'Swedish' }, { code: 'tr', name: 'Turkish' },
  { code: 'uk', name: 'Ukrainian' }, { code: 'hi', name: 'Hindi' },
]

// Free MyMemory API — 500 char/request limit, chunked here
async function translateChunk(text: string, targetLang: string): Promise<string> {
  const resp = await fetch(
    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${targetLang}&de=tenslor.ai%40gmail.com`
  )
  if (!resp.ok) throw new Error(`Translation API error: ${resp.status}`)
  const data = await resp.json()
  if (data.responseStatus !== 200) throw new Error(data.responseMessage ?? 'Translation failed')
  return data.responseData?.translatedText ?? text
}

async function translateText(text: string, targetLang: string, onProgress: (pct: number) => void): Promise<string> {
  const CHUNK = 450
  const lines = text.split('\n')
  const chunks: string[] = []
  let current = ''

  for (const line of lines) {
    if ((current + '\n' + line).length > CHUNK) {
      if (current) chunks.push(current.trim())
      current = line
    } else {
      current = current ? current + '\n' + line : line
    }
  }
  if (current.trim()) chunks.push(current.trim())

  const results: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    onProgress(Math.round(((i + 1) / chunks.length) * 100))
    try {
      const translated = await translateChunk(chunks[i], targetLang)
      results.push(translated)
    } catch {
      results.push(chunks[i])  // fallback to original on error
    }
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 300))  // rate limit
  }
  return results.join('\n\n')
}

export default function TranslateDialog({ onClose }: { onClose: () => void }) {
  const pdfBytes    = usePdfStore(s => s.pdfBytes)
  const numPages    = usePdfStore(s => s.numPages)
  const currentPage = usePdfStore(s => s.currentPage)

  const [targetLang,      setTargetLang]      = useState('es')
  const [pageRange,       setPageRange]        = useState<'current' | 'all'>('current')
  const [sourceText,      setSourceText]       = useState('')
  const [translatedText,  setTranslatedText]   = useState('')
  const [loading,         setLoading]          = useState(false)
  const [translating,     setTranslating]      = useState(false)
  const [progress,        setProgress]         = useState(0)
  const [step,            setStep]             = useState<'setup' | 'review' | 'result'>('setup')
  const [error,           setError]            = useState('')

  const handleExtract = async () => {
    if (!pdfBytes) return
    setLoading(true); setError('')
    try {
      const pages = await window.electronAPI.mupdfExtractAllText(pdfBytes.buffer as ArrayBuffer)
      const filtered = pageRange === 'current'
        ? pages.filter(p => p.pageNum === currentPage)
        : pages
      setSourceText(filtered.map(p => `=== Page ${p.pageNum} ===\n${p.text}`).join('\n\n'))
      setStep('review')
    } catch (e) {
      setError(`Error extracting text: ${(e as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  const handleTranslate = async () => {
    if (!sourceText.trim()) return
    setTranslating(true); setError(''); setProgress(0)
    try {
      const result = await translateText(sourceText, targetLang, pct => setProgress(pct))
      setTranslatedText(result)
      setStep('result')
    } catch (e: unknown) {
      setError(`Translation error: ${(e as Error).message}`)
    } finally {
      setTranslating(false)
    }
  }

  const handleCopy = async (text: string) => { await copyText(text) }

  const handleSave = async (text: string, suffix: string) => {
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `translation_${targetLang}_${suffix}.txt`; a.click()
    URL.revokeObjectURL(url)
  }

  const langName = LANGUAGES.find(l => l.code === targetLang)?.name ?? targetLang

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ width: 680, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span><Globe size={17} /> Translate Document</span>
          <button className="modal-close" onClick={onClose}><X size={16} /></button>
        </div>

        {/* Step 1: Setup */}
        {step === 'setup' && (
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, opacity: 0.7, display: 'block', marginBottom: 4 }}>Target language</label>
              <select value={targetLang} onChange={e => setTargetLang(e.target.value)} className="modal-select">
                {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, opacity: 0.7, display: 'block', marginBottom: 4 }}>Page scope</label>
              <div style={{ display: 'flex', gap: 10 }}>
                {(['current', 'all'] as const).map(v => (
                  <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 13 }}>
                    <input type="radio" value={v} checked={pageRange === v} onChange={() => setPageRange(v)} />
                    {v === 'current' ? `Current page (${currentPage})` : `All pages (${numPages})`}
                  </label>
                ))}
              </div>
            </div>
            <div style={{ fontSize: 12, opacity: 0.6, background: 'var(--bg-primary)',
              padding: '8px 10px', borderRadius: 4, lineHeight: 1.5 }}>
              Uses MyMemory free translation API. Text is translated in-app — no browser needed.
              Quality is best for common language pairs. Large documents are translated chunk by chunk.
            </div>
            {error && <div style={{ color: '#ff5555', fontSize: 12 }}>{error}</div>}
          </div>
        )}

        {/* Step 2: Review extracted text */}
        {step === 'review' && (
          <>
            <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, opacity: 0.7 }}>Source text extracted. Target: <strong>{langName}</strong></span>
              <button className="modal-btn" onClick={handleTranslate} disabled={translating}>
                {translating ? `Translating… ${progress}%` : <><Globe size={14} /> Translate to {langName}</>}
              </button>
              <button className="modal-btn-secondary" onClick={() => handleCopy(sourceText)}>Copy Source</button>
              <button className="modal-btn-secondary" onClick={() => { setStep('setup'); setSourceText('') }}><ArrowLeft size={14} /> Back</button>
            </div>
            {translating && (
              <div style={{ padding: '4px 16px', background: 'rgba(74,158,255,0.08)' }}>
                <div style={{ height: 4, background: 'var(--border)', borderRadius: 2 }}>
                  <div style={{ height: 4, background: 'var(--accent)', borderRadius: 2, width: `${progress}%`, transition: 'width 0.3s' }} />
                </div>
              </div>
            )}
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 16px' }}>
              <textarea readOnly value={sourceText}
                style={{ width: '100%', height: '100%', minHeight: 260, background: 'var(--bg-primary)',
                  color: 'inherit', border: '1px solid var(--border)', borderRadius: 4,
                  padding: 8, fontSize: 12, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' }} />
            </div>
            {error && <div style={{ padding: '0 16px 8px', color: '#ff5555', fontSize: 12 }}>{error}</div>}
          </>
        )}

        {/* Step 3: Show translation result */}
        {step === 'result' && (
          <>
            <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, opacity: 0.7 }}>✓ Translated to <strong>{langName}</strong></span>
              <button className="modal-btn-secondary" onClick={() => handleCopy(translatedText)}>Copy Translation</button>
              <button className="modal-btn-secondary" onClick={() => handleSave(translatedText, langName.toLowerCase())}><Download size={14} /> Save .txt</button>
              <button className="modal-btn-secondary" onClick={() => setStep('review')}><ArrowLeft size={14} /> Back</button>
            </div>
            <div style={{ flex: 1, display: 'flex', gap: 0, overflow: 'hidden' }}>
              <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px 8px 16px', borderRight: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Original (English)</div>
                <div style={{ fontSize: 11, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{sourceText}</div>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '8px 16px 8px 8px' }}>
                <div style={{ fontSize: 11, color: 'var(--accent)', marginBottom: 4 }}>{langName} translation</div>
                <div style={{ fontSize: 11, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{translatedText}</div>
              </div>
            </div>
          </>
        )}

        <div className="modal-footer">
          {step === 'setup' && (
            <>
              <button className="modal-btn-secondary" onClick={onClose}>Cancel</button>
              <button className="modal-btn" onClick={handleExtract} disabled={loading || !pdfBytes}>
                {loading ? 'Extracting…' : <>Extract Text <ArrowRight size={14} /></>}
              </button>
            </>
          )}
          {(step === 'review' || step === 'result') && (
            <button className="modal-btn-secondary" onClick={onClose}>Close</button>
          )}
        </div>
      </div>
    </div>
  )
}
