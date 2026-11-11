/** 仓储入口：视图与 store 只从这里拿接口实例 */
import { IndexedDbRepository } from './indexeddb-repository'
import type { SeatRepository } from './repository'

/** 当前后端为 IndexedDB；接 SQLite 时替换这一行的实现即可 */
export const repository: SeatRepository = new IndexedDbRepository()

export type { ImportSummary, SeatRepository, StorageMode, StorageUsage, Tables } from './repository'
export { buildSeed } from './seed'
