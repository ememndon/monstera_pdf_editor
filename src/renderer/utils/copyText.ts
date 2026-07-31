// Single copy-to-clipboard path for the whole renderer.
//
// navigator.clipboard.writeText() requires the clipboard-sanitized-write
// permission, and the app's permission handler grants only 'media'. Every copy
// therefore failed with "Failed to execute 'writeText' on 'Clipboard': Write
// permission denied". Electron's native clipboard module sits outside the web
// permission model, so prefer the IPC bridge and keep the web API as the
// fallback for browser/dev mode.
export async function copyText(text: string): Promise<boolean> {
  const native = window.electronAPI?.clipboardWriteText
  if (native) {
    try {
      await native(text)
      return true
    } catch { /* fall through to the web API */ }
  }

  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Last resort for older/permission-restricted contexts.
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}
