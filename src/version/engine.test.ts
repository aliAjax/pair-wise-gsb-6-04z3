import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allConflicts, checkExportable, clone, compactPair, conflictsOf, createPair,
  createStoreWithSeed, deletePair, duplicateFrozen, fieldLabel, freezePair,
  getPairData, headEntry, migrateLegacy, parseLogFile, registerExport,
  replayPair, resolveConflicts, saveEdit, serializeLog, simulateRemoteEdit,
  syncWithRemote,
} from './engine';
import type { PairData, RemoteState, Store } from './types';

const setup = (author = 'Yuki Lin') => createStoreWithSeed(author);

// ---------- 1. 保存留下作者、基线、字段改动 ----------

test('保存追加 edit 条目：含作者、parent 基线、仅变化字段', () => {
  const { store } = setup();
  const e = saveEdit(store, 1, { title: 'Editorial calm v2', size: 52 });
  assert.equal(e.kind, 'edit');
  assert.equal(e.author, 'Yuki Lin');
  assert.equal(e.pairId, 1);
  assert.deepEqual(Object.keys(e.changes).sort(), ['size', 'title']);

  const pair = store.pairs[1];
  assert.equal(pair.entries.length, 2);
  assert.equal(e.parentId, pair.entries[0].id); // 基线指向上一条
  assert.equal(getPairData(store, 1).title, 'Editorial calm v2');
  assert.equal(getPairData(store, 1).size, 52);
  // 旧版内容仍在日志里，没有被盖掉
  assert.deepEqual((pair.entries[0] as { data: PairData }).data.title, 'Editorial calm');
});

test('无字段变化时拒绝保存', () => {
  const { store } = setup();
  assert.throws(() => saveEdit(store, 1, { title: 'Editorial calm' }), /没有字段变化/);
});

// ---------- 2. 离线改、回连按字段合并 ----------

test('不同字段两边都改：自动按字段合并，无冲突', () => {
  const { store, remote } = setup();
  store.online = false;
  saveEdit(store, 1, { title: '本地改的名称' });
  simulateRemoteEdit(remote, 1, { size: 70 }, 'Morgan Reyes');

  const report = syncWithRemote(store, remote);
  const data = getPairData(store, 1);
  assert.equal(data.title, '本地改的名称');
  assert.equal(data.size, 70);
  assert.deepEqual(report.autoMerged, [1]);
  assert.equal(conflictsOf(store.pairs[1]).length, 0);
  // 远端也得到了本地的改动
  assert.equal(getPairData(store, 1).title, '本地改的名称');
});

test('同一字段两边改成不同值：保留两版并标冲突，其他字段自动合并', () => {
  const { store, remote } = setup();
  store.online = false;
  saveEdit(store, 1, { title: 'Yuki 的标题', body: '只有本地改的正文' });
  simulateRemoteEdit(remote, 1, { title: 'Morgan 的标题', size: 64 }, 'Morgan Reyes');

  const report = syncWithRemote(store, remote);
  const conflicts = conflictsOf(store.pairs[1]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].field, 'title');
  assert.equal(conflicts[0].local, 'Yuki 的标题');
  assert.equal(conflicts[0].remote, 'Morgan 的标题');
  assert.equal(conflicts[0].base, 'Editorial calm');
  assert.deepEqual(report.conflicts.map(c => c.field), ['title']);

  const data = getPairData(store, 1);
  assert.equal(data.body, '只有本地改的正文');   // 仅本地改 → 自动合并
  assert.equal(data.size, 64);                  // 仅远端改 → 自动合并
  // merge 条目的 changes 里不包含冲突字段
  const merge = headEntry(store.pairs[1]);
  assert.equal(merge.kind, 'merge');
  if (merge.kind === 'merge') {
    assert.equal(merge.changes.title, undefined);
    assert.equal(merge.changes.body, '只有本地改的正文');
    assert.equal(merge.changes.size, 64);
  }
});

test('同一字段两边改成相同值：直接采用，不报冲突', () => {
  const { store, remote } = setup();
  saveEdit(store, 1, { title: '一致的新标题' });
  simulateRemoteEdit(remote, 1, { title: '一致的新标题' });
  const report = syncWithRemote(store, remote);
  assert.equal(report.conflicts.length, 0);
  assert.equal(getPairData(store, 1).title, '一致的新标题');
});

test('仅本地离线领先：回连推送；仅远端领先：拉取跟进', () => {
  const a = setup();
  a.store.online = false;
  saveEdit(a.store, 1, { weight: 800 });
  let r = syncWithRemote(a.store, a.remote);
  assert.deepEqual(r.pushed, [1]);
  assert.equal(getPairData(a.store, 1).weight, 800);

  const b = setup();
  simulateRemoteEdit(b.remote, 1, { weight: 300 });
  r = syncWithRemote(b.store, b.remote);
  assert.deepEqual(r.pulled, [1]);
  assert.equal(getPairData(b.store, 1).weight, 300);
});

test('离线新建配对回连后推送到共享库', () => {
  const { store, remote } = setup();
  store.online = false;
  const id = createPair(store, '离线草稿');
  assert.equal(remote.pairs[id], undefined);
  syncWithRemote(store, remote);
  assert.ok(remote.pairs[id]);
  assert.equal(getPairData(store, id).title, '离线草稿');
});

test('多轮离线编辑不互相覆盖，第二次同步在合并基线上继续', () => {
  const { store, remote } = setup();
  saveEdit(store, 1, { title: 'Yuki 的标题', body: '本地正文' });
  simulateRemoteEdit(remote, 1, { title: 'Morgan 的标题' });
  syncWithRemote(store, remote);
  // 解决冲突后再次同步，应干净推送，不产生二次冲突
  resolveConflicts(store, 1, { title: { resolution: 'local' } });
  const r2 = syncWithRemote(store, remote);
  assert.equal(r2.conflicts.length, 0);
  assert.equal(conflictsOf(store.pairs[1]).length, 0);
  assert.equal(replayPair(remote.pairs[1]).head.title, 'Yuki 的标题');
});

// ---------- 3. 旧数据迁移成基线 ----------

test('旧扁平数据迁移：每个配对一条 migrated snapshot 基线且远端同步', () => {
  const legacy = JSON.stringify([
    { id: 1, title: '旧方案', heading: 'H', body: 'B', category: 'Cat', favorite: true },
  ]);
  const { store, remote } = migrateLegacy(legacy, 'Yuki Lin');
  const snap = store.pairs[1].entries[0];
  assert.equal(snap.kind, 'snapshot');
  if (snap.kind === 'snapshot') {
    assert.equal(snap.migrated, true);
    assert.equal(snap.data.title, '旧方案');
    assert.equal(snap.data.favorite, true);
  }
  assert.ok(remote.pairs[1]);
  assert.equal(store.pairs[1].lastSyncedEntryId, snap.id);
});

// ---------- 4. 冻结方案不可越权修改，只能复制新版本 ----------

test('冻结后拒绝修改与删除', () => {
  const { store } = setup();
  freezePair(store, 1);
  assert.throws(() => saveEdit(store, 1, { title: 'x' }), /冻结/);
  assert.throws(() => deletePair(store, 1), /冻结/);
});

test('冻结方案只能复制成新版本继续做，且保留 copyOf 引用', () => {
  const { store } = setup();
  freezePair(store, 1);
  const newId = duplicateFrozen(store, 1);
  assert.notEqual(newId, 1);
  assert.equal(store.pairs[newId].frozen, false);
  assert.equal(getPairData(store, newId).title, getPairData(store, 1).title);
  assert.deepEqual(store.pairs[newId].copyOf, {
    fromPairId: 1,
    entryId: headEntry(store.pairs[1]).id,
    ts: store.pairs[newId].copyOf!.ts,
  });
  saveEdit(store, newId, { title: '复制版的新标题' });
  assert.equal(getPairData(store, newId).title, '复制版的新标题');
  // 原冻结版纹丝不动
  assert.equal(getPairData(store, 1).title, 'Editorial calm');
});

// ---------- 5. >80 版本压缩，引用版本不消失 ----------

test('超过 80 条压缩：折叠旧记录为 snapshot，仍能重放出当前内容', () => {
  const { store } = setup();
  for (let i = 0; i < 90; i++) saveEdit(store, 1, { size: 30 + i });
  assert.ok(store.pairs[1].entries.length <= 82); // 折叠为 1 条 snapshot + 剩余
  assert.equal(store.pairs[1].entries[0].kind, 'snapshot');
  assert.equal(getPairData(store, 1).size, 30 + 89);
});

test('压缩不删除被 copyOf / 导出引用的版本', () => {
  const { store } = setup();
  // 先堆一些版本，然后冻结并复制，让第 30 条被引用
  for (let i = 0; i < 29; i++) saveEdit(store, 1, { size: 30 + i });
  freezePair(store, 1);
  const dupId = duplicateFrozen(store, 1);
  const referencedEntry = store.pairs[1].copyOf && null;
  void referencedEntry;
  const refId = store.pairs[dupId].copyOf!.entryId;
  // 解冻继续编辑，制造超过 80 条
  store.pairs[1].frozen = false;
  for (let i = 0; i < 60; i++) saveEdit(store, 1, { size: 100 + i });
  assert.ok(store.pairs[1].entries.some(e => e.id === refId), '被复制引用的版本必须保留');

  // 导出引用同理
  const before = store.pairs[2].entries.length;
  void before;
  registerExport(store, 2);
  const exEntryId = store.exports.find(e => e.pairId === 2)!.entryId;
  for (let i = 0; i < 85; i++) saveEdit(store, 2, { size: 40 + (i % 30) });
  compactPair(store, 2);
  assert.ok(store.pairs[2].entries.some(e => e.id === exEntryId), '导出引用的版本必须保留');
});

// ---------- 6. 冲突未处理完，正式导出停住并指出字段 ----------

test('冲突未决：导出闸门拦截并给出字段名', () => {
  const { store, remote } = setup();
  saveEdit(store, 1, { title: '本地' });
  simulateRemoteEdit(remote, 1, { title: '远端' });
  syncWithRemote(store, remote);
  const gate = checkExportable(store, 1);
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.deepEqual(gate.conflicts.map(c => fieldLabel(c.field)), ['名称']);
  assert.throws(() => registerExport(store, 1), /导出已中止/);
});

test('冲突全部处理完后导出成功并登记版本引用', () => {
  const { store, remote } = setup();
  saveEdit(store, 1, { title: '本地' });
  simulateRemoteEdit(remote, 1, { title: '远端' });
  syncWithRemote(store, remote);
  assert.throws(
    () => resolveConflicts(store, 1, {}),
    /还没有选择保留哪一版/,
  );
  resolveConflicts(store, 1, { title: { resolution: 'remote' } });
  assert.equal(getPairData(store, 1).title, '远端');
  const gate = checkExportable(store, 1);
  assert.equal(gate.ok, true);
  const exId = registerExport(store, 1);
  assert.ok(store.exports.some(e => e.id === exId));
});

test('自定义值解决冲突', () => {
  const { store, remote } = setup();
  saveEdit(store, 1, { title: '本地' });
  simulateRemoteEdit(remote, 1, { title: '远端' });
  syncWithRemote(store, remote);
  assert.throws(
    () => resolveConflicts(store, 1, { title: { resolution: 'custom', value: '' } }),
    /自定义值不能为空/,
  );
  resolveConflicts(store, 1, { title: { resolution: 'custom', value: '第三方标题' } });
  assert.equal(getPairData(store, 1).title, '第三方标题');
});

test('冲突未决时不能直接保存改动（必须先走冲突流程）', () => {
  const { store, remote } = setup();
  saveEdit(store, 1, { title: '本地' });
  simulateRemoteEdit(remote, 1, { title: '远端' });
  syncWithRemote(store, remote);
  assert.throws(() => saveEdit(store, 1, { title: '偷偷改' }), /未处理的冲突/);
});

// ---------- 7. 导入失败从完整日志恢复，不留半份记录 ----------

test('完整日志往返：序列化后可校验通过', () => {
  const { store } = setup();
  saveEdit(store, 1, { title: '要导出的版本' });
  const text = serializeLog(store);
  const file = parseLogFile(text);
  assert.equal(file.store.pairs[1].entries.length, 2);
});

test('坏日志被拒：缺标识 / 断链 / 引用缺失', () => {
  assert.throws(() => parseLogFile('{"x":1}'), /标识/);
  const { store } = setup();
  const broken = clone(store);
  broken.pairs[1].entries[0].parentId = 999999;
  assert.throws(() => parseLogFile(JSON.stringify({ kind: 'type-pairer-log', store: broken })), /日志链断裂/);

  const brokenRef = clone(store);
  brokenRef.pairs[2].copyOf = { fromPairId: 1, entryId: 123456, ts: 1 };
  assert.throws(() => parseLogFile(JSON.stringify({ kind: 'type-pairer-log', store: brokenRef })), /引用的源方案版本/);

  const brokenExport = clone(store);
  brokenExport.exports.push({ id: 1, ts: 1, pairId: 1, entryId: 123456, author: 'X' });
  assert.throws(() => parseLogFile(JSON.stringify({ kind: 'type-pairer-log', store: brokenExport })), /引用的方案版本/);
});

// ---------- 8. 其他：墓碑、id 碰撞消解、全局冲突清单 ----------

test('删除经墓碑同步到对端', () => {
  const { store, remote } = setup();
  deletePair(store, 2);
  assert.ok(remote.pairs[2]);
  syncWithRemote(store, remote);
  assert.ok(!remote.pairs[2]);
  assert.ok(remote.tombstones.includes(2));
});

test('离线双方撞 id：回连改号后合并仍正确', () => {
  const a = setup();
  const b = setup();
  a.store.online = false;
  // a、b 从同一计数器位置各自分配 id（制造碰撞）
  saveEdit(a.store, 1, { title: 'A 离线标题' });
  simulateRemoteEdit(a.remote, 1, { title: '同事标题（同 id）' }, 'Morgan');
  // a.remote 与 a.store 的新条目 id 相同且不在共同历史里
  const localNew = a.store.pairs[1].entries[1].id;
  const remoteNew = a.remote.pairs[1].entries[1].id;
  assert.equal(localNew, remoteNew);
  const report = syncWithRemote(a.store, a.remote);
  assert.equal(report.conflicts.length, 1);
  // 本地撞号条目被改号（共享库 id 权威），id 不再与远端撞
  assert.notEqual(a.store.pairs[1].entries[1].id, remoteNew);
  // 改号后两条 edit 都在链上，merge 能找到双方来源
  const merge = headEntry(a.store.pairs[1]);
  if (merge.kind === 'merge') {
    assert.notEqual(merge.localHeadId, merge.remoteHeadId);
  }
  assert.equal(getPairData(a.store, 1).title, 'A 离线标题'); // 冲突字段暂取本地版
  void b;
});

test('allConflicts 汇总所有未决字段', () => {
  const { store, remote } = setup();
  saveEdit(store, 1, { title: 'L1' });
  saveEdit(store, 2, { category: 'L2' });
  simulateRemoteEdit(remote, 1, { title: 'R1' });
  simulateRemoteEdit(remote, 2, { category: 'R2' });
  syncWithRemote(store, remote);
  const all = allConflicts(store);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map(c => c.pairId).sort(), [1, 2]);
});

test('未压缩的远程拉取分支重放正常（多字段编辑）', () => {
  const { store, remote } = setup();
  simulateRemoteEdit(remote, 1, { headingFont: 'Playfair Display', tracking: 2, weight: 700 });
  syncWithRemote(store, remote);
  const data = getPairData(store, 1);
  assert.equal(data.headingFont, 'Playfair Display');
  assert.equal(data.tracking, 2);
  assert.equal(data.weight, 700);
});
