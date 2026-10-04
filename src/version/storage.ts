// 持久化层：本地库、模拟共享库、写入前备份、导入失败从完整日志恢复。
import { clone, createStoreWithSeed, migrateLegacy, parseLogFile } from './engine';
import type { RemoteState, Store } from './types';

const STORE_KEY = 'type-pairer-store-v1';
const REMOTE_KEY = 'type-pairer-remote-v1';
// 上一份完整日志（store + remote 成对），数据损坏后原样恢复用
const BACKUP_KEY = 'type-pairer-backup-v1';
// 导入开始前锁定的恢复点（导入失败/重试专用，不被普通写入滚动覆盖）
const IMPORT_BACKUP_KEY = 'type-pairer-import-backup-v1';
const LEGACY_KEY = 'type-pairs';

export interface Loaded {
  store: Store;
  remote: RemoteState;
  migratedFromLegacy: boolean;
}

/** 把当前落盘内容滚动为“上一份完整日志”备份 */
function snapshotBackup(): void {
  const prevStore = localStorage.getItem(STORE_KEY);
  const prevRemote = localStorage.getItem(REMOTE_KEY);
  if (prevStore && prevRemote) {
    localStorage.setItem(BACKUP_KEY, JSON.stringify({ store: prevStore, remote: prevRemote }));
  }
}

/**
 * 启动加载顺序：
 *  1. 新格式日志
 *  2. 新格式损坏 → 优先从导入恢复点、其次从上一份完整备份恢复
 *  3. 旧版扁平数据 → 迁移成 snapshot 基线
 *  4. 都没有 → 种子库
 */
export function load(author = 'Yuki Lin'): Loaded {
  const storeRaw = localStorage.getItem(STORE_KEY);
  const remoteRaw = localStorage.getItem(REMOTE_KEY);

  if (storeRaw && remoteRaw) {
    try {
      return {
        store: JSON.parse(storeRaw) as Store,
        remote: JSON.parse(remoteRaw) as RemoteState,
        migratedFromLegacy: false,
      };
    } catch {
      const recovered = restoreFromBackup() ?? restoreFromImportPoint();
      if (recovered) return { ...recovered, migratedFromLegacy: false };
    }
  }

  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy) {
    const { store, remote } = migrateLegacy(legacy, author);
    persist(store, remote);
    localStorage.removeItem(LEGACY_KEY); // 迁移成功后旧键退场
    return { store, remote, migratedFromLegacy: true };
  }

  const seeded = createStoreWithSeed(author);
  persist(seeded.store, seeded.remote);
  return { ...seeded, migratedFromLegacy: false };
}

/** 每次正式写入前留存上一份完整日志（store+remote 成对备份） */
export function persist(store: Store, remote: RemoteState): void {
  snapshotBackup();
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
  localStorage.setItem(REMOTE_KEY, JSON.stringify(remote));
}

export interface ImportResult {
  store: Store;
  remote: RemoteState;
}

/**
 * 导入完整日志：先完整校验，再写盘；任何失败都恢复原数据并抛错，
 * 不会出现半份记录。导入成功后可用导入的完整日志继续重试导出/同步。
 */
export function importLog(text: string, remote: RemoteState): ImportResult {
  const previous = localStorage.getItem(STORE_KEY);
  const previousRemote = localStorage.getItem(REMOTE_KEY);
  // 导入开始前锁定恢复点：本次导入无论后续写入多少次，都能回到“导入前”
  if (previous && previousRemote) {
    localStorage.setItem(IMPORT_BACKUP_KEY, JSON.stringify({ store: previous, remote: previousRemote }));
  }
  const file = parseLogFile(text); // 校验失败直接抛错，尚未触碰任何存储
  const nextStore = clone(file.store);
  try {
    const nextStoreRaw = JSON.stringify(nextStore);
    localStorage.setItem(STORE_KEY, nextStoreRaw);
    // 回读确认写入完整，写一半坏了也能回滚
    const reread = JSON.parse(localStorage.getItem(STORE_KEY) || '');
    if (!reread || reread.version !== 1) throw new Error('回读校验失败');
    localStorage.setItem(REMOTE_KEY, JSON.stringify(remote));
  } catch (err) {
    if (previous) localStorage.setItem(STORE_KEY, previous);
    if (previousRemote) localStorage.setItem(REMOTE_KEY, previousRemote);
    throw new Error(`导入失败，已恢复到导入前的完整日志：${(err as Error).message}`);
  }
  return { store: nextStore, remote };
}

function revive(raw: string | null): { store: Store; remote: RemoteState } | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { store: string; remote: string };
  const store = JSON.parse(parsed.store) as Store;
  const remote = JSON.parse(parsed.remote) as RemoteState;
  localStorage.setItem(STORE_KEY, parsed.store);
  localStorage.setItem(REMOTE_KEY, parsed.remote);
  return { store, remote };
}

/** 从上一份完整日志恢复（数据损坏时） */
export function restoreFromBackup(): { store: Store; remote: RemoteState } | null {
  return revive(localStorage.getItem(BACKUP_KEY));
}

/** 从导入前锁定的恢复点恢复（导入失败后重试入口） */
export function restoreFromImportPoint(): { store: Store; remote: RemoteState } | null {
  return revive(localStorage.getItem(IMPORT_BACKUP_KEY));
}

/** 恢复并确认无误后清掉导入恢复点 */
export function clearImportPoint(): void {
  localStorage.removeItem(IMPORT_BACKUP_KEY);
}

/** 备份用过一轮后清掉滚动恢复点，下一次写入重新留档 */
export function clearBackup(): void {
  localStorage.removeItem(BACKUP_KEY);
}
