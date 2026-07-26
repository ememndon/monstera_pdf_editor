// Proof for the Claude vision engine (Export → Excel / Word → "AI (Claude)").
//
// No live API key is required. If ANTHROPIC_API_KEY is set, an OPTIONAL live
// smoke case runs; otherwise it is skipped silently.
//
// Case A — request building: buildVisionRequest embeds the PNG as a base64
//   image block, targets the given model, and uses the right system prompt for
//   'text' vs 'tables'.
// Case B — tables JSON parser: parseTablesResponse handles clean JSON,
//   ```json-fenced JSON, JSON wrapped in prose, a bare 2-D array, an empty
//   array (valid → no tables), and throws on malformed / wrong-shape input.
// Case C — markdown → docx structuring: buildParagraphsDocx with a page's
//   `markdown` produces a real .docx whose document.xml carries heading styles,
//   list numbering/bullets, and paragraph text.
// Case D — error mapping: mapAnthropicError turns mocked 401/429/404 errors
//   into friendly, actionable messages.

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const errs = []
const ok = (cond, label) => { console.log((cond ? '  PASS - ' : '  FAIL - ') + label); if (!cond) errs.push(label) }

const av = await import(pathToFileURL(join(ROOT, 'dist-electron/main/aiVision.js')).href)
const { buildParagraphsDocx, markdownToBlocks } = await import(pathToFileURL(join(ROOT, 'dist-electron/main/docxParagraphs.js')).href)

// ── Case A: request building ──────────────────────────────────────────────────
console.log('\n=== Case A: buildVisionRequest ===')
const b64 = Buffer.from('fake-png-bytes').toString('base64')
const reqTables = av.buildVisionRequest(b64, 'tables', 'claude-opus-4-8')
ok(reqTables.model === 'claude-opus-4-8', 'model passed through')
ok(!('temperature' in reqTables), 'temperature omitted (deprecated on newer models)')
ok(reqTables.max_tokens <= 4000 && reqTables.max_tokens > 0, `max_tokens ceiling (${reqTables.max_tokens})`)
const img = reqTables.messages[0].content.find(c => c.type === 'image')
ok(!!img && img.source.type === 'base64' && img.source.media_type === 'image/png' && img.source.data === b64, 'image block is base64 image/png with our data')
ok(/strict JSON/i.test(reqTables.system) && /rows/i.test(reqTables.system), 'tables system prompt asks for strict {rows} JSON')
const reqText = av.buildVisionRequest(b64, 'text', 'claude-opus-4-8')
ok(/markdown/i.test(reqText.system) && /\[illegible\]/i.test(reqText.system), 'text system prompt asks for markdown + [illegible]')
ok(reqText.system !== reqTables.system, 'text and tables use different system prompts')

// ── Case B: tables JSON parser ────────────────────────────────────────────────
console.log('\n=== Case B: parseTablesResponse ===')
const clean = JSON.stringify([{ rows: [['Item', 'Qty'], ['Apples', '3']] }])
let r = av.parseTablesResponse(clean)
ok(r.length === 1 && r[0].rows.length === 2 && r[0].rows[1][0] === 'Apples', 'clean JSON parsed')

const fenced = '```json\n' + clean + '\n```'
ok(av.parseTablesResponse(fenced)[0].rows[0][1] === 'Qty', 'fenced ```json parsed')

const prose = 'Here are the tables you asked for:\n' + clean + '\nHope that helps!'
ok(av.parseTablesResponse(prose)[0].rows[1][1] === '3', 'JSON embedded in prose parsed')

const bare2d = JSON.stringify([['A', 'B'], ['1', '2']])
const rb = av.parseTablesResponse(bare2d)
ok(rb.length === 1 && rb[0].rows.length === 2 && rb[0].rows[0][0] === 'A', 'bare 2-D array wrapped into one table')

ok(av.parseTablesResponse('[]').length === 0, 'empty array → 0 tables (valid, no crash)')

const coerce = av.parseTablesResponse(JSON.stringify([{ rows: [[1, null, 2.5]] }]))
ok(coerce[0].rows[0][0] === '1' && coerce[0].rows[0][1] === '' && coerce[0].rows[0][2] === '2.5', 'cells coerced to strings; null → ""')

let threw = false
try { av.parseTablesResponse('I could not read any tables on this page.') } catch { threw = true }
ok(threw, 'malformed / non-JSON response throws a clear error')

threw = false
try { av.parseTablesResponse(JSON.stringify({ tables: [] })) } catch { threw = true }
ok(threw, 'non-array top-level throws')

threw = false
try { av.parseTablesResponse(JSON.stringify([{ notRows: 1 }])) } catch { threw = true }
ok(threw, 'table missing "rows" throws')

// ── Case C: markdown → docx structuring ───────────────────────────────────────
console.log('\n=== Case C: markdown → docx structuring ===')
const blocks = markdownToBlocks('# Title\n\nIntro paragraph line one.\nstill same paragraph.\n\n- first bullet\n- second bullet\n\n1. step one\n2. step two\n\n## Section')
const kinds = blocks.map(b => b.kind)
ok(kinds.filter(k => k === 'heading').length === 2, 'two headings parsed')
ok(kinds.filter(k => k === 'bullet').length === 2, 'two bullets parsed')
ok(kinds.filter(k => k === 'ordered').length === 2, 'two ordered items parsed')
ok(blocks.some(b => b.kind === 'paragraph' && /Intro paragraph/.test(b.text) && /still same/.test(b.text)), 'consecutive plain lines merged into one paragraph')

try {
  const md = '# Meeting Notes\n\nWe discussed the roadmap.\n\n- ship v2\n- write docs\n\n1. review\n2. approve'
  const buf = await buildParagraphsDocx([{ page: 1, markdown: md }])
  ok(Buffer.isBuffer(buf) && buf.length > 0, `produced a .docx buffer (${buf.length} bytes)`)
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(buf)
  const xml = await zip.file('word/document.xml').async('string')
  ok(/Heading1/.test(xml), 'document.xml has a Heading1 style')
  ok(/w:numPr/.test(xml) || /ListParagraph|numId/.test(xml), 'document.xml has list numbering markup')
  for (const needle of ['Meeting Notes', 'ship v2', 'review', 'roadmap'])
    ok(xml.includes(needle), `document.xml contains "${needle}"`)

  // Regression: a plain-paragraphs page (TrOCR/Azure path) still works unchanged.
  const buf2 = await buildParagraphsDocx([{ page: 1, paragraphs: ['Plain one', 'Plain two'] }])
  const zip2 = await JSZip.loadAsync(buf2)
  const xml2 = await zip2.file('word/document.xml').async('string')
  ok(xml2.includes('Plain one') && xml2.includes('Plain two'), 'plain paragraphs path unchanged')
} catch (e) {
  ok(false, 'docx structuring failed: ' + e.message)
}

// ── Case D: error mapping ─────────────────────────────────────────────────────
console.log('\n=== Case D: mapAnthropicError ===')
ok(/key/i.test(av.mapAnthropicError({ status: 401 })), '401 → invalid-key message mentions the key')
ok(/Settings/i.test(av.mapAnthropicError({ status: 401 })), '401 message points to Settings')
ok(/rate limit/i.test(av.mapAnthropicError({ status: 429 })), '429 → rate-limit message')
ok(/model/i.test(av.mapAnthropicError({ status: 404, model: 'bad-model' })), '404 → model-not-found message')
ok(/model/i.test(av.mapAnthropicError({ error: { type: 'not_found_error' }, model: 'x' })), 'not_found_error type → model message')

// ── Optional live smoke (only when ANTHROPIC_API_KEY is set) ───────────────────
if (process.env.ANTHROPIC_API_KEY) {
  console.log('\n=== Optional live smoke (ANTHROPIC_API_KEY present) ===')
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    // 1x1 white PNG.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
    const req = av.buildVisionRequest(png.toString('base64'), 'text', process.env.ANTHROPIC_MODEL || 'claude-opus-4-8')
    const resp = await client.messages.create(req)
    const text = (resp.content.find(b => b.type === 'text') || {}).text || ''
    ok(typeof text === 'string', `live call returned text (${text.length} chars)`)
  } catch (e) {
    ok(false, 'live smoke failed: ' + (av.mapAnthropicError(e)))
  }
} else {
  console.log('\n(skipping optional live smoke — ANTHROPIC_API_KEY not set)')
}

console.log('\n=== RESULT ===')
if (errs.length === 0) console.log('  PASS — request building, tables parsing, markdown→docx, and error mapping verified.')
else { errs.forEach(e => console.log('  FAIL - ' + e)); process.exitCode = 1 }
