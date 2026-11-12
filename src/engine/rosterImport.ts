/**
 * 名册批量导入：Excel / Word(.docx) / CSV / 分隔文本 → 原始表格 → 智能字段识别 → 人员行。
 * 只做解析，不写库；写库与单位/职级匹配由调用方完成。
 */
import * as XLSX from 'xlsx'

export interface RawTable {
  sourceName: string
  columns: string[]
  rows: string[][]
  hasHeader: boolean
  warnings: string[]
}

export interface FieldMap {
  name: number
  unit: number
  rank: number
  duty: number
  note: number
}

export interface ParsedPerson {
  line: number
  name: string
  unit: string
  rank: string
  duty: string
  note: string
  issues: string[]
}

/**
 * 性别词只作为「不是人名」的判断依据：表格里残留的「男 / 女」列不会被人名识别误吞，
 * 也不再进入人员模型（名册不存储、不导入性别）。
 */
const SEX_WORD_RE = /^(男|男性|男士|先生|女|女性|女士|mrs?|ms|m|f|male|female)$/i
const PHONE_RE = /^\+?[\d\s-]{7,}$/
const RANK_WORD_RE =
  /(书记|主任|处长|科长|局长|部长|厅长|院长|经理|总监|主管|主席|委员|巡视员|调研员|科员|办事员|干事|专员|组长|队长|班长|工程师|会计师|经济师|技师|处级|科级|局级|厅级|部级)$/
const UNIT_WORD_RE =
  /(单位|部门|科室|办公室|处|科|室|部|中心|公司|集团|局|院|所|委|办|学校|学院|医院|支行|分行|车间|班组|大队|支队|中队|街道|社区|镇|乡|村)$/
const HEADER_WORDS =
  /^(姓名|名字|人员|成员|员工|参会人|与会人|性别|单位|部门|科室|机构|所属|职级|职务|级别|职称|岗位|备注|说明|电话|手机|联系方式|序号|编号|工号)$/

function clean(v: unknown): string {
  return String(v ?? '').replace(/\u00a0/g, ' ').trim()
}

/** 解析文本编码：优先 UTF-8，失败回退 GBK（政务/Excel 导出的 CSV 常见） */
async function decodeText(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf).replace(/^\uFEFF/, '')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      return new TextDecoder('utf-8').decode(buf)
    }
  }
}

function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 8).join('\n')
  const counts: [string, number][] = [
    ['\t', (sample.match(/\t/g) ?? []).length],
    [',', (sample.match(/,/g) ?? []).length],
    [';', (sample.match(/;/g) ?? []).length],
    ['，', (sample.match(/，/g) ?? []).length]
  ]
  counts.sort((a, b) => b[1] - a[1])
  return counts[0][1] > 0 ? counts[0][0] : ','
}

/** 支持引号、转义引号与换行的分隔文本解析 */
export function parseDelimited(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const src = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"') {
      quoted = true
    } else if (ch === delimiter) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (ch === '\r') {
      // 忽略，等待 \n
    } else {
      cell += ch
    }
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

/** 读取 docx 内指定 zip 条目（deflate-raw 解压，无第三方依赖） */
async function unzipEntry(buf: ArrayBuffer, entryName: string): Promise<string | null> {
  const view = new DataView(buf)
  let eocd = -1
  const minPos = Math.max(0, buf.byteLength - 65557)
  for (let i = buf.byteLength - 22; i >= minPos; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 .docx 文件')
  const count = view.getUint16(eocd + 10, true)
  let off = view.getUint32(eocd + 16, true)
  for (let n = 0; n < count; n++) {
    if (view.getUint32(off, true) !== 0x02014b50) break
    const method = view.getUint16(off + 10, true)
    const compSize = view.getUint32(off + 20, true)
    const nameLen = view.getUint16(off + 28, true)
    const extraLen = view.getUint16(off + 30, true)
    const commentLen = view.getUint16(off + 32, true)
    const localOff = view.getUint32(off + 42, true)
    const name = new TextDecoder().decode(new Uint8Array(buf, off + 46, nameLen)).replace(/\\/g, '/')
    if (name === entryName) {
      const localNameLen = view.getUint16(localOff + 26, true)
      const localExtraLen = view.getUint16(localOff + 28, true)
      const start = localOff + 30 + localNameLen + localExtraLen
      const data = new Uint8Array(buf, start, compSize)
      if (method === 0) return new TextDecoder().decode(data).replace(/^\uFEFF/, '')
      if (method !== 8) throw new Error('Word 文件使用了不支持的压缩方式')
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('当前浏览器不支持解压 Word 文件，请另存为 Excel 或 CSV 后导入')
      }
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
      return new TextDecoder().decode(await new Response(stream).arrayBuffer()).replace(/^\uFEFF/, '')
    }
    off += 46 + nameLen + extraLen + commentLen
  }
  return null
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function textOf(el: Element): string {
  const nodes = el.getElementsByTagName('w:t')
  let out = ''
  for (let i = 0; i < nodes.length; i++) out += nodes[i].textContent ?? ''
  return out.trim()
}

/** 按文档顺序读取段落与表格：表格一行一条记录，单元格用制表符分隔 */
async function readDocxLines(file: File): Promise<string[]> {
  const xml = await unzipEntry(await file.arrayBuffer(), 'word/document.xml')
  if (!xml) throw new Error('Word 文件中未找到正文')
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Word 正文解析失败')
  const body = doc.documentElement
  const lines: string[] = []
  const walk = (node: Element): void => {
    for (let i = 0; i < node.children.length; i++) {
      const el = node.children[i]
      const tag = el.localName
      if (tag === 'p') {
        const t = textOf(el)
        if (t) lines.push(t)
      } else if (tag === 'tbl') {
        const trs = el.getElementsByTagName('w:tr')
        for (let r = 0; r < trs.length; r++) {
          const tcs = trs[r].getElementsByTagName('w:tc')
          const cells: string[] = []
          for (let c = 0; c < tcs.length; c++) cells.push(textOf(tcs[c]))
          if (cells.some((x) => x.trim())) lines.push(cells.join('\t'))
        }
      } else {
        walk(el)
      }
    }
  }
  walk(body)
  return lines
}

function isNameLike(s: string): boolean {
  if (!s) return false
  if (HEADER_WORDS.test(s)) return false
  if (SEX_WORD_RE.test(s)) return false
  if (RANK_WORD_RE.test(s) || UNIT_WORD_RE.test(s)) return false
  if (PHONE_RE.test(s)) return false
  if (/^[\u4e00-\u9fa5·]{2,6}$/.test(s)) return true
  if (/^[A-Za-z][A-Za-z.'-]{1,24}$/.test(s)) return true
  return false
}

/** 从一行首列文本中识别人名，并收集括号/空格/短横线后的单位、职级、备注 */
export function parseNameCell(raw: string): {
  names: string[]
  unit: string
  rank: string
  notes: string[]
} {
  const out = { names: [] as string[], unit: '', rank: '', notes: [] as string[] }
  let s = raw.replace(/\u3000/g, ' ').trim()
  if (!s) return out
  s = s.replace(/^["'“”‘’[\【】\s]+|["'“”‘’\]】\s]+$/g, '')
  // 去掉 "1." "01、" "第2号" "（3）" 等序号前缀
  for (let i = 0; i < 3; i++) {
    s = s.replace(/^(?:第\s*)?\d+\s*号\s*/, '')
    s = s.replace(/^[（(]\s*\d+\s*[)）]\s*/, '')
    s = s.replace(/^(?:第\s*)?\d+\s*(?:[.、．)）:：\-—]\s*|\s+)/, '')
  }
  // 括号内容先取出，按单位/职级/备注归类
  const parens: string[] = []
  s = s.replace(/[（(]([^（）()]*)[)）]/g, (_m, inner: string) => {
    const t = inner.trim()
    if (t) parens.push(t)
    return ' '
  })
  // 短横线是「姓名-单位」的分隔，不视为多人分隔：横线后整体按后缀处理
  let suffix = ''
  const dash = s.match(/^([^-—–]+)[-—–](.+)$/)
  if (dash) {
    s = dash[1].trim()
    suffix = dash[2].trim()
  }
  const tokens = s
    .split(/[\s,，;；、\/|]+/)
    .map((t) => t.trim())
    .filter(Boolean)

  const nameIdx: number[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (isNameLike(tokens[i])) nameIdx.push(i)
  }
  if (!nameIdx.length) return out
  // 仅当整行都由人名组成时才视为多人（"张三、李四"），否则取第一个人名
  const allNames = nameIdx.length === tokens.length && nameIdx.length > 1
  const picked = allNames ? nameIdx : [nameIdx[0]]
  out.names = picked.map((i) => tokens[i])

  const absorb = (t: string, fallback: 'unit' | 'note' = 'note'): void => {
    if (!t) return
    if (/^\d{1,5}$/.test(t)) return
    if (SEX_WORD_RE.test(t)) return
    if (PHONE_RE.test(t)) out.notes.push(`电话 ${t.replace(/[\s-]/g, '')}`)
    else if (RANK_WORD_RE.test(t)) out.rank = out.rank || t
    else if (UNIT_WORD_RE.test(t)) out.unit = out.unit || t
    else if (fallback === 'unit') out.unit = out.unit || t
    else out.notes.push(t)
  }

  tokens.forEach((t, i) => {
    if (!picked.includes(i)) absorb(t)
  })
  parens.forEach((p) => {
    p.split(/[，,、;；\s]+/)
      .filter(Boolean)
      .forEach((t) => absorb(t))
  })
  // 横线后缀按「单位」兜底：「张三-后勤」→ 单位 后勤
  suffix
    .split(/[，,、;；\s]+/)
    .filter(Boolean)
    .forEach((t) => absorb(t, 'unit'))
  return out
}

function detectHeader(row: string[]): boolean {
  const cells = row.map((c) => c.trim()).filter(Boolean)
  if (!cells.length) return false
  const hits = cells.filter((c) => HEADER_WORDS.test(c)).length
  if (hits >= 2) return true
  if (hits >= 1 && !cells.some((c) => isNameLike(c))) return true
  return false
}

function buildTable(sourceName: string, rawRows: string[][], warnings: string[] = []): RawTable {
  const rows = rawRows
    .map((r) => r.map(clean))
    .filter((r) => r.some((c) => c.length > 0))
  if (!rows.length) throw new Error('文件中没有可读取的数据行')
  const width = Math.max(...rows.map((r) => r.length))
  const padded = rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''))
  const hasHeader = detectHeader(padded[0])
  const headerRow = hasHeader ? padded[0] : []
  const columns = Array.from({ length: width }, (_, i) => clean(headerRow[i]) || `第 ${i + 1} 列`)
  const data = hasHeader ? padded.slice(1) : padded
  return { sourceName, columns, rows: data, hasHeader, warnings }
}

export async function readRosterFile(file: File): Promise<RawTable> {
  const name = file.name
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') {
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
    const warnings: string[] = []
    let first = ''
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName]
      if (!ws || !ws['!ref']) continue
      const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: '' })
      if (rows.some((r) => r.some((c) => clean(c)))) {
        if (wb.SheetNames.length > 1) warnings.push(`已读取工作表「${sheetName}」，其余工作表未导入`)
        return buildTable(name, rows.map((r) => r.map(clean)), warnings)
      }
      first = first || sheetName
    }
    throw new Error(`Excel 中没有找到数据${first ? `（工作表「${first}」为空）` : ''}`)
  }
  if (ext === 'docx') {
    const lines = await readDocxLines(file)
    if (!lines.length) throw new Error('Word 文档中没有可读取的文字')
    const rows = lines.map((line) => (line.includes('\t') ? line.split('\t') : [line]))
    return buildTable(name, rows, ['Word 按段落/表格行读取，复杂版式建议另存为 Excel'])
  }
  if (ext === 'doc') {
    throw new Error('不支持旧版 .doc，请在 Word 中另存为 .docx 或 .xlsx 后再导入')
  }
  if (ext === 'csv' || ext === 'txt' || ext === 'tsv') {
    const text = await decodeText(file)
    const delimiter = ext === 'tsv' ? '\t' : detectDelimiter(text)
    return buildTable(name, parseDelimited(text, delimiter), [])
  }
  throw new Error('仅支持 .xlsx / .xls / .docx / .csv / .txt 文件')
}

/** 根据表头与内容特征推断字段列 */
export function suggestMapping(table: RawTable): FieldMap {
  const map: FieldMap = { name: -1, unit: -1, rank: -1, duty: -1, note: -1 }
  const headers = table.columns
  const byHeader = (re: RegExp): number => headers.findIndex((h) => re.test(h.trim()))
  map.name = byHeader(/姓名|名字|人员|成员|员工|参会人|与会人/)
  map.unit = byHeader(/单位|部门|科室|机构|所属/)
  map.rank = byHeader(/职级|级别|职称/)
  map.duty = byHeader(/职务|职位|岗位/)
  map.note = byHeader(/备注|说明|电话|手机|联系方式/)

  if (map.name < 0 && table.rows.length) {
    let best = -1
    let bestScore = 0
    for (let c = 0; c < table.columns.length; c++) {
      let hit = 0
      let total = 0
      for (const row of table.rows.slice(0, 30)) {
        const v = row[c]
        if (!v) continue
        total++
        if (parseNameCell(v).names.length && !UNIT_WORD_RE.test(v)) hit++
      }
      const score = total ? hit / total : 0
      if (score > bestScore) {
        bestScore = score
        best = c
      }
    }
    if (best >= 0 && bestScore >= 0.5) map.name = best
  }
  if (map.name < 0) map.name = 0
  return map
}

/** 按映射生成可预览的人员行；name 列会做人名与后缀智能拆解 */
export function buildRows(table: RawTable, map: FieldMap): ParsedPerson[] {
  const out: ParsedPerson[] = []
  const seen = new Map<string, number>()
  table.rows.forEach((row, i) => {
    const line = i + (table.hasHeader ? 2 : 1)
    const rawName = map.name >= 0 ? clean(row[map.name]) : ''
    const mappedUnit = map.unit >= 0 ? clean(row[map.unit]) : ''
    const mappedRank = map.rank >= 0 ? clean(row[map.rank]) : ''
    const mappedDuty = map.duty >= 0 ? clean(row[map.duty]) : ''
    const mappedNote = map.note >= 0 ? clean(row[map.note]) : ''
    if (!rawName && !mappedUnit && !mappedRank && !mappedDuty && !mappedNote) return

    const parsed = parseNameCell(rawName)
    const names = parsed.names.length ? parsed.names : ['']
    for (const name of names) {
      const issues: string[] = []
      if (!name) issues.push('未识别到姓名')
      const unit = mappedUnit || parsed.unit
      const rank = mappedRank || parsed.rank
      const notes = [...parsed.notes]
      if (mappedNote) notes.unshift(mappedNote)
      if (name) {
        const prev = seen.get(name)
        if (prev) issues.push(`与第 ${prev} 行重名`)
        else seen.set(name, line)
      }
      out.push({ line, name, unit, rank, duty: mappedDuty, note: notes.join('；'), issues })
    }
  })
  return out
}
