import {
  PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup,
  PDFDropdown, PDFOptionList, PDFName, PDFString, PDFNumber,
} from 'pdf-lib'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type {
  FormField, TextFormField, CheckboxFormField, RadioFormField,
  DropdownFormField, ListBoxFormField, DateFormField, ButtonFormField,
} from '../types/forms'
import { newId } from './annotationUtils'

// ── read ──────────────────────────────────────────────────────────────────────

export async function readFormFieldsFromPdf(
  pdfDoc: PDFDocumentProxy,
  numPages: number
): Promise<FormField[]> {
  const result: FormField[] = []
  const seenRadioGroups = new Set<string>()

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum)
    // intent: 'any' ensures hidden widgets are also returned
    const anns = await page.getAnnotations({ intent: 'any' as any })

    for (const a of anns) {
      if (a.subtype !== 'Widget') continue
      if (!a.fieldName) continue

      const id = newId()
      const rect = a.rect as [number, number, number, number]
      const base = {
        id,
        pageNum,
        fieldName: a.fieldName as string,
        rect,
        readOnly: !!a.readOnly,
        isNew: false,
      }

      try {
        const ft = a.fieldType as string | undefined

        if (ft === 'Tx') {
          result.push({
            ...base,
            type: 'text',
            value: typeof a.fieldValue === 'string' ? a.fieldValue : '',
            multiline: !!a.multiLine,
            maxLen: typeof a.maxLen === 'number' ? a.maxLen : undefined,
          } as TextFormField)

        } else if (ft === 'Btn') {
          if (a.radioButton) {
            const groupName = a.fieldName as string
            const exportValue = (a.buttonValue as string | undefined) ?? 'Yes'
            const fieldValue = typeof a.fieldValue === 'string' ? a.fieldValue : ''
            result.push({
              ...base,
              type: 'radio',
              groupName,
              exportValue,
              selected: fieldValue === exportValue,
            } as RadioFormField)
            seenRadioGroups.add(groupName)
          } else if (a.checkBox) {
            const exportValue = 'Yes'
            const fieldValue = typeof a.fieldValue === 'string' ? a.fieldValue : 'Off'
            result.push({
              ...base,
              type: 'checkbox',
              checked: fieldValue !== 'Off' && fieldValue !== '',
              exportValue,
            } as CheckboxFormField)
          }

        } else if (ft === 'Ch') {
          const opts = (a.options as Array<{ exportValue: string; displayValue: string }> | undefined) ?? []
          const optStrings = opts.map(o => o.exportValue || o.displayValue)
          // PDF.js returns a choice field's value as an ARRAY, even for a single
          // selection. Reading it as a string fell through to optStrings[0], so
          // a saved dropdown silently reopened showing the FIRST option instead
          // of what the user had chosen. That is corruption, not just loss.
          const fv = a.fieldValue
          const values: string[] = Array.isArray(fv)
            ? fv.filter((v): v is string => typeof v === 'string')
            : typeof fv === 'string' && fv ? [fv] : []
          // A list box is distinguished from a dropdown by the combo flag, not
          // by multiSelect: a single-select list box has multiSelect false and
          // used to be misread as a dropdown.
          const isCombo = (a as { combo?: boolean }).combo !== false
          if (isCombo) {
            result.push({
              ...base,
              type: 'dropdown',
              options: optStrings,
              value: values[0] ?? '',
            } as DropdownFormField)
          } else {
            result.push({
              ...base,
              type: 'listbox',
              options: optStrings,
              values,
            } as ListBoxFormField)
          }

        } else if (ft === 'Sig') {
          result.push({ ...base, type: 'signature' })
        }
      } catch { /* skip malformed */ }
    }
  }

  return result
}

// ── write values + create new fields ─────────────────────────────────────────

export async function writeFormToBytes(
  bytes: Uint8Array,
  formFields: FormField[]
): Promise<Uint8Array> {
  if (formFields.length === 0) return bytes

  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const form = doc.getForm()

  // Apply values to existing fields
  const existing = formFields.filter(f => !f.isNew)

  // Text fields
  for (const field of existing.filter(f => f.type === 'text')) {
    const tf = field as TextFormField
    try {
      const f = form.getFieldMaybe(tf.fieldName)
      if (f instanceof PDFTextField) f.setText(tf.value)
    } catch {}
  }

  // Checkboxes
  for (const field of existing.filter(f => f.type === 'checkbox')) {
    const cf = field as CheckboxFormField
    try {
      const f = form.getFieldMaybe(cf.fieldName)
      if (f instanceof PDFCheckBox) {
        if (cf.checked) f.check(); else f.uncheck()
      }
    } catch {}
  }

  // Radio groups — write once per group with the selected option
  const radioGroups = new Map<string, RadioFormField[]>()
  for (const field of existing.filter(f => f.type === 'radio')) {
    const rf = field as RadioFormField
    if (!radioGroups.has(rf.groupName)) radioGroups.set(rf.groupName, [])
    radioGroups.get(rf.groupName)!.push(rf)
  }
  for (const [groupName, radios] of radioGroups) {
    const selected = radios.find(r => r.selected)
    if (!selected) continue
    try {
      const f = form.getFieldMaybe(groupName)
      if (f instanceof PDFRadioGroup) f.select(selected.exportValue)
    } catch {}
  }

  // Dropdowns
  for (const field of existing.filter(f => f.type === 'dropdown')) {
    const df = field as DropdownFormField
    try {
      const f = form.getFieldMaybe(df.fieldName)
      if (f instanceof PDFDropdown && df.value) f.select(df.value)
    } catch {}
  }

  // List boxes
  for (const field of existing.filter(f => f.type === 'listbox')) {
    const lf = field as ListBoxFormField
    try {
      const f = form.getFieldMaybe(lf.fieldName)
      if (f instanceof PDFOptionList && lf.values.length > 0) f.select(lf.values[0])
    } catch {}
  }

  // Create new fields
  let counter = Date.now()
  for (const field of formFields.filter(f => f.isNew)) {
    try {
      const page = doc.getPage(field.pageNum - 1)
      const x = field.rect[0]
      const y = field.rect[1]
      const width = Math.max(10, field.rect[2] - field.rect[0])
      const height = Math.max(10, field.rect[3] - field.rect[1])
      const name = field.fieldName || `monstera_field_${counter++}`

      if (field.type === 'text') {
        const tf = form.createTextField(name)
        if (field.multiline) tf.enableMultiline()
        // maxLen was accepted from the UI but never written, so a length limit
        // was silently dropped and came back as 0 on reopen.
        if (typeof field.maxLen === 'number' && field.maxLen > 0) {
          try { tf.setMaxLength(field.maxLen) } catch { /* ignore */ }
        }
        tf.addToPage(page, { x, y, width, height, borderWidth: 1 })
        if (field.value) tf.setText(field.value)
      } else if (field.type === 'date') {
        const df = field as DateFormField
        const tf = form.createTextField(name)
        tf.addToPage(page, { x, y, width, height, borderWidth: 1 })
        if (df.value) tf.setText(df.value)
      } else if (field.type === 'button') {
        const bf = field as ButtonFormField
        // pdf-lib doesn't expose push button API; create a text field as a stand-in
        const tf = form.createTextField(name)
        tf.addToPage(page, { x, y, width, height, borderWidth: 1 })
        if (bf.label) tf.setText(bf.label)
      } else if (field.type === 'barcode') {
        // Barcode: save the value in a text field
        const tf = form.createTextField(name)
        tf.addToPage(page, { x, y, width, height, borderWidth: 1 })
        if (field.value) tf.setText(field.value)
      } else if (field.type === 'dropdown') {
        const df = field as DropdownFormField
        const sel = form.createDropdown(name)
        if (df.options.length > 0) {
          sel.addOptions(df.options)
          sel.addToPage(page, { x, y, width, height, borderWidth: 1 })
          if (df.value) { try { sel.select(df.value) } catch {} }
        }
      } else if (field.type === 'listbox') {
        const lf = field as ListBoxFormField
        const ol = form.createOptionList(name)
        if (lf.options.length > 0) {
          ol.addOptions(lf.options)
          // Without this the list box is written as a plain choice field, which
          // reopens as a dropdown and loses every selection past the first.
          if (lf.values.length > 1) { try { ol.enableMultiselect() } catch {} }
          ol.addToPage(page, { x, y, width, height, borderWidth: 1 })
          if (lf.values.length > 0) { try { ol.select(lf.values) } catch {} }
        }
      } else if (field.type === 'radio') {
        const rf = field as RadioFormField & { isNew: true }
        const groupName = rf.groupName || name
        // createRadioGroup() throws if the group already exists, and the throw
        // was swallowed, so only the FIRST button of a group was ever written
        // and the rest of the group silently vanished.
        const existingGrp = form.getFieldMaybe(groupName)
        const grp = existingGrp instanceof PDFRadioGroup
          ? existingGrp
          : form.createRadioGroup(groupName)
        const sz = Math.min(width, height)
        grp.addOptionToPage(rf.exportValue || 'Yes', page, { x, y, width: sz, height: sz, borderWidth: 1 })
        if (rf.selected) { try { grp.select(rf.exportValue) } catch {} }
      } else if (field.type === 'signature') {
        // pdf-lib has no signature-field API, and the old stand-in text field
        // meant a signature area reopened as an editable text box. Build the
        // /FT /Sig widget directly so the field keeps its type.
        const sigRef = doc.context.register(doc.context.obj({
          Type: PDFName.of('Annot'),
          Subtype: PDFName.of('Widget'),
          FT: PDFName.of('Sig'),
          T: PDFString.of(name),
          Rect: doc.context.obj([x, y, x + width, y + height]),
          F: PDFNumber.of(4),
          P: page.ref,
        }))
        page.node.addAnnot(sigRef)
        form.acroForm.addField(sigRef)
      } else if (field.type === 'checkbox') {
        const sz = Math.min(width, height)
        const cf = form.createCheckBox(name)
        cf.addToPage(page, { x, y, width: sz, height: sz, borderWidth: 1 })
        if ((field as CheckboxFormField).checked) cf.check()
      }

      // readOnly was carried on every field but never applied, so a locked
      // field reopened fully editable.
      if (field.readOnly) {
        try {
          const created = form.getFieldMaybe(name)
          ;(created as { enableReadOnly?: () => void } | undefined)?.enableReadOnly?.()
        } catch { /* not all field kinds expose it */ }
      }
    } catch { /* field name conflict or page out of range */ }
  }

  try { form.updateFieldAppearances() } catch {}

  return doc.save()
}

// ── flatten ───────────────────────────────────────────────────────────────────

export async function flattenFormToBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const form = doc.getForm()
  try { form.flatten() } catch {}
  return doc.save()
}

// ── export form data ──────────────────────────────────────────────────────────

export function exportFormAsJson(fields: FormField[]): string {
  const data: Record<string, unknown> = {}
  for (const f of fields) {
    switch (f.type) {
      case 'text':      data[f.fieldName] = (f as TextFormField).value; break
      case 'date':      data[f.fieldName] = (f as DateFormField).value; break
      case 'checkbox':  data[f.fieldName] = (f as CheckboxFormField).checked; break
      case 'radio':     if ((f as RadioFormField).selected) data[f.fieldName] = (f as RadioFormField).exportValue; break
      case 'dropdown':  data[f.fieldName] = (f as DropdownFormField).value; break
      case 'listbox':   data[f.fieldName] = (f as ListBoxFormField).values; break
      case 'barcode':   data[f.fieldName] = (f as import('../types/forms').BarcodeFormField).value; break
      case 'button':    break  // buttons have no data value
      case 'signature': break
    }
  }
  return JSON.stringify(data, null, 2)
}

export function exportFormAsFdf(fields: FormField[], pdfPath?: string): string {
  const lines = [
    '%FDF-1.2',
    '%âãÏÓ',
    '1 0 obj',
    '<< /FDF << /Fields [',
  ]
  const fieldLines: string[] = []
  const seen = new Set<string>()
  for (const f of fields) {
    if (seen.has(f.fieldName)) continue
    seen.add(f.fieldName)
    let val = ''
    switch (f.type) {
      case 'text':     val = (f as TextFormField).value ?? ''; break
      case 'date':     val = (f as DateFormField).value ?? ''; break
      case 'checkbox': val = (f as CheckboxFormField).checked ? 'Yes' : 'Off'; break
      case 'radio':    if ((f as RadioFormField).selected) val = (f as RadioFormField).exportValue; break
      case 'dropdown': val = (f as DropdownFormField).value ?? ''; break
      case 'listbox':  val = (f as ListBoxFormField).values[0] ?? ''; break
      default: continue
    }
    fieldLines.push(`<< /T (${f.fieldName}) /V (${val}) >>`)
  }
  lines.push(...fieldLines)
  if (pdfPath) lines.push(`] /F (${pdfPath})`)
  else lines.push(']')
  lines.push('>> >>')
  lines.push('endobj')
  lines.push('trailer')
  lines.push('<< /Root 1 0 R >>')
  lines.push('%%EOF')
  return lines.join('\n')
}

// ── import form data ──────────────────────────────────────────────────────────

// Compute the patch needed to set a field's value from imported data.
export function applyValueToField(f: FormField, raw: unknown): Partial<FormField> | null {
  switch (f.type) {
    case 'text': case 'date': case 'dropdown': case 'barcode':
      return { value: String(raw ?? '') } as Partial<FormField>
    case 'checkbox':
      return { checked: raw === true || /^(true|yes|on|checked|1|x)$/i.test(String(raw)) } as Partial<FormField>
    case 'radio':
      return { selected: String(raw) === (f as RadioFormField).exportValue } as Partial<FormField>
    case 'listbox':
      return { values: Array.isArray(raw) ? raw.map(String) : String(raw).split(/[;,]/).map(s => s.trim()).filter(Boolean) } as Partial<FormField>
    default:
      return null
  }
}

// Parse an FDF (or XFDF) data file into a fieldName → value map.
export function parseFormDataFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const unesc = (s: string) => s.replace(/\\([()\\])/g, '$1')
  if (/<\s*xfdf/i.test(text)) {
    // XFDF: <field name="x"><value>v</value></field>
    const re = /<field\b[^>]*\bname\s*=\s*"([^"]*)"[^>]*>[\s\S]*?<value>([\s\S]*?)<\/value>/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) out[m[1]] = m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    return out
  }
  // FDF: << /T (name) /V (value) >>
  const re = /\/T\s*\(((?:[^()\\]|\\.)*)\)[^/]*?\/V\s*\(((?:[^()\\]|\\.)*)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out[unesc(m[1])] = unesc(m[2])
  return out
}
