// 持久化与协作：localStorage 存储、旧数据迁移、团队库同步、导入失败恢复
import {
  appendEdit,
  compressLog,
  isFrozen,
  materializeAll,
  mergeLogs,
  migrateLegacy,
  parseLog,
  serializeLog,
  type FieldKey,
  type LegacyPair,
  type MergeStats,
  type PairState,
  type VersionLog,
} from './versionLog';

const LOG_KEY = 'type-pair-log-v1';
const REMOTE_KEY = 'type-pair-remote-log-v1';
const BACKUP_KEY = 'type-pair-import-backup-v1';
const LEGACY_KEY = 'type-pairs';
const LEGACY_BACKUP_KEY = 'type-pairs-legacy-backup';
const CORRUPT_KEY = 'type-pair-log-corrupt-v1';

export const CURRENT_AUTHOR = 'Yuki Lin';
const TEAMMATE_AUTHORS = ['Chen Wei', 'Ava Lind', 'Marco Reyes'];

export const SEED_PAIRS: LegacyPair[] = [
  {
    id: 1,
    title: 'Editorial calm',
    heading: 'A slower way to see',
    body: 'Good typography creates space for ideas to breathe. Pair a confident display face with a quiet, generous text face.',
    category: 'Editorial',
    favorite: true,
  },
  {
    id: 2,
    title: 'Studio notes',
    heading: 'Make room for the unexpected',
    body: 'A thoughtful pairing can add rhythm to even the simplest interface. Try contrast in shape, not just size.',
    category: 'Portfolio',
    favorite: false,
  },
  {
    id: 3,
    title: 'Field guide',
    heading: 'Small details, lasting impressions',
    body: 'Typography is the voice of a page. Find a combination that feels clear, warm and distinctly yours.',
    category: 'Brand',
    favorite: false,
  },
];

// 浏览器外用内存兜底（测试环境）
const memory = new Map<string, string>();
const hasLocalStorage = typeof localStorage !== 'undefined';

function getItem(key: string): string | null {
  return hasLocalStorage ? localStorage.getItem(key) : (memory.get(key) ?? null);
}
function setItem(key: string, value: string): void {
  if (hasLocalStorage) localStorage.setItem(key, value);
  else memory.set(key, value);
}
function removeItem(key: string): void {
  if (hasLocalStorage) localStorage.removeItem(key);
  else memory.delete(key);
}
export function __clearStorageForTests(): void {
  memory.clear();
  if (hasLocalStorage) {
    for (const k of [LOG_KEY, REMOTE_KEY, BACKUP_KEY, LEGACY_KEY, LEGACY_BACKUP_KEY, CORRUPT_KEY]) removeItem(k);
  }
}

/** 测试专用：直接读写底层存储键 */
export const __rawForTests = {
  get: getItem,
  set: setItem,
  remove: removeItem,
  keys: { LOG_KEY, REMOTE_KEY, BACKUP_KEY, LEGACY_KEY, LEGACY_BACKUP_KEY, CORRUPT_KEY },
};

/** 读取本地日志；首次启动时把旧数据迁移成基线；导入崩溃留下的备份自动恢复 */
export function loadLog(): VersionLog {
  // 崩溃恢复：上次导入中途失败/中断，备份还在 → 恢复完整日志，不留半份记录
  const backup = getItem(BACKUP_KEY);
  if (backup) {
    setItem(LOG_KEY, backup);
    removeItem(BACKUP_KEY);
  }
  const raw = getItem(LOG_KEY);
  if (raw) {
    try {
      return parseLog(raw);
    } catch {
      setItem(CORRUPT_KEY, raw); // 损坏的日志留档，继续走迁移/种子
      removeItem(LOG_KEY);
    }
  }
  let legacy: LegacyPair[] | null = null;
  const legacyRaw = getItem(LEGACY_KEY);
  if (legacyRaw) {
    try {
      const parsed: unknown = JSON.parse(legacyRaw);
      if (Array.isArray(parsed) && parsed.length > 0) legacy = parsed as LegacyPair[];
    } catch {
      /* 旧数据损坏则退回种子 */
    }
  }
  const log = migrateLegacy(legacy ?? SEED_PAIRS);
  setItem(LOG_KEY, serializeLog(log));
  if (legacy) {
    setItem(LEGACY_BACKUP_KEY, legacyRaw as string);
    removeItem(LEGACY_KEY);
  }
  return log;
}

export function saveLog(log: VersionLog): void {
  setItem(LOG_KEY, serializeLog(log));
}

/** 写入并压缩（超过 80 个版本时压缩旧记录，被引用方案保留） */
export function commitLog(log: VersionLog): { log: VersionLog; compressedAway: number } {
  const { log: compressed, compressed: comps } = compressLog(log);
  saveLog(compressed);
  return { log: compressed, compressedAway: comps.reduce((a, c) => a + c.removed, 0) };
}

// ---------- 团队库（模拟共享端，离线回连后按字段合并） ----------

export function loadRemote(): VersionLog | null {
  const raw = getItem(REMOTE_KEY);
  if (!raw) return null;
  try {
    return parseLog(raw);
  } catch {
    return null;
  }
}

export function saveRemote(log: VersionLog): void {
  setItem(REMOTE_KEY, serializeLog(log));
}

export interface SyncResult {
  log: VersionLog;
  stats: MergeStats;
  firstSync: boolean;
}

/** 回连同步：把团队库按字段合并进本地，再把合并结果发布回团队库 */
export function syncWithRemote(local: VersionLog): SyncResult {
  const remote = loadRemote();
  if (!remote) {
    saveRemote(local);
    return { log: local, stats: { addedPairs: 0, fastForwarded: 0, autoMergedFields: 0, conflicts: [] }, firstSync: true };
  }
  const { log, stats } = mergeLogs(local, remote, CURRENT_AUTHOR);
  const committed = commitLog(log);
  saveRemote(committed.log);
  return { log: committed.log, stats, firstSync: false };
}

// ---------- 演示：模拟同事离线编辑团队库 ----------

const TEAMMATE_TITLES = ['Quiet confidence', 'Night reader', 'Modern archive', 'Soft system', 'Warm grid'];
const TEAMMATE_HEADINGS = [
  'Design that earns a second look',
  'Where structure meets softness',
  'A calmer kind of bold',
  'Details that do the talking',
];
const TEAMMATE_BODIES = [
  'A revised take from the team: stronger contrast between display and text faces keeps long reads effortless.',
  'Teammate pass — tightened the rhythm and let the heading carry more of the voice.',
  'Exploration from the studio: warmer tone, quieter body, clearer hierarchy.',
];
const TEAMMATE_CATEGORIES = ['Editorial', 'Portfolio', 'Brand', 'Product'];

export function simulateTeammateEdit(local: VersionLog): { pairTitle: string; field: FieldKey; author: string } | null {
  const remote = loadRemote() ?? local;
  const editable = materializeAll(remote).filter((p) => !isFrozen(remote, p.id));
  if (editable.length === 0) return null;
  const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
  const pair = pick(editable);
  const field = pick(['title', 'heading', 'body', 'category', 'favorite'] as const);
  const author = pick(TEAMMATE_AUTHORS);
  const updates: Partial<PairState> = {};
  if (field === 'title') updates.title = pick(TEAMMATE_TITLES);
  if (field === 'heading') updates.heading = pick(TEAMMATE_HEADINGS);
  if (field === 'body') updates.body = pick(TEAMMATE_BODIES);
  if (field === 'category') updates.category = pick(TEAMMATE_CATEGORIES);
  if (field === 'favorite') updates.favorite = !pair.favorite;
  const { log } = appendEdit(remote, pair.id, author, updates);
  saveRemote(log);
  return { pairTitle: pair.title, field, author };
}

// ---------- 导入 / 导出日志 ----------

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface ImportResult {
  log: VersionLog;
  stats: MergeStats;
}

/**
 * 导入团队日志：先全量校验，再一次原子写入；
 * 任何一步失败都从完整备份恢复，不留下半份记录，可修正后重试。
 */
export function importLogFromText(text: string, current: VersionLog): ImportResult {
  const backup = serializeLog(current);
  setItem(BACKUP_KEY, backup); // 崩溃保护：写入前留完整备份
  try {
    const incoming = parseLog(text); // 校验失败直接抛错，此时本地未动
    const { log, stats } = mergeLogs(current, incoming, CURRENT_AUTHOR);
    const committed = commitLog(log); // 单 key 单次写入，天然原子
    removeItem(BACKUP_KEY);
    return { log: committed.log, stats };
  } catch (e) {
    setItem(LOG_KEY, backup); // 从完整日志恢复
    removeItem(BACKUP_KEY);
    if (e instanceof Error) throw new ImportError(e.message);
    throw new ImportError('导入失败，已从完整日志恢复');
  }
}

export function exportLogText(log: VersionLog): string {
  return serializeLog(log);
}
