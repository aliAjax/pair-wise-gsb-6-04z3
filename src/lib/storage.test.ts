import { beforeEach, describe, expect, it } from 'vitest';
import {
  __clearStorageForTests,
  __rawForTests,
  commitLog,
  importLogFromText,
  loadLog,
  saveRemote,
  simulateTeammateEdit,
  syncWithRemote,
  ImportError,
} from './storage';
import { appendEdit, materialize, materializeAll, openConflicts, serializeLog } from './versionLog';

const { LEGACY_KEY, BACKUP_KEY, LOG_KEY, LEGACY_BACKUP_KEY } = __rawForTests.keys;

beforeEach(() => {
  __clearStorageForTests();
});

describe('旧数据迁移', () => {
  it('首次启动把旧配对迁移成基线，旧键留档后移除', () => {
    const legacy = [{ id: 7, title: 'Legacy one', heading: 'H', body: 'B', category: 'Brand', favorite: true }];
    __rawForTests.set(LEGACY_KEY, JSON.stringify(legacy));
    const log = loadLog();
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].kind).toBe('baseline');
    expect(materialize(log, 7)).toMatchObject({ title: 'Legacy one', favorite: true, exists: true });
    expect(__rawForTests.get(LEGACY_KEY)).toBeNull();
    expect(__rawForTests.get(LEGACY_BACKUP_KEY)).toBe(JSON.stringify(legacy));
  });

  it('没有旧数据时落种子基线', () => {
    const log = loadLog();
    expect(materializeAll(log).length).toBe(3);
    expect(log.entries.every((e) => e.kind === 'baseline')).toBe(true);
  });
});

describe('同步', () => {
  it('首次同步把本地日志发布到团队库', () => {
    const local = loadLog();
    const { firstSync } = syncWithRemote(local);
    expect(firstSync).toBe(true);
  });

  it('同事离线改了不同字段，回连后自动合并', () => {
    const local = loadLog();
    syncWithRemote(local); // 建立团队库
    const local2 = appendEdit(local, 1, 'Yuki Lin', { title: 'My offline title' }).log;
    const remoteEdit = appendEdit(local, 1, 'Chen Wei', { category: 'Product' }).log;
    saveRemote(remoteEdit);
    const { log, stats } = syncWithRemote(local2);
    expect(stats.conflicts).toHaveLength(0);
    expect(materialize(log, 1)).toMatchObject({ title: 'My offline title', category: 'Product' });
  });

  it('同字段两边都改 → 同步后出现冲突', () => {
    const local = loadLog();
    syncWithRemote(local);
    const local2 = appendEdit(local, 1, 'Yuki Lin', { title: 'Mine' }).log;
    const remote = appendEdit(local, 1, 'Chen Wei', { title: 'Theirs' }).log;
    saveRemote(remote);
    const { log, stats } = syncWithRemote(local2);
    expect(stats.conflicts).toHaveLength(1);
    expect(openConflicts(log)[0].field).toBe('title');
  });

  it('模拟同事编辑可写入团队库', () => {
    const local = loadLog();
    syncWithRemote(local);
    const sim = simulateTeammateEdit(local);
    expect(sim).not.toBeNull();
  });
});

describe('导入失败恢复', () => {
  it('非法文件导入失败：抛错且本地日志原样保留，不留半份记录', () => {
    const local = loadLog();
    expect(() => importLogFromText('{"bad": true', local)).toThrow(ImportError);
    expect(() => importLogFromText('{"entries": []}', local)).toThrow(ImportError);
    expect(loadLog()).toEqual(local); // 日志内容原样保留
    expect(__rawForTests.get(BACKUP_KEY)).toBeNull(); // 备份已清理
  });

  it('合法日志导入后按字段合并', () => {
    const local = loadLog();
    const incoming = appendEdit(local, 1, 'Chen Wei', { body: 'imported body' }).log;
    const { log, stats } = importLogFromText(serializeLog(incoming), local);
    expect(stats.fastForwarded).toBe(1);
    expect(materialize(log, 1)?.body).toBe('imported body');
  });

  it('导入中途崩溃留下备份时，下次启动从完整日志恢复', () => {
    const local = commitLog(appendEdit(loadLog(), 1, 'Yuki Lin', { title: 'kept' }).log).log;
    // 模拟崩溃瞬间：备份已写入，主日志写到一半损坏
    __rawForTests.set(BACKUP_KEY, serializeLog(local));
    __rawForTests.set(LOG_KEY, '{"app":"type-pairer","log":{"entries":[{"id":"broken');
    const recovered = loadLog();
    expect(recovered).toEqual(local);
    expect(__rawForTests.get(BACKUP_KEY)).toBeNull();
    expect(materialize(recovered, 1)?.title).toBe('kept');
  });
});
