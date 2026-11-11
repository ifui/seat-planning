/** 仓储入口：视图与 store 只从这里拿接口实例 */
import { IndexedDbRepository } from './indexeddb-repository'
import { SqliteRepository } from './sqlite-repository'
import { isTauri } from '../platform/env'
import type { SeatRepository } from './repository'

/** 桌面端优先 SQLite（失败自动回退 IndexedDB），浏览器端保持 IndexedDB */
export const repository: SeatRepository = isTauri() ? new SqliteRepository() : new IndexedDbRepository()

export type { ImportSummary, SeatRepository, StorageMode, StorageUsage, Tables } from './repository'
export { buildSeed } from './seed'
