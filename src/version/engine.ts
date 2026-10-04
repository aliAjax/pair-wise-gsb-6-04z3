// 可合并的版本日志引擎
//
// 每个配对是一条只增的日志链（entries，parent 串接）。保存不覆盖旧版，而是追加
// 一条 edit 条目，记录作者、基线（parent）和字段级改动。
//
// 离线场景下本地与“共享库”（remote）各自追加条目；回连时以共同祖先为基线做三方
// 合并：仅一方改过的字段自动采用该方；双方都改且结果不同则保留两版并记冲突，其余
// 字段照常自动合并。冲突未处理完时该配对处于 blocked 状态，禁止正式导出。
//
// 旧数据迁移为 snapshot 基线；冻结配对拒绝修改/删除，只能复制成新版本继续编辑；
// 条目超过 80 条时压缩旧记录，但被 copyOf / 导出记录引用的条目受保护，不会消失。

import {
  EMPTY_DATA, MERGEABLE_FIELDS,
  type EditEntry, type FieldConflict, type FieldValue, type LogEntry,
  type MergeEntry, type MergeableField, type PairData, type PairRecord,
  type RemoteState, type SerializedStore, type SnapshotEntry, type Store,
} from './types';

// ---------- 基础工具 ----------

export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

let seq = 0;
const uniqueTs = (): number => {
  seq = (seq + 1) % 1000;
  return Date.now() * 1000 + seq;
};

const allocEntryId = (s: Store | RemoteState): number => {
  const id = s.nextEntryId;
  s.nextEntryId += 1;
  return id;
};

// ---------- 重放日志得到当前字段 ----------

/**
 * 沿 parent 链重放。返回有序链（根→头）与每一步状态。
 * merge 条目对冲突字段暂取本地版（conflict.local），待冲突解决后由后续 edit 落定。
 */
export function replayPair(pair: PairRecord): { chain: LogEntry[]; states: PairData[]; head: PairData } {
  const byId = new Map<number, LogEntry>();
  for (const e of pair.entries) byId.set(e.id, e);
  const chain: LogEntry[] = [];
  let cur: LogEntry | undefined = pair.entries[pair.entries.length - 1];
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentId == null ? undefined : byId.get(cur.parentId);
  }
  const states: PairData[] = [];
  let state: PairData = { ...EMPTY_DATA };
  const apply = (target: PairData, changes: Record<string, FieldValue>): PairData => {
    const out: PairData = { ...target };
    for (const [k, v] of Object.entries(changes)) {
      (out as unknown as Record<string, FieldValue>)[k] = v;
    }
    return out;
  };
  for (const e of chain) {
    if (e.kind === 'snapshot') {
      state = { ...e.data };
    } else if (e.kind === 'edit') {
      state = apply(state, e.changes);
    } else {
      state = apply(state, e.changes);
      for (const c of e.conflicts) (state as unknown as Record<string, FieldValue>)[c.field] = c.local;
    }
    states.push({ ...state });
  }
  return { chain, states, head: state };
}

export function getPairData(store: Store, pairId: number): PairData {
  const pair = store.pairs[pairId];
  if (!pair) throw new Error('配对不存在');
  return replayPair(pair).head;
}

export function headEntry(pair: PairRecord): LogEntry {
  return pair.entries[pair.entries.length - 1];
}

/** 该配对上尚未解决的冲突字段 */
export function conflictsOf(pair: PairRecord): FieldConflict[] {
  const last = headEntry(pair);
  if (last && last.kind === 'merge' && !last.resolved) return last.conflicts;
  return [];
}

export interface ConflictSummary extends FieldConflict {
  pairId: number;
  title: string;
}

export function allConflicts(store: Store): ConflictSummary[] {
  const out: ConflictSummary[] = [];
  for (const pair of Object.values(store.pairs)) {
    for (const c of conflictsOf(pair)) {
      out.push({ ...c, pairId: pair.id, title: getPairData(store, pair.id).title });
    }
  }
  return out;
}

export const isFrozen = (pair: PairRecord): boolean => pair.frozen;

// ---------- 建库 / 旧数据迁移 ----------

function blankStore(author: string): Store {
  return {
    version: 1, author, online: true,
    pairs: {}, tombstones: [],
    nextPairId: 1, nextEntryId: 100,
    exports: [],
  };
}

const seedPairs = [
  { title: 'Editorial calm', heading: 'A slower way to see', body: "Good typography creates space for ideas to breathe. Pair a confident display face with a quiet, generous text face.", category: 'Editorial', favorite: true, headingFont: 'Fraunces', bodyFont: 'DM Sans' },
  { title: 'Studio notes', heading: 'Make room for the unexpected', body: 'A thoughtful pairing can add rhythm to even the simplest interface. Try contrast in shape, not just size.', category: 'Portfolio', favorite: false, headingFont: 'Fraunces', bodyFont: 'DM Sans' },
  { title: 'Field guide', heading: 'Small details, lasting impressions', body: 'Typography is the voice of a page. Find a combination that feels clear, warm and distinctly yours.', category: 'Brand', favorite: false, headingFont: 'Newsreader', bodyFont: 'DM Sans' },
];

function snapshotOf(store: Store | RemoteState, pairId: number, data: PairData, author: string, migrated = false): SnapshotEntry {
  return {
    id: allocEntryId(store), pairId, ts: uniqueTs(),
    author, parentId: null, kind: 'snapshot',
    ...(migrated ? { migrated: true } : {}),
    data: { ...data },
  };
}

/** 新建一套库（含演示种子），本地与共享库从同一基线开始 */
export function createStoreWithSeed(author: string): { store: Store; remote: RemoteState } {
  const store = blankStore(author);
  const remote: RemoteState = { pairs: {}, tombstones: [], nextEntryId: store.nextEntryId };
  for (const seed of seedPairs) {
    const pairId = store.nextPairId++;
    const data: PairData = { ...EMPTY_DATA, ...seed };
    const snap = snapshotOf(store, pairId, data, author);
    store.pairs[pairId] = {
      id: pairId, createdAt: uniqueTs(), frozen: false,
      entries: [snap], lastSyncedEntryId: snap.id,
    };
    const remoteSnap = { ...snap };
    remote.pairs[pairId] = {
      id: pairId, createdAt: uniqueTs(), frozen: false,
      entries: [remoteSnap], lastSyncedEntryId: remoteSnap.id,
    };
    remote.nextEntryId = store.nextEntryId;
  }
  return { store, remote };
}

interface LegacyPair {
  id: number; title: string; heading: string; body: string;
  category: string; favorite: boolean;
}

/**
 * 旧数据（扁平的 type-pairs 数组）迁移为版本日志：
 * 每个旧配对生成一条带 migrated 标记的 snapshot 基线，并在共享库落同一条基线。
 */
export function migrateLegacy(raw: string, author: string): { store: Store; remote: RemoteState } {
  const legacy = JSON.parse(raw) as LegacyPair[];
  if (!Array.isArray(legacy)) throw new Error('旧数据格式无法识别');
  const store = blankStore(author);
  const remote: RemoteState = { pairs: {}, tombstones: [], nextEntryId: store.nextEntryId };
  for (const old of legacy) {
    const pairId = typeof old.id === 'number' ? old.id : store.nextPairId++;
    store.nextPairId = Math.max(store.nextPairId, pairId + 1);
    const data: PairData = {
      ...EMPTY_DATA,
      title: String(old.title ?? ''),
      heading: String(old.heading ?? ''),
      body: String(old.body ?? ''),
      category: String(old.category ?? 'Untitled'),
      favorite: Boolean(old.favorite),
    };
    const snap = snapshotOf(store, pairId, data, author, true);
    store.pairs[pairId] = {
      id: pairId, createdAt: uniqueTs(), frozen: false,
      entries: [snap], lastSyncedEntryId: snap.id,
    };
    const remoteSnap = { ...snap };
    remote.pairs[pairId] = {
      id: pairId, createdAt: uniqueTs(), frozen: false,
      entries: [remoteSnap], lastSyncedEntryId: remoteSnap.id,
    };
  }
  remote.nextEntryId = store.nextEntryId;
  return { store, remote };
}

// ---------- 本地写操作：新建 / 保存 / 冻结 / 复制 / 删除 ----------

export function createPair(store: Store, title: string): number {
  const pairId = store.nextPairId++;
  const data: PairData = { ...EMPTY_DATA, title };
  const snap = snapshotOf(store, pairId, data, store.author);
  store.pairs[pairId] = {
    id: pairId, createdAt: uniqueTs(), frozen: false,
    entries: [snap],
    // 离线也可能新建：此时还没有共同基线，回连推送时再对齐
    lastSyncedEntryId: store.online ? snap.id : null,
  };
  return pairId;
}

/**
 * 保存：追加一条 edit 日志（作者 + 基线 parent + 字段改动），不覆盖任何旧版。
 * 冻结方案与“冲突未决”的方案禁止修改。超过 80 条时自动压缩旧记录。
 */
export function saveEdit(store: Store, pairId: number, changes: Partial<PairData>): EditEntry {
  const pair = store.pairs[pairId];
  if (!pair) throw new Error('配对不存在');
  if (pair.frozen) throw new Error('方案已冻结，不能越权修改；请先复制成新版本');
  if (conflictsOf(pair).length) throw new Error('该配对存在未处理的冲突，请先解决再保存');

  const current = replayPair(pair).head;
  const diff: Record<string, FieldValue> = {};
  for (const [k, v] of Object.entries(changes)) {
    if (v !== undefined && (current as unknown as Record<string, FieldValue>)[k] !== v) diff[k] = v;
  }
  if (Object.keys(diff).length === 0) throw new Error('没有字段变化');

  const parent = headEntry(pair);
  const entry: EditEntry = {
    id: allocEntryId(store), pairId, ts: uniqueTs(),
    author: store.author, parentId: parent.id, kind: 'edit', changes: diff,
  };
  pair.entries.push(entry);
  if (pair.entries.length > 80) compactPair(store, pairId);
  return entry;
}

export function freezePair(store: Store, pairId: number): void {
  const pair = store.pairs[pairId];
  if (!pair) throw new Error('配对不存在');
  if (conflictsOf(pair).length) throw new Error('冲突未解决的方案不能冻结');
  pair.frozen = true;
}

/**
 * 冻结方案只能“复制成新版本”继续做：
 * 以冻结方案当前字段为基线开一条新日志，并保留 copyOf 引用（压缩时受保护）。
 */
export function duplicateFrozen(store: Store, pairId: number): number {
  const src = store.pairs[pairId];
  if (!src) throw new Error('配对不存在');
  if (conflictsOf(src).length) throw new Error('冲突未解决的方案不能复制');
  const newId = store.nextPairId++;
  const data = replayPair(src).head;
  const snap = snapshotOf(store, newId, data, store.author);
  store.pairs[newId] = {
    id: newId, createdAt: uniqueTs(), frozen: false,
    copyOf: { fromPairId: pairId, entryId: headEntry(src).id, ts: uniqueTs() },
    entries: [snap],
    lastSyncedEntryId: store.online ? null : null,
  };
  return newId;
}

export function deletePair(store: Store, pairId: number): void {
  const pair = store.pairs[pairId];
  if (!pair) return;
  if (pair.frozen) throw new Error('冻结方案不能删除；如需迭代请复制成新版本');
  delete store.pairs[pairId];
  store.tombstones = [...new Set([...store.tombstones, pairId])];
}

// ---------- 回连合并（三方 / 字段级） ----------

/**
 * 共同祖先（LCA）。
 * 只比直接 parent 不够——离线撞号时两条新 edit 都挂在同一个旧父节点下，
 * parentId 相同却是完全不同的两条记录；因此从各自头部沿 parent 回溯，
 * 取两条祖先路径上“最后一个完全对齐的节点”。
 */
function commonPrefix(localEntries: LogEntry[], remoteEntries: LogEntry[]): number | null {
  const localById = new Map<number, LogEntry>(localEntries.map(e => [e.id, e] as [number, LogEntry]));
  const remoteById = new Map<number, LogEntry>(remoteEntries.map(e => [e.id, e] as [number, LogEntry]));

  const pathOf = (entries: LogEntry[], byId: Map<number, LogEntry>): LogEntry[] => {
    const path: LogEntry[] = [];
    let cur: LogEntry | undefined = entries[entries.length - 1];
    while (cur) {
      path.unshift(cur);
      cur = cur.parentId == null ? undefined : byId.get(cur.parentId);
    }
    return path;
  };

  const lp = pathOf(localEntries, localById);
  const rp = pathOf(remoteEntries, remoteById);
  const n = Math.min(lp.length, rp.length);
  let lca: number | null = null;
  for (let i = 0; i < n; i++) {
    if (lp[i].id !== rp[i].id) break;
    lca = lp[i].id;
  }
  return lca;
}

function replayUntil(pair: PairRecord, entryId: number | null): PairData {
  if (entryId == null) return { ...EMPTY_DATA };
  const { chain, states } = replayPair(pair);
  const idx = chain.findIndex(e => e.id === entryId);
  if (idx < 0) return { ...EMPTY_DATA };
  return states[idx];
}

/**
 * 离线双方各自分配 id，回连时可能撞 id。
 * 共同祖先不能在撞号数据上直接求（会把撞号条目误当成同一条），所以先依据
 * 上一次同步点 lastSyncedEntryId 找出本地“尚未推送”的条目；这些条目若与
 * 共享库撞号就改号（共享库 id 视为权威），并改写本地所有引用。
 */
function rekeyCollisions(store: Store, remote: RemoteState): void {
  const remoteIds = new Set<number>();
  for (const p of Object.values(remote.pairs)) for (const e of p.entries) remoteIds.add(e.id);

  const collisions = new Set<number>();
  for (const pair of Object.values(store.pairs)) {
    if (!remote.pairs[pair.id]) continue;
    // 从头部回溯到上次同步点，这段都是本地未推送条目
    const byId = new Map(pair.entries.map(e => [e.id, e]));
    let cur = byId.get(pair.entries[pair.entries.length - 1].id);
    while (cur) {
      if (cur.id === pair.lastSyncedEntryId) break;
      if (remoteIds.has(cur.id)) collisions.add(cur.id);
      cur = cur.parentId == null ? undefined : byId.get(cur.parentId);
    }
  }
  if (collisions.size === 0) return;

  const localIds = new Set<number>();
  for (const p of Object.values(store.pairs)) for (const e of p.entries) localIds.add(e.id);

  const idMap = new Map<number, number>();
  const used = new Set<number>([...localIds, ...remoteIds]);
  for (const old of collisions) {
    let fresh = Math.max(store.nextEntryId, remote.nextEntryId);
    while (used.has(fresh)) fresh++;
    used.add(fresh);
    idMap.set(old, fresh);
  }
  store.nextEntryId = remote.nextEntryId = Math.max(...used) + 1;

  const mapId = (id: number | null): number | null =>
    id == null ? null : (idMap.get(id) ?? id);

  for (const pair of Object.values(store.pairs)) {
    for (const e of pair.entries) {
      if (idMap.has(e.id)) e.id = idMap.get(e.id)!;
      e.parentId = mapId(e.parentId);
      if (e.kind === 'merge') {
        e.localHeadId = mapId(e.localHeadId)!;
        e.remoteHeadId = mapId(e.remoteHeadId)!;
        e.remoteEntryId = mapId(e.remoteEntryId)!;
      }
    }
    pair.lastSyncedEntryId = mapId(pair.lastSyncedEntryId);
    if (pair.copyOf) pair.copyOf.entryId = mapId(pair.copyOf.entryId)!;
  }
  for (const ex of store.exports) ex.entryId = mapId(ex.entryId)!;
}

export interface MergeReport {
  merged: number[];          // 有合并动作的配对
  autoMerged: number[];      // 完全自动合并（无冲突）
  pushed: number[];          // 仅本地领先，已推送
  pulled: number[];          // 仅远端领先，已拉取
  conflicts: ConflictSummary[];
}

/**
 * 回连同步：逐配对找共同祖先（LCA），按字段三方合并。
 *  - 仅本地改：推送到共享库
 *  - 仅同事改：拉取，本地自动跟进
 *  - 同字段两边都改且结果不同：保留两版 + 标冲突；其他字段自动合并
 */
export function syncWithRemote(store: Store, remote: RemoteState): MergeReport {
  const report: MergeReport = { merged: [], autoMerged: [], pushed: [], pulled: [], conflicts: [] };
  rekeyCollisions(store, remote);

  // 远端删掉的配对，本地跟进删除；本地删掉的，远端跟进删除
  for (const id of remote.tombstones) {
    if (store.pairs[id] && !store.tombstones.includes(id)) {
      delete store.pairs[id];
      store.tombstones.push(id);
    }
  }
  for (const id of store.tombstones) {
    if (remote.pairs[id]) delete remote.pairs[id];
    if (!remote.tombstones.includes(id)) remote.tombstones.push(id);
  }

  for (const localPair of Object.values(clone(store.pairs))) {
    const rp = remote.pairs[localPair.id];
    const lp = store.pairs[localPair.id];

    // 本地独有：整链推送到共享库
    if (!rp) {
      remote.pairs[lp.id] = clone(lp);
      lp.lastSyncedEntryId = headEntry(lp).id;
      report.pushed.push(lp.id);
      continue;
    }

    const lcaId = commonPrefix(lp.entries, rp.entries);
    const localHead = headEntry(lp).id;
    const remoteHead = headEntry(rp).id;
    const localNew = lcaId !== localHead;
    const remoteNew = lcaId !== remoteHead;

    if (!localNew && !remoteNew) continue;

    // 仅远端领先：拉取远端新条目
    if (!localNew && remoteNew) {
      const suffix = suffixAfter(rp.entries, lcaId);
      lp.entries.push(...clone(suffix));
      lp.lastSyncedEntryId = remoteHead;
      report.pulled.push(lp.id);
      continue;
    }

    // 仅本地领先：推送到远端
    if (localNew && !remoteNew) {
      const suffix = suffixAfter(lp.entries, lcaId);
      rp.entries.push(...clone(suffix));
      rp.lastSyncedEntryId = localHead;
      lp.lastSyncedEntryId = localHead;
      report.pushed.push(lp.id);
      continue;
    }

    // 双方都改：按字段三方合并
    const base = replayUntil(lp, lcaId);
    const lv = replayPair(lp).head;
    const rvState = replayPair(rp).head;

    const changes: Partial<Record<MergeableField, FieldValue>> = {};
    const conflicts: FieldConflict[] = [];
    for (const f of MERGEABLE_FIELDS) {
      const b = base[f], a = lv[f], c = rvState[f];
      const localChanged = a !== b;
      const remoteChanged = c !== b;
      if (!localChanged && !remoteChanged) continue;
      if (localChanged && !remoteChanged) changes[f] = a;
      else if (!localChanged && remoteChanged) changes[f] = c;
      else if (a === c) changes[f] = a;
      else conflicts.push({ field: f, base: b, local: a, remote: c });
    }

    const mergeId = store.nextEntryId;
    store.nextEntryId += 1;
    remote.nextEntryId = store.nextEntryId;

    const localMerge: MergeEntry = {
      id: mergeId, pairId: lp.id, ts: uniqueTs(),
      author: store.author, parentId: localHead, kind: 'merge',
      localHeadId: localHead, remoteHeadId: remoteHead, remoteEntryId: mergeId,
      changes, conflicts: clone(conflicts), resolved: conflicts.length === 0,
    };
    // 远端侧记同一条合并（无冲突概念，直接视为已定版本）
    const remoteMerge: MergeEntry = {
      ...clone(localMerge), parentId: remoteHead,
    };
    lp.entries.push(localMerge);
    rp.entries.push(remoteMerge);
    lp.lastSyncedEntryId = mergeId;
    rp.lastSyncedEntryId = mergeId;

    report.merged.push(lp.id);
    if (conflicts.length === 0) {
      report.autoMerged.push(lp.id);
    } else {
      for (const c of conflicts) {
        report.conflicts.push({ ...c, pairId: lp.id, title: lv.title });
      }
    }
  }

  // 远端独有的配对（同事新建，本演示暂不会出现）拉取到本地
  for (const rp of Object.values(remote.pairs)) {
    if (!store.pairs[rp.id]) {
      const pulled = clone(rp);
      pulled.lastSyncedEntryId = headEntry(pulled).id;
      store.pairs[rp.id] = pulled;
      report.pulled.push(rp.id);
    }
  }
  remote.nextEntryId = Math.max(remote.nextEntryId, store.nextEntryId);
  store.nextEntryId = Math.max(remote.nextEntryId, store.nextEntryId);
  return report;
}

function suffixAfter(entries: LogEntry[], afterId: number | null): LogEntry[] {
  if (afterId == null) return entries;
  const idx = entries.findIndex(e => e.id === afterId);
  return entries.slice(idx + 1);
}

/** 模拟同事在共享库里改了某些字段（用于演示离线冲突） */
export function simulateRemoteEdit(
  remote: RemoteState, pairId: number, changes: Partial<PairData>, author = 'Morgan Reyes',
): void {
  const pair = remote.pairs[pairId];
  if (!pair) throw new Error('共享库中没有该配对');
  const current = replayPair(pair).head;
  const diff: Record<string, FieldValue> = {};
  for (const [k, v] of Object.entries(changes)) {
    if (v !== undefined && (current as unknown as Record<string, FieldValue>)[k] !== v) diff[k] = v;
  }
  if (Object.keys(diff).length === 0) return;
  pair.entries.push({
    id: allocEntryId(remote), pairId, ts: uniqueTs(),
    author, parentId: headEntry(pair).id, kind: 'edit', changes: diff,
  });
}

// ---------- 冲突解决 ----------

export type ConflictDecision =
  | { resolution: 'local' }
  | { resolution: 'remote' }
  | { resolution: 'custom'; value: FieldValue };

/**
 * 拍板冲突：每个字段都必须选定（本地版 / 同事版 / 自定义）。
 * 全部处理完后追加一条 resolve edit 落定字段，并把 merge 条目标记为已解决；
 * 未全部处理完则拒绝。落定后回连会把这条 edit 正常推送到共享库。
 */
export function resolveConflicts(
  store: Store, pairId: number, decisions: Partial<Record<MergeableField, ConflictDecision>>,
): EditEntry {
  const pair = store.pairs[pairId];
  if (!pair) throw new Error('配对不存在');
  const merge = headEntry(pair);
  if (merge.kind !== 'merge' || merge.resolved) throw new Error('该配对没有待处理的冲突');

  for (const c of merge.conflicts) {
    const d = decisions[c.field];
    if (!d) throw new Error(`字段「${fieldLabel(c.field)}」还没有选择保留哪一版`);
    c.resolution = d.resolution;
    if (d.resolution === 'custom') {
      if (d.value === undefined || d.value === '') throw new Error(`字段「${fieldLabel(c.field)}」的自定义值不能为空`);
      c.customValue = d.value;
    }
  }

  const current = replayPair(pair).head;
  const changes: Record<string, FieldValue> = {};
  for (const c of merge.conflicts) {
    const d = decisions[c.field]!;
    const value = d.resolution === 'local' ? c.local
      : d.resolution === 'remote' ? c.remote
      : d.value;
    if (current[c.field] !== value) changes[c.field] = value;
    c.resolution = d.resolution;
  }

  const entry: EditEntry = {
    id: allocEntryId(store), pairId, ts: uniqueTs(),
    author: store.author, parentId: merge.id, kind: 'edit',
    resolves: merge.conflicts.map(c => c.field),
    changes,
  };
  pair.entries.push(entry);
  merge.resolved = true;
  return entry;
}

export const fieldLabel = (f: MergeableField): string => ({
  title: '名称', heading: '标题文案', body: '正文', category: '分类',
  headingFont: '标题字体', bodyFont: '正文字体', size: '字号',
  weight: '字重', leading: '行高', tracking: '字间距',
}[f]);

// ---------- 版本压缩（>80 条） ----------

/**
 * 压缩旧记录：把受保护范围之前的连续旧条目折叠成一条 snapshot 基线。
 * 受保护、绝不消失的条目：
 *  - 最近 10 条
 *  - 未解决的 merge 及其之后（冲突证据必须保留）
 *  - 被任意 copyOf / 导出记录引用的条目 —— “仍被引用的方案不能消失”
 * 已同步的旧条目可以折叠：折叠出的 snapshot 会在下次同步时推到共享库，
 * 成为双方新的共同基线，三方合并不受影响。
 */
export function compactPair(store: Store, pairId: number): void {
  const pair = store.pairs[pairId];
  if (!pair || pair.entries.length <= 80) return;

  const referenced = new Set<number>();
  for (const p of Object.values(store.pairs)) if (p.copyOf?.fromPairId === pairId) referenced.add(p.copyOf.entryId);
  for (const ex of store.exports) if (ex.pairId === pairId) referenced.add(ex.entryId);

  const unresolvedMergeIdx = pair.entries.findIndex(
    e => e.kind === 'merge' && !e.resolved);

  const protectedIdx = new Set<number>();
  for (let i = Math.max(0, pair.entries.length - 10); i < pair.entries.length; i++) protectedIdx.add(i);
  if (unresolvedMergeIdx >= 0) for (let i = unresolvedMergeIdx; i < pair.entries.length; i++) protectedIdx.add(i);
  pair.entries.forEach((e, i) => { if (referenced.has(e.id)) protectedIdx.add(i); });

  let cut = 0;
  while (cut < pair.entries.length && !protectedIdx.has(cut)) cut++;
  // 至少折叠 20 条才动手，避免每次保存都产生新 snapshot；折叠后重新计数
  if (cut < 20 || pair.entries.length - cut + 1 >= pair.entries.length) return;

  const folded = pair.entries.slice(0, cut);
  const rest = pair.entries.slice(cut);
  const foldedState = replayPair({ ...pair, entries: folded }).head;
  const root = folded[0];

  const snap: SnapshotEntry = {
    id: allocEntryId(store), pairId, ts: uniqueTs(),
    author: root.author, parentId: null, kind: 'snapshot',
    data: foldedState,
  };
  rest[0] = { ...rest[0], parentId: snap.id };
  pair.entries = [snap, ...rest];
  // 若折叠掉的是已经同步过的历史，snapshot 就是新的同步基线
  if (pair.lastSyncedEntryId != null) {
    const stillPresent = pair.entries.some(e => e.id === pair.lastSyncedEntryId);
    if (!stillPresent) pair.lastSyncedEntryId = snap.id;
  }
}

export function compactStore(store: Store): void {
  for (const id of Object.keys(store.pairs).map(Number)) compactPair(store, id);
}

// ---------- 正式导出（冲突闸门） ----------

export type ExportGate =
  | { ok: true; pairId: number; entryId: number }
  | { ok: false; pairId: number; conflicts: FieldConflict[] };

/** 导出前检查：任何冲突未处理完都停住，并指出是哪几个字段 */
export function checkExportable(store: Store, pairId: number): ExportGate {
  const pair = store.pairs[pairId];
  if (!pair) throw new Error('配对不存在');
  const conflicts = conflictsOf(pair);
  if (conflicts.length) return { ok: false, pairId, conflicts };
  return { ok: true, pairId, entryId: headEntry(pair).id };
}

/** 登记一次正式导出（引用具体版本，压缩时该版本受保护） */
export function registerExport(store: Store, pairId: number): number {
  const gate = checkExportable(store, pairId);
  if (!gate.ok) throw new Error('存在未解决的冲突，导出已中止');
  const id = (store.exports.reduce((m, e) => Math.max(m, e.id), 0) + 1);
  store.exports.push({
    id, ts: uniqueTs(), pairId, entryId: gate.entryId, author: store.author,
  });
  return id;
}

// ---------- 完整日志的导出 / 导入（原子性） ----------

export interface LogFile {
  kind: 'type-pairer-log';
  exportedAt: number;
  author: string;
  store: SerializedStore;
}

export function serializeLog(store: Store): string {
  const file: LogFile = {
    kind: 'type-pairer-log', exportedAt: uniqueTs(),
    author: store.author, store: clone(store),
  };
  return JSON.stringify(file, null, 2);
}

const isFieldValue = (v: unknown): v is FieldValue =>
  ['string', 'number', 'boolean'].includes(typeof v);

/** 导入前完整校验：任何一条记录不合法都整体拒绝，绝不留下半份记录 */
export function validateLogFile(raw: unknown): asserts raw is LogFile {
  const fail = (msg: string): never => { throw new Error(`日志文件无效：${msg}`); };
  const obj = (v: unknown, msg: string): Record<string, unknown> => {
    if (!isObj(v)) fail(msg);
    return v as Record<string, unknown>;
  };
  const root = obj(raw, '缺少 type-pairer-log 标识');
  if (root.kind !== 'type-pairer-log') fail('缺少 type-pairer-log 标识');
  const s = obj(root.store, '缺少 store');
  if (s.version !== 1) fail('版本号不支持');
  if (typeof s.author !== 'string' || !(s.author as string).trim()) fail('作者信息缺失');
  const pairs = obj(s.pairs, 'pairs 结构损坏');
  if (!Array.isArray(s.tombstones) || !(s.tombstones as unknown[]).every((x: unknown) => typeof x === 'number')) fail('tombstones 损坏');
  if (typeof s.nextPairId !== 'number' || typeof s.nextEntryId !== 'number') fail('计数器损坏');
  if (!Array.isArray(s.exports)) fail('exports 损坏');

  for (const [pid, pv] of Object.entries(pairs)) {
    const p = obj(pv, `配对 ${pid} 结构损坏`);
    if (typeof p.id !== 'number' || typeof p.frozen !== 'boolean' || !Array.isArray(p.entries)) {
      fail(`配对 ${pid} 字段不完整`);
    }
    const entries = p.entries as unknown[];
    if (entries.length === 0) fail(`配对 ${pid} 日志为空`);
    const ids = new Set<number>();
    for (const ev of entries) {
      const e = obj(ev, `配对 ${pid} 条目结构损坏`);
      if (typeof e.id !== 'number' || typeof e.author !== 'string') fail(`配对 ${pid} 有条目缺作者/ id`);
      if (!['snapshot', 'edit', 'merge'].includes(String(e.kind))) fail(`配对 ${pid} 有条目类型未知`);
      if (ids.has(e.id as number)) fail(`配对 ${pid} 内条目 id 重复`);
      ids.add(e.id as number);
      if (e.kind === 'edit' && (!isObj(e.changes) || !Object.values(e.changes).every(isFieldValue))) {
        fail(`配对 ${pid} 的改动记录损坏`);
      }
      if (e.kind === 'snapshot' && !isObj(e.data)) fail(`配对 ${pid} 的基线缺少字段数据`);
      if (e.kind === 'merge' && !Array.isArray(e.conflicts)) fail(`配对 ${pid} 的合并记录损坏`);
      if (e.parentId != null && typeof e.parentId !== 'number') fail(`配对 ${pid} 基线引用损坏`);
    }
    // parent 链必须闭合
    for (const ev of entries) {
      const e = ev as LogEntry;
      if (e.parentId != null && !ids.has(e.parentId)) fail(`配对 ${pid} 的日志链断裂（缺基线 ${e.parentId}）`);
    }
    if (p.copyOf != null) {
      const copy = obj(p.copyOf, `配对 ${pid} copyOf 损坏`);
      const fromPairId = copy.fromPairId as number;
      const refEntry = copy.entryId as number;
      const ref = pairs[String(fromPairId)];
      if (!isObj(ref) || !(ref.entries as unknown[]).some(en => isObj(en) && en.id === refEntry)) {
        fail(`配对 ${pid} 引用的源方案版本已不存在`);
      }
    }
  }
  for (const exv of s.exports as unknown[]) {
    const ex = obj(exv, '导出记录损坏');
    if (typeof ex.pairId !== 'number' || typeof ex.entryId !== 'number') fail('导出记录损坏');
    const p = pairs[String(ex.pairId)];
    if (!isObj(p) || !(p.entries as unknown[]).some(e => isObj(e) && e.id === ex.entryId)) {
      fail(`导出记录 #${(ex.id as number) ?? '?'} 引用的方案版本不存在`);
    }
  }
}

/** 解析但不落盘；调用方负责在成功后原子写入 */
export function parseLogFile(text: string): LogFile {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('日志文件无效：JSON 解析失败'); }
  validateLogFile(raw);
  return raw;
}
