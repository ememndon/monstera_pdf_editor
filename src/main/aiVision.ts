// Claude vision engine: transcribe a rendered page (handwriting included) into
// markdown prose ('text') or structured table JSON ('tables'). The request
// building, the defensive tables-JSON parser and the error mapping live here so
// the proof script can unit-test them without a live API key.

export type VisionMode = 'text' | 'tables'

export const VISION_SYSTEM_TEXT =
  'Transcribe ALL content of this document page faithfully, including handwriting, as GitHub-flavored markdown. ' +
  'Preserve headings, paragraphs, and lists. Mark unreadable words as [illegible]. Output ONLY the transcription.'

export const VISION_SYSTEM_TABLES =
  'You extract tabular data from a document page image, including handwriting. ' +
  'Output ONLY strict JSON: an array of tables in reading order, each object shaped {"rows": string[][]}. ' +
  'Every cell is a plain string; write numbers unformatted (no thousands separators or currency symbols). ' +
  'Preserve empty cells as "". If the page has no tables, output []. Do not wrap the JSON in prose or code fences.'

export interface VisionRequest {
  model: string
  max_tokens: number
  system: string
  messages: Array<{
    role: 'user'
    content: Array<
      | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } }
      | { type: 'text'; text: string }
    >
  }>
}

export function buildVisionRequest(pngBase64: string, mode: VisionMode, model: string): VisionRequest {
  return {
    model,
    max_tokens: 4000,
    system: mode === 'tables' ? VISION_SYSTEM_TABLES : VISION_SYSTEM_TEXT,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } },
        { type: 'text', text: mode === 'tables'
          ? 'Extract every table on this page as JSON.'
          : 'Transcribe this page as markdown.' },
      ],
    }],
  }
}

export interface VisionTable { rows: string[][] }

// Claude may wrap the JSON in prose or ```json fences, or occasionally return a
// bare 2-D array instead of the {rows} envelope. Recover the first JSON array,
// validate its shape, and coerce every cell to a string. An EMPTY array is a
// valid answer (a page with no tables) — the caller degrades it to a message.
// Anything that is not parseable table JSON throws a clear error.
export function parseTablesResponse(text: string): VisionTable[] {
  let body = (text ?? '').trim()
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) body = fence[1].trim()

  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    const start = body.indexOf('[')
    const end = body.lastIndexOf(']')
    if (start === -1 || end <= start) {
      throw new Error('Claude did not return table JSON for this page. Try the Azure or local engine, or re-run.')
    }
    try {
      json = JSON.parse(body.slice(start, end + 1))
    } catch {
      throw new Error('Claude returned a response that could not be parsed as table JSON. Try re-running the page.')
    }
  }

  if (!Array.isArray(json)) {
    throw new Error('Claude returned table data in an unexpected shape (expected a JSON array of tables).')
  }

  const toRows = (raw: unknown): string[][] => {
    if (!Array.isArray(raw)) return []
    return raw
      .filter(Array.isArray)
      .map(r => (r as unknown[]).map(c => (c == null ? '' : String(c))))
  }

  const tables: VisionTable[] = []
  for (const item of json) {
    if (item && typeof item === 'object' && Array.isArray((item as { rows?: unknown }).rows)) {
      tables.push({ rows: toRows((item as { rows: unknown }).rows) })
    } else if (Array.isArray(item)) {
      // Bare 2-D array: the whole response is one table's rows.
      tables.push({ rows: toRows(json) })
      break
    } else {
      throw new Error('Claude returned table data in an unexpected shape (a table was missing its "rows").')
    }
  }
  return tables
}

// Map an Anthropic SDK / HTTP error to a short, user-actionable message.
export function mapAnthropicError(err: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any
  const status: number | undefined = e?.status ?? e?.statusCode
  const type: string | undefined = e?.error?.error?.type ?? e?.error?.type
  if (status === 401) return 'Anthropic rejected the API key. Check it in Settings (Ctrl+,) → API keys.'
  if (status === 429) return 'Anthropic rate limit reached. Wait a moment and try again, or reduce the page range.'
  if (status === 404 || type === 'not_found_error') {
    return `Anthropic could not find the model "${e?.model ?? ''}". Set a valid model id in Settings (Ctrl+,).`
  }
  const msg = e?.error?.error?.message ?? e?.message
  return msg ? `Anthropic error: ${String(msg).slice(0, 200)}` : 'Anthropic request failed.'
}
