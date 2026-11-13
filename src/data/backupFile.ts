/**
 * 备份文件（.sp）的封装与解封。
 *
 * 文件是二进制加密容器，不再以明文 JSON 落盘：
 *   magic "SPBK" | 版本 1 字节 | salt 16 字节 | iv 12 字节 | AES-256-GCM 密文
 * 密钥由应用内置口令经 PBKDF2-SHA256（21 万次）派生，导入时校验 magic 与版本，
 * 密文被篡改或损坏会解密失败，不会把半截数据写进库里。
 *
 * 说明：这是「防止备份文件被直接打开读取」的静态加密；口令随应用分发，
 * 不构成本地攻击者无法解密的强保护。
 */
const MAGIC = [0x53, 0x50, 0x42, 0x4b] // "SPBK"
const VERSION = 1
const SALT_LEN = 16
const IV_LEN = 12
const ITERATIONS = 210_000
const PASSPHRASE = 'seat-planning::backup::v1::7c1f4a9e'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

async function deriveKey(salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(PASSPHRASE), 'PBKDF2', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** 明文 JSON → .sp 加密文件内容 */
export async function packBackup(json: string): Promise<Blob> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN))
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN))
  const key = await deriveKey(salt)
  const header = new Uint8Array([...MAGIC, VERSION, ...salt, ...iv])
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: header.subarray(0, 5) },
      key,
      encoder.encode(json),
    ),
  )
  return new Blob([header, cipher], { type: 'application/octet-stream' })
}

/** .sp 文件内容 → 明文 JSON；兼容旧版明文 JSON 备份 */
export async function unpackBackup(buf: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buf)
  const hasMagic = MAGIC.every((b, i) => bytes[i] === b)
  if (!hasMagic) {
    const text = decoder.decode(bytes).trim()
    if (text.startsWith('{')) return text
    throw new Error('不是有效的备份文件（.sp）')
  }
  if (bytes.length < 5 + SALT_LEN + IV_LEN) throw new Error('备份文件不完整')
  if (bytes[4] !== VERSION) throw new Error('备份文件版本不受支持')

  const salt = bytes.slice(5, 5 + SALT_LEN)
  const iv = bytes.slice(5 + SALT_LEN, 5 + SALT_LEN + IV_LEN)
  const cipher = bytes.slice(5 + SALT_LEN + IV_LEN)
  try {
    const key = await deriveKey(salt)
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: bytes.slice(0, 5) },
      key,
      cipher,
    )
    return decoder.decode(plain)
  } catch {
    throw new Error('备份文件已损坏或无法解密')
  }
}
