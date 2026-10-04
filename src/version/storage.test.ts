import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearBackup, clearImportPoint, importLog, persist, restoreFromBackup,
  restoreFromImportPoint,
} from './storage';
import { createStoreWithSeed, saveEdit, serializeLog } from './engine';

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
  };
}

test('正常写入自动留存上一份完整日志备份', () => {
  (globalThis as { localStorage?: Storage }).localStorage = memStorage();
  const { store, remote } = createStoreWithSeed('Yuki');
  persist(store, remote);
  saveEdit(store, 1, { title: '第二版' });
  persist(store, remote);
  const recovered = restoreFromBackup();
  assert.ok(recovered);
  // 备份里是“上一份”（第一版），不是刚写入的第二版
  const backup = JSON.parse(localStorage.getItem('type-pairer-backup-v1')!) as { store: string };
  assert.ok(backup.store.includes('Editorial calm'));
  assert.ok(!backup.store.includes('第二版'));
});

test('导入坏日志：存储纹丝不动，不留半份记录', () => {
  (globalThis as { localStorage?: Storage }).localStorage = memStorage();
  const { store, remote } = createStoreWithSeed('Yuki');
  persist(store, remote);
  const before = localStorage.getItem('type-pairer-store-v1');
  assert.throws(() => importLog('{not json', remote), /导入失败|日志文件/);
  assert.equal(localStorage.getItem('type-pairer-store-v1'), before);

  const validButBroken = JSON.stringify({ kind: 'type-pairer-log', store: { nope: true } });
  assert.throws(() => importLog(validButBroken, remote), /日志文件/);
  assert.equal(localStorage.getItem('type-pairer-store-v1'), before);
});

test('导入成功后是完整日志；备份恢复可回到导入前', () => {
  (globalThis as { localStorage?: Storage }).localStorage = memStorage();
  const { store, remote } = createStoreWithSeed('Yuki');
  persist(store, remote);

  const other = createStoreWithSeed('Morgan');
  saveEdit(other.store, 2, { title: '同事库里的新名字' });
  const text = serializeLog(other.store);
  const result = importLog(text, remote);
  assert.ok(result.store.pairs[2]);

  // 导入恢复点回到“导入前”，不受普通滚动备份影响
  const recovered = restoreFromImportPoint();
  assert.ok(recovered);
  assert.ok(!JSON.stringify(recovered!.store).includes('同事库里的新名字'));
  clearImportPoint();
  assert.equal(localStorage.getItem('type-pairer-import-backup-v1'), null);
});
