import { describe, expect, it } from 'vitest';
import {
  appendEdit,
  compressLog,
  createPair,
  deletePair,
  emptyLog,
  exportBlockers,
  forkPair,
  freezePair,
  frozenVersionIds,
  isFrozen,
  mainChain,
  materialize,
  materializeAll,
  mergeLogs,
  migrateLegacy,
  openConflicts,
  parseLog,
  resolveConflict,
  serializeLog,
  FrozenError,
  LogValidationError,
  type PairState,
  type VersionLog,
} from './versionLog';

const A = 'Yuki Lin';
const B = 'Chen Wei';

function seedLog(): VersionLog {
  return migrateLegacy([
    { id: 1, title: 'Editorial calm', heading: 'A slower way to see', body: 'body one', category: 'Editorial', favorite: true },
    { id: 2, title: 'Studio notes', heading: 'Make room', body: 'body two', category: 'Portfolio', favorite: false },
  ]);
}

/** 构造双方分叉：共同基线后，本地改 localEdits，对端改 remoteEdits */
function diverged(localEdits: Partial<PairState>, remoteEdits: Partial<PairState>) {
  const base = seedLog();
  const local = appendEdit(base, 1, A, localEdits).log;
  const remote = appendEdit(base, 1, B, remoteEdits).log;
  return { local, remote };
}

describe('基线迁移', () => {
  it('旧数据迁移成基线，可完整还原', () => {
    const log = seedLog();
    const p1 = materialize(log, 1);
    expect(p1).toMatchObject({ title: 'Editorial calm', favorite: true, exists: true });
    const chain = mainChain(log, 1);
    expect(chain).toHaveLength(1);
    expect(chain[0].kind).toBe('baseline');
    expect(chain[0].author).toBe('legacy-migration');
    expect(chain[0].changes.map((c) => c.field).sort()).toEqual(
      ['body', 'category', 'exists', 'favorite', 'heading', 'title'].sort(),
    );
  });
});

describe('保存留痕', () => {
  it('每次保存记录作者、基线和字段改动', () => {
    const base = seedLog();
    const baseHead = base.heads[1];
    const { log, changed } = appendEdit(base, 1, A, { title: 'New title', favorite: false });
    expect(changed.sort()).toEqual(['favorite', 'title']);
    const chain = mainChain(log, 1);
    const last = chain[chain.length - 1];
    expect(last.author).toBe(A);
    expect(last.baseId).toBe(baseHead);
    expect(last.changes).toEqual([
      { field: 'title', from: 'Editorial calm', to: 'New title' },
      { field: 'favorite', from: true, to: false },
    ]);
    expect(materialize(log, 1)).toMatchObject({ title: 'New title', favorite: false });
  });

  it('无实际改动不产生新版本', () => {
    const base = seedLog();
    const { log, changed } = appendEdit(base, 1, A, { title: 'Editorial calm' });
    expect(changed).toEqual([]);
    expect(log.entries).toHaveLength(base.entries.length);
  });
});

describe('回连按字段合并', () => {
  it('不同字段各改各的 → 自动合并', () => {
    const { local, remote } = diverged({ title: 'Local title' }, { category: 'Brand' });
    const { log, stats } = mergeLogs(local, remote, A);
    expect(stats.conflicts).toHaveLength(0);
    expect(stats.autoMergedFields).toBe(1);
    expect(materialize(log, 1)).toMatchObject({ title: 'Local title', category: 'Brand' });
  });

  it('同一字段两边都改 → 保留两版并标冲突，状态暂留本地值', () => {
    const { local, remote } = diverged({ title: 'Local title' }, { title: 'Remote title' });
    const { log, stats } = mergeLogs(local, remote, A);
    expect(stats.conflicts).toHaveLength(1);
    const c = stats.conflicts[0];
    expect(c.field).toBe('title');
    expect(c.localValue).toBe('Local title');
    expect(c.remoteValue).toBe('Remote title');
    expect(c.localAuthor).toBe(A);
    expect(c.remoteAuthor).toBe(B);
    // 两版都留在日志里
    expect(log.entries.some((e) => e.id === c.localVersionId)).toBe(true);
    expect(log.entries.some((e) => e.id === c.remoteVersionId)).toBe(true);
    // 冲突未解决前状态保留本地值
    expect(materialize(log, 1)?.title).toBe('Local title');
    expect(openConflicts(log)).toHaveLength(1);
  });

  it('同一字段两边改成一样的值 → 不算冲突', () => {
    const { local, remote } = diverged({ title: 'Same' }, { title: 'Same' });
    const { log, stats } = mergeLogs(local, remote, A);
    expect(stats.conflicts).toHaveLength(0);
    expect(materialize(log, 1)?.title).toBe('Same');
  });

  it('只有对端改的字段自动跟上（含快进）', () => {
    const base = seedLog();
    const remote = appendEdit(base, 1, B, { body: 'remote body' }).log;
    const { log, stats } = mergeLogs(base, remote, A);
    expect(stats.fastForwarded).toBe(1);
    expect(materialize(log, 1)?.body).toBe('remote body');
  });

  it('对端新增的配对整链并入本地', () => {
    const base = seedLog();
    const { log: remote } = createPair(base, B, 'Teammate pair');
    const { log, stats } = mergeLogs(base, remote, A);
    expect(stats.addedPairs).toBe(1);
    expect(materializeAll(log).some((p) => p.title === 'Teammate pair')).toBe(true);
  });

  it('合并幂等：同一对端日志合两次，第二次无变化', () => {
    const { local, remote } = diverged({ title: 'L' }, { category: 'R' });
    const first = mergeLogs(local, remote, A);
    const second = mergeLogs(first.log, remote, A);
    expect(second.stats.conflicts).toHaveLength(0);
    expect(second.stats.autoMergedFields).toBe(0);
    expect(second.log.entries).toHaveLength(first.log.entries.length);
  });

  it('解决冲突后状态更新，导出守卫放行', () => {
    const { local, remote } = diverged({ title: 'Local title' }, { title: 'Remote title' });
    const { log } = mergeLogs(local, remote, A);
    const conflict = openConflicts(log)[0];
    expect(exportBlockers(log)).toEqual([{ pairId: 1, title: 'Local title', fields: ['title'] }]);
    const resolved = resolveConflict(log, conflict.conflictId, 'remote', A);
    expect(openConflicts(resolved)).toHaveLength(0);
    expect(materialize(resolved, 1)?.title).toBe('Remote title');
    expect(exportBlockers(resolved)).toEqual([]);
  });

  it('删除也是字段级改动，可参与合并', () => {
    const base = seedLog();
    const local = deletePair(base, 1, A);
    const remote = appendEdit(base, 1, B, { title: 'Edited by remote' }).log;
    const { log, stats } = mergeLogs(local, remote, A);
    // 本地删、对端改标题：不同字段 → 自动合并，配对保持删除态
    expect(stats.conflicts).toHaveLength(0);
    expect(materialize(log, 1)?.exists).toBe(false);
    expect(materialize(log, 1)?.title).toBe('Edited by remote');
  });
});

describe('冻结与复制新版本', () => {
  it('冻结后禁止直接修改，只能复制新版本', () => {
    const base = seedLog();
    const frozen = freezePair(base, 1, A);
    expect(isFrozen(frozen, 1)).toBe(true);
    expect(() => appendEdit(frozen, 1, A, { title: 'x' })).toThrow(FrozenError);
    const forked = forkPair(frozen, 1, A);
    expect(isFrozen(forked, 1)).toBe(false);
    const { log } = appendEdit(forked, 1, A, { title: 'after fork' });
    expect(materialize(log, 1)?.title).toBe('after fork');
  });

  it('被冻结的版本进入保护集', () => {
    const base = seedLog();
    const headBefore = base.heads[1];
    const frozen = freezePair(base, 1, A);
    expect(frozenVersionIds(frozen).has(headBefore)).toBe(true);
  });
});

describe('压缩', () => {
  function logWithManyEdits(n: number): VersionLog {
    let log = seedLog();
    for (let i = 0; i < n; i++) log = appendEdit(log, 1, A, { title: `title-${i}` }).log;
    return log;
  }

  it('超过 80 个版本压缩旧记录，状态不变', () => {
    const log = logWithManyEdits(90);
    expect(mainChain(log, 1).length).toBe(91);
    const before = materialize(log, 1);
    const { log: compressed, compressed: comps } = compressLog(log);
    expect(comps).toHaveLength(1);
    expect(mainChain(compressed, 1).length).toBeLessThanOrEqual(80);
    expect(materialize(compressed, 1)).toEqual(before);
    // 生成了快照，且记录被压缩涉及的字段
    const snap = mainChain(compressed, 1).find((e) => e.kind === 'snapshot');
    expect(snap?.compactedCount).toBeGreaterThan(0);
    expect(snap?.coveredFields).toContain('title');
  });

  it('被引用的方案（冻结 / 冲突双版）在压缩后仍然保留', () => {
    // 先制造一个冲突，让 localVersionId / remoteVersionId 被引用
    const { local, remote } = diverged({ title: 'Local v' }, { title: 'Remote v' });
    let log = mergeLogs(local, remote, A).log;
    const conflict = openConflicts(log)[0];
    // 冻结当前头版本
    log = freezePair(log, 1, A);
    const frozenHead = mainChain(log, 1).find((e) => e.kind === 'freeze')?.freezesVersionId;
    // 再堆 90 个版本触发压缩（先复制出新版本解锁）
    log = forkPair(log, 1, A);
    for (let i = 0; i < 90; i++) log = appendEdit(log, 1, A, { body: `body-${i}` }).log;
    const { log: compressed } = compressLog(log);
    const ids = new Set(compressed.entries.map((e) => e.id));
    expect(ids.has(conflict.localVersionId)).toBe(true);
    expect(ids.has(conflict.remoteVersionId)).toBe(true);
    expect(ids.has(frozenHead as string)).toBe(true);
    // 冲突仍然开着，状态仍正确
    expect(openConflicts(compressed)).toHaveLength(1);
    expect(materialize(compressed, 1)?.body).toBe('body-89');
  });
});

describe('导出守卫', () => {
  it('冲突未处理完时列出配对的冲突字段', () => {
    const { local, remote } = diverged({ title: 'L', body: 'LB' }, { title: 'R', body: 'RB' });
    const { log } = mergeLogs(local, remote, A);
    const blockers = exportBlockers(log);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].fields.sort()).toEqual(['body', 'title']);
  });
});

describe('日志校验（导入前置）', () => {
  it('合法日志可往返序列化', () => {
    const log = seedLog();
    expect(parseLog(serializeLog(log))).toEqual(log);
  });

  it('非 JSON、缺字段、基线悬空都会被拒', () => {
    expect(() => parseLog('not json')).toThrow(LogValidationError);
    expect(() => parseLog('{"entries":[]}')).toThrow(LogValidationError);
    const log = seedLog();
    const broken = {
      ...log,
      entries: [...log.entries, { ...log.entries[0], id: 'vx', baseId: 'missing', seq: 99 }],
    };
    expect(() => parseLog(JSON.stringify(broken))).toThrow(/基线/);
  });
});
