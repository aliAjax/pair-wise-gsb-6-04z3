// 版本日志引擎：保存作者 / 基线 / 字段改动，离线回连后按字段三路合并，
// 冲突保留两版，冻结方案只能复制新版本，超量版本压缩但不丢被引用方案。

export const FIELDS = ['title', 'heading', 'body', 'category', 'favorite', 'exists'] as const;
export type FieldKey = (typeof FIELDS)[number];
export type FieldValue = string | boolean;

export const FIELD_LABELS: Record<FieldKey, string> = {
  title: '标题',
  heading: '标题文案',
  body: '正文文案',
  category: '分类',
  favorite: '收藏',
  exists: '存在状态',
};

export const MAX_VERSIONS_PER_PAIR = 80;

export interface PairState {
  id: number;
  title: string;
  heading: string;
  body: string;
  category: string;
  favorite: boolean;
  exists: boolean;
}

export interface FieldChange {
  field: FieldKey;
  from: FieldValue;
  to: FieldValue;
}

export type EntryKind =
  | 'baseline' // 旧数据迁移而来的基线
  | 'create' // 新建配对
  | 'edit' // 普通编辑
  | 'merge' // 回连合并产生的版本
  | 'resolve' // 冲突解决
  | 'freeze' // 冻结标记
  | 'fork' // 从冻结方案复制出新版本
  | 'snapshot' // 压缩旧记录生成的快照
  | 'conflict'; // 冲突标记（双版保留）

export interface ConflictInfo {
  conflictId: string;
  pairId: number;
  field: FieldKey;
  baseValue: FieldValue;
  localValue: FieldValue;
  remoteValue: FieldValue;
  localAuthor: string;
  remoteAuthor: string;
  localVersionId: string;
  remoteVersionId: string;
}

export interface VersionEntry {
  id: string;
  pairId: number;
  seq: number;
  author: string;
  timestamp: number;
  baseId: string | null; // 基线（父版本）
  kind: EntryKind;
  changes: FieldChange[]; // 字段级改动
  mergedFrom?: string; // merge：对端头版本 id
  freezesVersionId?: string; // freeze：被冻结的版本 id
  resolvesConflictId?: string; // resolve：关闭的冲突 id
  conflict?: ConflictInfo; // conflict：冲突详情
  snapshot?: PairState; // snapshot：压缩后的完整状态
  compactedCount?: number; // snapshot：被压缩掉的记录数
  compactedAuthors?: string[]; // snapshot：被压缩记录的作者们
  coveredFields?: FieldKey[]; // snapshot：被压缩记录涉及过的字段（保证合并判断不丢）
}

export interface VersionLog {
  entries: VersionEntry[];
  heads: Record<number, string>; // pairId -> 主链头版本 id
  nextSeq: number;
}

let uidCounter = 0;
const uid = (): string =>
  `v${Date.now().toString(36)}-${(uidCounter++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export function emptyLog(): VersionLog {
  return { entries: [], heads: {}, nextSeq: 1 };
}

export function emptyState(pairId: number): PairState {
  return { id: pairId, title: '', heading: '', body: '', category: '', favorite: false, exists: false };
}

function getField(state: PairState, field: FieldKey): FieldValue {
  return state[field];
}

function setField(state: PairState, field: FieldKey, value: FieldValue): void {
  switch (field) {
    case 'title':
      state.title = String(value);
      break;
    case 'heading':
      state.heading = String(value);
      break;
    case 'body':
      state.body = String(value);
      break;
    case 'category':
      state.category = String(value);
      break;
    case 'favorite':
      state.favorite = Boolean(value);
      break;
    case 'exists':
      state.exists = Boolean(value);
      break;
  }
}

function cloneLog(log: VersionLog): VersionLog {
  return { entries: [...log.entries], heads: { ...log.heads }, nextSeq: log.nextSeq };
}

interface EntryDraft {
  pairId: number;
  author: string;
  kind: EntryKind;
  baseId: string | null;
  changes: FieldChange[];
  timestamp?: number;
  mergedFrom?: string;
  freezesVersionId?: string;
  resolvesConflictId?: string;
  conflict?: ConflictInfo;
  snapshot?: PairState;
  compactedCount?: number;
  compactedAuthors?: string[];
  coveredFields?: FieldKey[];
}

function append(log: VersionLog, draft: EntryDraft): { log: VersionLog; entry: VersionEntry } {
  const entry: VersionEntry = {
    id: uid(),
    seq: log.nextSeq,
    timestamp: draft.timestamp ?? Date.now(),
    pairId: draft.pairId,
    author: draft.author,
    kind: draft.kind,
    baseId: draft.baseId,
    changes: draft.changes,
    ...(draft.mergedFrom !== undefined ? { mergedFrom: draft.mergedFrom } : {}),
    ...(draft.freezesVersionId !== undefined ? { freezesVersionId: draft.freezesVersionId } : {}),
    ...(draft.resolvesConflictId !== undefined ? { resolvesConflictId: draft.resolvesConflictId } : {}),
    ...(draft.conflict !== undefined ? { conflict: draft.conflict } : {}),
    ...(draft.snapshot !== undefined ? { snapshot: draft.snapshot } : {}),
    ...(draft.compactedCount !== undefined ? { compactedCount: draft.compactedCount } : {}),
    ...(draft.compactedAuthors !== undefined ? { compactedAuthors: draft.compactedAuthors } : {}),
    ...(draft.coveredFields !== undefined ? { coveredFields: draft.coveredFields } : {}),
  };
  return {
    log: { ...log, entries: [...log.entries, entry], nextSeq: log.nextSeq + 1 },
    entry,
  };
}

// 复制外来记录（保持 id / 作者 / 基线引用不变，只重排本地序号）
function appendRaw(log: VersionLog, entry: VersionEntry): VersionLog {
  return {
    ...log,
    entries: [...log.entries, { ...entry, seq: log.nextSeq }],
    nextSeq: log.nextSeq + 1,
  };
}

function withHead(log: VersionLog, pairId: number, headId: string): VersionLog {
  return { ...log, heads: { ...log.heads, [pairId]: headId } };
}

function byIdMap(entries: VersionEntry[]): Map<string, VersionEntry> {
  return new Map(entries.map((e) => [e.id, e]));
}

/** 主链（旧 → 新）：从头版本沿基线走到创世，快照不阻断（用于历史与压缩统计） */
export function mainChain(log: VersionLog, pairId: number): VersionEntry[] {
  const byId = byIdMap(log.entries);
  const headId = log.heads[pairId];
  if (!headId) return [];
  const chain: VersionEntry[] = [];
  const guard = new Set<string>();
  let cur = byId.get(headId);
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    chain.unshift(cur);
    cur = cur.baseId !== null ? byId.get(cur.baseId) : undefined;
  }
  return chain;
}

function materializeFromMap(byId: Map<string, VersionEntry>, pairId: number, atId: string): PairState {
  const stack: VersionEntry[] = [];
  const guard = new Set<string>();
  let state: PairState | null = null;
  let cur = byId.get(atId);
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    if (cur.snapshot) {
      state = { ...cur.snapshot };
      break;
    }
    stack.push(cur);
    if (cur.baseId === null) break;
    const next = byId.get(cur.baseId);
    if (!next) break; //  dangling 引用：视为创世（校验阶段已杜绝完整日志出现这种情况）
    cur = next;
  }
  if (!state) state = emptyState(pairId);
  for (let i = stack.length - 1; i >= 0; i--) {
    for (const ch of stack[i].changes) setField(state, ch.field, ch.to);
  }
  return state;
}

export function materializeAt(log: VersionLog, pairId: number, atId: string): PairState {
  return materializeFromMap(byIdMap(log.entries), pairId, atId);
}

export function materialize(log: VersionLog, pairId: number): PairState | null {
  const headId = log.heads[pairId];
  return headId ? materializeAt(log, pairId, headId) : null;
}

/** 当前所有「存在」的配对 */
export function materializeAll(log: VersionLog): PairState[] {
  return Object.keys(log.heads)
    .map((k) => materialize(log, Number(k)))
    .filter((s): s is PairState => s !== null && s.exists)
    .sort((a, b) => a.id - b.id);
}

/** fromId（不含）→ toId 之间改动过的字段集合；穿越快照时并入其 coveredFields */
function fieldsBetween(byId: Map<string, VersionEntry>, fromId: string | null, toId: string): Set<FieldKey> {
  const out = new Set<FieldKey>();
  const guard = new Set<string>();
  let cur = byId.get(toId);
  while (cur && cur.id !== fromId && !guard.has(cur.id)) {
    guard.add(cur.id);
    for (const ch of cur.changes) out.add(ch.field);
    if (cur.coveredFields) for (const f of cur.coveredFields) out.add(f);
    if (cur.baseId === null) break;
    cur = byId.get(cur.baseId);
  }
  return out;
}

function nearestCommonAncestor(byId: Map<string, VersionEntry>, aId: string, bId: string): string | null {
  const seen = new Set<string>();
  const guardA = new Set<string>();
  let cur = byId.get(aId);
  while (cur && !guardA.has(cur.id)) {
    guardA.add(cur.id);
    seen.add(cur.id);
    cur = cur.baseId !== null ? byId.get(cur.baseId) : undefined;
  }
  const guardB = new Set<string>();
  cur = byId.get(bId);
  while (cur && !guardB.has(cur.id)) {
    guardB.add(cur.id);
    if (seen.has(cur.id)) return cur.id;
    cur = cur.baseId !== null ? byId.get(cur.baseId) : undefined;
  }
  return null;
}

function isAncestorOf(byId: Map<string, VersionEntry>, ancestorId: string, descendantId: string): boolean {
  const guard = new Set<string>();
  let cur = byId.get(descendantId);
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    if (cur.id === ancestorId) return true;
    cur = cur.baseId !== null ? byId.get(cur.baseId) : undefined;
  }
  return false;
}

/** 对端头版本是否已通过某次 merge 并入本地主链 */
function alreadyMergedInto(byId: Map<string, VersionEntry>, localHeadId: string, remoteHeadId: string): boolean {
  const guard = new Set<string>();
  let cur = byId.get(localHeadId);
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    if (cur.mergedFrom === remoteHeadId) return true;
    cur = cur.baseId !== null ? byId.get(cur.baseId) : undefined;
  }
  return false;
}

// ---------- 写入操作（保存即留痕：作者 + 基线 + 字段改动） ----------

export class FrozenError extends Error {
  constructor(public pairId: number) {
    super('该方案已冻结，不能直接修改，只能复制新版本');
    this.name = 'FrozenError';
  }
}

export function createPair(logIn: VersionLog, author: string, title: string): { log: VersionLog; pairId: number } {
  const pairId = Date.now() * 100 + Math.floor(Math.random() * 100);
  const state = { ...emptyState(pairId), exists: true, title };
  const changes: FieldChange[] = FIELDS.filter((f) => getField(state, f) !== getField(emptyState(pairId), f)).map(
    (f) => ({ field: f, from: getField(emptyState(pairId), f), to: getField(state, f) }),
  );
  const { log, entry } = append(logIn, { pairId, author, kind: 'create', baseId: null, changes });
  return { log: withHead(log, pairId, entry.id), pairId };
}

export function appendEdit(
  logIn: VersionLog,
  pairId: number,
  author: string,
  updates: Partial<Pick<PairState, 'title' | 'heading' | 'body' | 'category' | 'favorite' | 'exists'>>,
): { log: VersionLog; changed: FieldKey[] } {
  if (isFrozen(logIn, pairId)) throw new FrozenError(pairId);
  const current = materialize(logIn, pairId);
  if (!current || !current.exists) throw new Error(`配对 ${pairId} 不存在或已删除`);
  const next = { ...current, ...updates, id: pairId };
  const changes: FieldChange[] = FIELDS.filter((f) => getField(current, f) !== getField(next, f)).map((f) => ({
    field: f,
    from: getField(current, f),
    to: getField(next, f),
  }));
  if (changes.length === 0) return { log: logIn, changed: [] };
  const headId = logIn.heads[pairId];
  const { log, entry } = append(logIn, { pairId, author, kind: 'edit', baseId: headId, changes });
  return { log: withHead(log, pairId, entry.id), changed: changes.map((c) => c.field) };
}

export function deletePair(logIn: VersionLog, pairId: number, author: string): VersionLog {
  return appendEdit(logIn, pairId, author, { exists: false }).log;
}

// ---------- 冻结 / 复制新版本 ----------

export function isFrozen(log: VersionLog, pairId: number): boolean {
  const chain = mainChain(log, pairId);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].kind === 'freeze') return true;
    if (chain[i].kind === 'fork') return false;
  }
  return false;
}

/** 所有被冻结保护、压缩时不得删除的版本 id */
export function frozenVersionIds(log: VersionLog): Set<string> {
  return new Set(
    log.entries.filter((e) => e.kind === 'freeze' && e.freezesVersionId).map((e) => e.freezesVersionId as string),
  );
}

export function freezePair(logIn: VersionLog, pairId: number, author: string): VersionLog {
  if (isFrozen(logIn, pairId)) throw new Error('方案已处于冻结状态');
  const headId = logIn.heads[pairId];
  if (!headId) throw new Error(`配对 ${pairId} 不存在`);
  const { log, entry } = append(logIn, {
    pairId,
    author,
    kind: 'freeze',
    baseId: headId,
    changes: [],
    freezesVersionId: headId,
  });
  return withHead(log, pairId, entry.id);
}

/** 冻结方案只能「复制新版本」：在冻结版本之上派生一个可编辑的新版本 */
export function forkPair(logIn: VersionLog, pairId: number, author: string): VersionLog {
  if (!isFrozen(logIn, pairId)) throw new Error('仅冻结方案需要复制新版本');
  const headId = logIn.heads[pairId];
  const { log, entry } = append(logIn, { pairId, author, kind: 'fork', baseId: headId, changes: [] });
  return withHead(log, pairId, entry.id);
}

// ---------- 冲突 ----------

export function openConflicts(log: VersionLog): ConflictInfo[] {
  const resolved = new Set(
    log.entries.filter((e) => e.kind === 'resolve' && e.resolvesConflictId).map((e) => e.resolvesConflictId as string),
  );
  return log.entries
    .filter((e) => e.kind === 'conflict' && e.conflict && !resolved.has(e.conflict.conflictId))
    .map((e) => e.conflict as ConflictInfo);
}

export function resolveConflict(
  logIn: VersionLog,
  conflictId: string,
  choice: 'local' | 'remote',
  author: string,
): VersionLog {
  const marker = logIn.entries.find((e) => e.kind === 'conflict' && e.conflict?.conflictId === conflictId);
  if (!marker || !marker.conflict) throw new Error(`冲突 ${conflictId} 不存在`);
  if (!openConflicts(logIn).some((c) => c.conflictId === conflictId)) throw new Error('冲突已被解决');
  const c = marker.conflict;
  const current = materialize(logIn, c.pairId);
  if (!current) throw new Error(`配对 ${c.pairId} 不存在`);
  const to = choice === 'local' ? c.localValue : c.remoteValue;
  const changes: FieldChange[] =
    getField(current, c.field) === to ? [] : [{ field: c.field, from: getField(current, c.field), to }];
  const headId = logIn.heads[c.pairId];
  const { log, entry } = append(logIn, {
    pairId: c.pairId,
    author,
    kind: 'resolve',
    baseId: headId,
    changes,
    resolvesConflictId: conflictId,
  });
  return withHead(log, c.pairId, entry.id);
}

// ---------- 三路字段合并（离线回连） ----------

export interface MergeStats {
  addedPairs: number;
  fastForwarded: number;
  autoMergedFields: number;
  conflicts: ConflictInfo[];
}

export function mergeLogs(localIn: VersionLog, remote: VersionLog, author: string): { log: VersionLog; stats: MergeStats } {
  let log = cloneLog(localIn);
  const stats: MergeStats = { addedPairs: 0, fastForwarded: 0, autoMergedFields: 0, conflicts: [] };
  const combined = byIdMap([...log.entries, ...remote.entries]);

  const remotePairs = new Map<number, VersionEntry[]>();
  for (const e of remote.entries) {
    const arr = remotePairs.get(e.pairId) ?? [];
    arr.push(e);
    remotePairs.set(e.pairId, arr);
  }
  for (const arr of remotePairs.values()) arr.sort((a, b) => a.seq - b.seq);

  for (const [pairId, remoteEntries] of remotePairs) {
    const remoteHeadId = remote.heads[pairId];
    if (!remoteHeadId) continue;
    const localHeadId = log.heads[pairId];

    // 本地没有该配对：整链接入
    if (!localHeadId) {
      for (const e of remoteEntries) log = appendRaw(log, e);
      log = withHead(log, pairId, remoteHeadId);
      stats.addedPairs++;
      continue;
    }
    if (localHeadId === remoteHeadId) continue;
    if (isAncestorOf(combined, remoteHeadId, localHeadId)) continue; // 对端落后
    if (isAncestorOf(combined, localHeadId, remoteHeadId)) {
      // 快进：本地落后，直接接上对端记录
      const have = new Set(log.entries.map((e) => e.id));
      for (const e of remoteEntries) if (!have.has(e.id)) log = appendRaw(log, e);
      log = withHead(log, pairId, remoteHeadId);
      stats.fastForwarded++;
      continue;
    }
    if (alreadyMergedInto(combined, localHeadId, remoteHeadId)) continue; // 该对端版本已合并过

    // 分叉：按字段三路合并
    const baseId = nearestCommonAncestor(combined, localHeadId, remoteHeadId);
    const localChanged = fieldsBetween(combined, baseId, localHeadId);
    const remoteChanged = fieldsBetween(combined, baseId, remoteHeadId);
    const baseState = baseId ? materializeFromMap(combined, pairId, baseId) : emptyState(pairId);
    const localState = materializeFromMap(combined, pairId, localHeadId);
    const remoteState = materializeFromMap(combined, pairId, remoteHeadId);
    const localHeadEntry = combined.get(localHeadId);
    const remoteHeadEntry = combined.get(remoteHeadId);

    const merged: PairState = { ...localState };
    const conflicts: ConflictInfo[] = [];
    for (const f of FIELDS) {
      const l = localChanged.has(f);
      const r = remoteChanged.has(f);
      if (l && r) {
        if (getField(localState, f) === getField(remoteState, f)) {
          setField(merged, f, getField(localState, f)); // 两边改成一样，自动合并
        } else {
          // 同一字段两边都改：保留两版并标冲突，状态暂留本地值
          conflicts.push({
            conflictId: uid(),
            pairId,
            field: f,
            baseValue: getField(baseState, f),
            localValue: getField(localState, f),
            remoteValue: getField(remoteState, f),
            localAuthor: localHeadEntry?.author ?? '本地',
            remoteAuthor: remoteHeadEntry?.author ?? '对端',
            localVersionId: localHeadId,
            remoteVersionId: remoteHeadId,
          });
        }
      } else if (r) {
        setField(merged, f, getField(remoteState, f)); // 只有对端改过，自动合并
        stats.autoMergedFields++;
      } else if (l) {
        setField(merged, f, getField(localState, f));
      } else {
        setField(merged, f, getField(baseState, f));
      }
    }

    // 对端版本完整保留进日志（两版都不丢）
    const have = new Set(log.entries.map((e) => e.id));
    for (const e of remoteEntries) if (!have.has(e.id)) log = appendRaw(log, e);

    const mergeChanges: FieldChange[] = FIELDS.filter((f) => getField(merged, f) !== getField(localState, f)).map(
      (f) => ({ field: f, from: getField(localState, f), to: getField(merged, f) }),
    );
    const mergedAt = Date.now();
    const m = append(log, {
      pairId,
      author,
      kind: 'merge',
      baseId: localHeadId,
      changes: mergeChanges,
      mergedFrom: remoteHeadId,
      timestamp: mergedAt,
    });
    log = withHead(m.log, pairId, m.entry.id);

    for (const c of conflicts) {
      const ce = append(log, {
        pairId,
        author,
        kind: 'conflict',
        baseId: log.heads[pairId],
        changes: [],
        conflict: c,
        timestamp: mergedAt,
      });
      log = withHead(ce.log, pairId, ce.entry.id);
    }
    stats.conflicts.push(...conflicts);
  }
  return { log, stats };
}

// ---------- 压缩：超过 80 个版本时压缩旧记录，被引用的方案保留 ----------

export interface CompressionResult {
  log: VersionLog;
  compressed: { pairId: number; removed: number }[];
}

export function compressLog(logIn: VersionLog, maxVersions: number = MAX_VERSIONS_PER_PAIR): CompressionResult {
  let log = cloneLog(logIn);
  const compressed: { pairId: number; removed: number }[] = [];

  // 被引用 / 有语义的记录受保护：冻结版本、未解决冲突引用的两版、
  // 冻结/复制/冲突/解决标记本身、以及当前头版本
  const protectedIds = new Set<string>();
  for (const id of frozenVersionIds(log)) protectedIds.add(id);
  const openIds = new Set<string>();
  for (const c of openConflicts(log)) {
    openIds.add(c.conflictId);
    protectedIds.add(c.localVersionId);
    protectedIds.add(c.remoteVersionId);
  }
  for (const e of log.entries) {
    if (e.kind === 'freeze' || e.kind === 'fork' || e.kind === 'resolve') protectedIds.add(e.id);
    if (e.kind === 'conflict' && e.conflict && openIds.has(e.conflict.conflictId)) protectedIds.add(e.id);
  }

  const removals = new Set<string>();
  const inserts = new Map<string, VersionEntry>(); // run 首条 id -> 快照
  const redirects = new Map<string, string>(); // 被压缩 id -> 快照 id

  const pairIds = [...new Set(log.entries.map((e) => e.pairId))];
  for (const pairId of pairIds) {
    const headId = log.heads[pairId];
    let chain = mainChain(log, pairId);
    if (chain.length <= maxVersions) continue;
    let excess = chain.length - maxVersions;
    let removed = 0;
    const skip = new Set<string>(); // 长度为 1 的孤岛压缩无收益，跳过避免死循环

    while (excess > 0) {
      let start = -1;
      for (let i = 0; i < chain.length; i++) {
        const e = chain[i];
        if (e.id !== headId && !protectedIds.has(e.id) && !skip.has(e.id)) {
          start = i;
          break;
        }
      }
      if (start === -1) break; // 剩下的都受保护，宁可超过上限也不丢
      let end = start;
      while (
        end + 1 < chain.length &&
        chain[end + 1].id !== headId &&
        !protectedIds.has(chain[end + 1].id) &&
        !skip.has(chain[end + 1].id)
      )
        end++;
      const runLen = end - start + 1;
      const take = Math.min(runLen, excess + 1);
      if (take < 2) {
        skip.add(chain[start].id); // 压缩 1 条不减少总数，跳过
        continue;
      }
      const run = chain.slice(start, start + take);
      const last = run[run.length - 1];
      const state = materializeAt(log, pairId, last.id);
      const covered = new Set<FieldKey>();
      for (const e of run) {
        for (const ch of e.changes) covered.add(ch.field);
        if (e.coveredFields) for (const f of e.coveredFields) covered.add(f);
      }
      const snapshot: VersionEntry = {
        id: uid(),
        pairId,
        seq: run[0].seq,
        author: 'system',
        timestamp: last.timestamp,
        baseId: run[0].baseId,
        kind: 'snapshot',
        changes: [],
        snapshot: state,
        compactedCount: run.length,
        compactedAuthors: [...new Set(run.map((e) => e.author))],
        coveredFields: [...covered],
      };
      inserts.set(run[0].id, snapshot);
      for (const e of run) removals.add(e.id);
      redirects.set(last.id, snapshot.id);
      removed += run.length - 1;
      excess -= run.length - 1;
      chain = [...chain.slice(0, start), snapshot, ...chain.slice(start + take)];
    }
    if (removed > 0) compressed.push({ pairId, removed });
  }

  if (removals.size > 0) {
    const next: VersionEntry[] = [];
    for (const e of log.entries) {
      const ins = inserts.get(e.id);
      if (ins) {
        next.push(ins);
        continue;
      }
      if (removals.has(e.id)) continue;
      if (e.baseId !== null && removals.has(e.baseId)) {
        next.push({ ...e, baseId: redirects.get(e.baseId) ?? e.baseId });
        continue;
      }
      next.push(e);
    }
    log = { ...log, entries: next };
  }
  return { log, compressed };
}

// ---------- 导出守卫：冲突未处理完，正式导出停住并说明字段 ----------

export interface ExportBlocker {
  pairId: number;
  title: string;
  fields: FieldKey[];
}

export function exportBlockers(log: VersionLog): ExportBlocker[] {
  const byPair = new Map<number, Set<FieldKey>>();
  for (const c of openConflicts(log)) {
    const set = byPair.get(c.pairId) ?? new Set<FieldKey>();
    set.add(c.field);
    byPair.set(c.pairId, set);
  }
  return [...byPair.entries()].map(([pairId, fields]) => ({
    pairId,
    title: materialize(log, pairId)?.title || `#${pairId}`,
    fields: [...fields],
  }));
}

// ---------- 旧数据迁移为基线 ----------

export interface LegacyPair {
  id: number;
  title: string;
  heading: string;
  body: string;
  category: string;
  favorite: boolean;
}

export function migrateLegacy(pairs: LegacyPair[], author = 'legacy-migration'): VersionLog {
  let log = emptyLog();
  for (const p of pairs) {
    const state: PairState = { ...p, exists: true };
    const changes: FieldChange[] = FIELDS.map((f) => ({
      field: f,
      from: getField(emptyState(p.id), f),
      to: getField(state, f),
    }));
    const { log: l2, entry } = append(log, { pairId: p.id, author, kind: 'baseline', baseId: null, changes });
    log = withHead(l2, p.id, entry.id);
  }
  return log;
}

// ---------- 序列化 / 校验（导入前全量校验，失败不落半份记录） ----------

export class LogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogValidationError';
  }
}

const KINDS: EntryKind[] = ['baseline', 'create', 'edit', 'merge', 'resolve', 'freeze', 'fork', 'snapshot', 'conflict'];

export function serializeLog(log: VersionLog): string {
  return JSON.stringify({ app: 'type-pairer', format: 1, exportedAt: new Date().toISOString(), log });
}

export function parseLog(text: string): VersionLog {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LogValidationError('文件不是有效的 JSON，无法解析');
  }
  let candidate: unknown = raw;
  if (candidate && typeof candidate === 'object' && 'log' in candidate) {
    const env = candidate as { app?: unknown; log?: unknown };
    if (env.app !== 'type-pairer') throw new LogValidationError('文件不是 Type Pairer 导出的日志');
    candidate = env.log;
  }
  const fail = (msg: string): never => {
    throw new LogValidationError(`日志校验失败：${msg}`);
  };
  if (!candidate || typeof candidate !== 'object') fail('缺少日志主体');
  const { entries, heads, nextSeq } = candidate as Record<string, unknown>;
  if (!Array.isArray(entries)) fail('缺少 entries 列表');
  if (!heads || typeof heads !== 'object' || Array.isArray(heads)) fail('缺少 heads 索引');
  if (typeof nextSeq !== 'number' || nextSeq < 1) fail('nextSeq 非法');
  const list = entries as unknown[];

  const ids = new Set<string>();
  list.forEach((e: unknown, i: number) => {
    if (!e || typeof e !== 'object') fail(`第 ${i + 1} 条记录不是对象`);
    const r = e as Record<string, unknown>;
    const id = typeof r.id === 'string' && r.id ? r.id : fail(`第 ${i + 1} 条记录缺少 id`);
    if (ids.has(id)) fail(`记录 id 重复：${id}`);
    ids.add(id);
    if (typeof r.pairId !== 'number' || !Number.isFinite(r.pairId)) fail(`记录 ${r.id} 的 pairId 非法`);
    if (typeof r.seq !== 'number') fail(`记录 ${r.id} 缺少 seq`);
    if (typeof r.author !== 'string' || !r.author) fail(`记录 ${r.id} 缺少作者`);
    if (typeof r.timestamp !== 'number') fail(`记录 ${r.id} 缺少时间戳`);
    if (r.baseId !== null && typeof r.baseId !== 'string') fail(`记录 ${r.id} 的基线引用非法`);
    if (!KINDS.includes(r.kind as EntryKind)) fail(`记录 ${r.id} 类型未知：${String(r.kind)}`);
    if (!Array.isArray(r.changes)) fail(`记录 ${r.id} 缺少字段改动列表`);
    for (const c of r.changes as unknown[]) {
      if (!c || typeof c !== 'object' || !FIELDS.includes((c as { field: FieldKey }).field))
        fail(`记录 ${r.id} 包含未知字段改动`);
    }
  });
  for (const e of entries as VersionEntry[]) {
    if (e.baseId !== null && !ids.has(e.baseId)) fail(`记录 ${e.id} 的基线 ${e.baseId} 不在日志中（日志不完整）`);
  }
  for (const [pid, hid] of Object.entries(heads as Record<string, unknown>)) {
    if (typeof hid !== 'string' || !ids.has(hid)) fail(`配对 ${pid} 的头版本缺失`);
  }
  return candidate as VersionLog;
}

// ---------- 展示辅助 ----------

export function formatFieldValue(field: FieldKey, value: FieldValue): string {
  if (field === 'favorite') return value ? '已收藏' : '未收藏';
  if (field === 'exists') return value ? '存在' : '已删除';
  const s = String(value);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}
