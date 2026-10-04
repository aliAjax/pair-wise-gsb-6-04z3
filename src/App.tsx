import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, BookOpen, Cloud, CloudOff, Copy, Download, Grid3X3, History,
  Lock, Plus, Snowflake, Star, Trash2, Type, Upload, Wifi,
} from 'lucide-react';
import {
  allConflicts, checkExportable, conflictsOf, createPair, deletePair, duplicateFrozen,
  fieldLabel, freezePair, getPairData, headEntry, registerExport, replayPair,
  resolveConflicts, saveEdit, simulateRemoteEdit, syncWithRemote,
  type ConflictDecision,
} from './version/engine';
import { clearImportPoint, importLog, load, persist, restoreFromImportPoint } from './version/storage';
import type {
  FieldConflict, LogEntry, MergeableField, PairData, RemoteState, Store,
} from './version/types';

const fonts = ['Fraunces', 'DM Sans', 'Space Grotesk', 'Newsreader', 'IBM Plex Sans', 'Playfair Display'];

interface Toast { kind: 'ok' | 'err' | 'warn'; text: string }

export default function App() {
  const initial = useMemo(() => load('Yuki Lin'), []);
  const [store, setStore] = useState<Store>(initial.store);
  const [remote, setRemote] = useState<RemoteState>(initial.remote);
  const [selected, setSelected] = useState<number>(() => Number(Object.keys(initial.store.pairs)[0] ?? 0));
  const [online, setOnline] = useState(true);
  const [toast, setToast] = useState<Toast | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const pair = store.pairs[selected];
  const data: PairData | null = pair ? getPairData(store, selected) : null;
  // 表单草稿：只有点“保存版本”才进日志
  const [draft, setDraft] = useState<PairData | null>(data);
  useEffect(() => { if (data) setDraft(data); }, [selected, store]); // eslint-disable-line react-hooks/exhaustive-deps

  const conflicts = pair ? conflictsOf(pair) : [];
  const pendingGlobal = allConflicts(store);

  const commit = useCallback((next: Store, nextRemote: RemoteState, msg: Toast) => {
    persist(next, nextRemote);
    setStore(structuredClone(next));
    setRemote(structuredClone(nextRemote));
    setToast(msg);
  }, []);

  const flash = (t: Toast) => setToast(t);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const patchDraft = (p: Partial<PairData>) => setDraft(d => (d ? { ...d, ...p } : d));

  // ---------- 保存：作者 + 基线 + 字段改动 ----------
  const handleSave = () => {
    if (!draft) return;
    try {
      const next = structuredClone(store);
      const changes = {} as Partial<PairData>;
      (Object.keys(draft) as (keyof PairData)[]).forEach(k => {
        if (draft[k] !== getPairData(next, selected)[k]) {
          (changes as Record<string, PairData[keyof PairData]>)[k] = draft[k];
        }
      });
      saveEdit(next, selected, changes);
      if (online) syncWithRemote(next, remote);
      commit(next, remote, { kind: 'ok', text: online ? '已保存为新版本并同步到共享库' : '已离线保存为新版本，回连后合并' });
    } catch (e) {
      flash({ kind: 'err', text: (e as Error).message });
    }
  };

  // ---------- 模拟同事在共享库里改稿 ----------
  const simulateCoworker = () => {
    if (!pair) return;
    const nextRemote = structuredClone(remote);
    const suffix = ['—同事的新表达', '（共享库更新）', ' v2'][selected % 3];
    simulateRemoteEdit(nextRemote, selected, {
      title: `同事改：${getPairData(store, selected).title}${suffix}`,
      size: Math.min(76, getPairData(store, selected).size + 4),
    });
    persist(store, nextRemote);
    setRemote(nextRemote);
    flash({ kind: 'warn', text: '模拟：同事 Morgan 已在共享库改了「名称」和「字号」' });
  };

  // ---------- 回连：按字段三方合并 ----------
  const handleReconnect = () => {
    const next = structuredClone(store);
    const nextRemote = structuredClone(remote);
    const report = syncWithRemote(next, nextRemote);
    commit(next, nextRemote, {
      kind: report.conflicts.length ? 'warn' : 'ok',
      text: report.conflicts.length
        ? `回连完成：${report.conflicts.length} 个字段两边都改了，已保留两版待你拍板`
        : `回连完成：自动合并 ${report.autoMerged.length} 个，推送 ${report.pushed.length} 个，拉取 ${report.pulled.length} 个`,
    });
  };

  // ---------- 冲突解决 ----------
  const [decisions, setDecisions] = useState<Partial<Record<MergeableField, ConflictDecision>>>({});
  useEffect(() => { setDecisions({}); }, [selected, conflicts.length]);
  const handleResolve = () => {
    try {
      const next = structuredClone(store);
      resolveConflicts(next, selected, decisions);
      if (online) syncWithRemote(next, remote);
      commit(next, remote, { kind: 'ok', text: '冲突已处理，合并落定' });
    } catch (e) {
      flash({ kind: 'err', text: (e as Error).message });
    }
  };

  // ---------- 冻结 / 复制 / 删除 / 收藏 ----------
  const handleFreeze = () => {
    const next = structuredClone(store);
    freezePair(next, selected);
    commit(next, remote, { kind: 'ok', text: '方案已冻结：不能再改，只能复制成新版本' });
  };
  const handleDuplicateFrozen = () => {
    const next = structuredClone(store);
    const id = duplicateFrozen(next, selected);
    if (online) syncWithRemote(next, remote);
    commit(next, remote, { kind: 'ok', text: '已从冻结版本复制出可编辑的新版本' });
    setSelected(id);
  };
  const handleDelete = () => {
    try {
      const next = structuredClone(store);
      deletePair(next, selected);
      if (online) syncWithRemote(next, remote);
      const rest = Object.keys(next.pairs).map(Number);
      commit(next, remote, { kind: 'ok', text: '已删除' });
      setSelected(rest[0] ?? 0);
    } catch (e) {
      flash({ kind: 'err', text: (e as Error).message });
    }
  };
  const handleFav = () => {
    if (!pair || pair.frozen) return;
    const next = structuredClone(store);
    saveEdit(next, selected, { favorite: !getPairData(next, selected).favorite });
    commit(next, remote, { kind: 'ok', text: '已更新收藏' });
  };

  const createNew = () => {
    if (!newTitle.trim()) return;
    const next = structuredClone(store);
    const id = createPair(next, newTitle.trim());
    if (online) syncWithRemote(next, remote);
    commit(next, remote, { kind: 'ok', text: '新配对已建立版本日志' });
    setSelected(id);
    setNewTitle('');
    setShowAdd(false);
  };

  // ---------- 正式导出：冲突闸门 ----------
  const handleExport = () => {
    if (!data) return;
    const gate = checkExportable(store, selected);
    if (!gate.ok) {
      flash({
        kind: 'err',
        text: `导出已停住：字段 ${gate.conflicts.map(c => `「${fieldLabel(c.field)}」`).join('、')} 冲突未处理`,
      });
      return;
    }
    const next = structuredClone(store);
    registerExport(next, selected);
    const css = `/* ${data.title} · 版本 #${gate.entryId} · ${store.author} */\n.heading { font-family: '${data.headingFont}'; font-size: ${data.size}px; font-weight: ${data.weight}; letter-spacing: ${data.tracking}px; }\n.body { font-family: '${data.bodyFont}'; line-height: ${data.leading}; }`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([css], { type: 'text/css' }));
    a.download = `${data.title.replace(/\s+/g, '-').toLowerCase()}-v${gate.entryId}.css`;
    a.click();
    URL.revokeObjectURL(a.href);
    commit(next, remote, { kind: 'ok', text: `已导出版本 #${gate.entryId}（该版本受压缩保护）` });
  };

  // ---------- 完整日志导入：失败恢复，不留半份 ----------
  const handleImportFile = async (file: File) => {
    const text = await file.text();
    try {
      const result = importLog(text, structuredClone(remote));
      persist(result.store, result.remote);
      setStore(result.store);
      setRemote(result.remote);
      const first = Number(Object.keys(result.store.pairs)[0] ?? 0);
      if (!result.store.pairs[selected]) setSelected(first);
      flash({ kind: 'ok', text: '完整日志导入成功' });
    } catch (e) {
      const recovered = restoreFromImportPoint();
      if (recovered) {
        setStore(recovered.store);
        setRemote(recovered.remote);
        clearImportPoint();
      }
      flash({ kind: 'err', text: `${(e as Error).message}；已从完整日志恢复，可重试` });
    }
  };

  const handleExportLog = () => {
    const raw = JSON.stringify({
      kind: 'type-pairer-log', exportedAt: Date.now(), author: store.author,
      store: structuredClone(store),
    }, null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
    a.download = 'type-pairer-log.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const pairsList = Object.values(store.pairs).sort((a, b) => a.id - b.id);
  const entryCount = pair ? pair.entries.length : 0;

  return (
    <div className="app">
      <aside>
        <div className="brand">
          <div className="brand-mark"><Type size={18} /></div>
          <div><b>Type Pairer</b><small>VERSIONED SHARED LIBRARY</small></div>
        </div>
        <div className="nav-section">
          <span>LIBRARY</span>
          <button className="nav active"><Grid3X3 size={16} />All pairings <b>{pairsList.length}</b></button>
          <button className="nav"><Star size={16} />Favorites <b>{pairsList.filter(p => getPairData(store, p.id).favorite).length}</b></button>
        </div>
        <div className="saved">
          <div className="saved-head">
            <span>PAIRINGS</span>
            <button onClick={() => setShowAdd(true)}><Plus size={14} /></button>
          </div>
          <div className="pair-mini-list">
            {pairsList.map(p => {
              const d = getPairData(store, p.id);
              const cc = conflictsOf(p).length;
              return (
                <button key={p.id} className={`pair-mini ${selected === p.id ? 'on' : ''}`} onClick={() => setSelected(p.id)}>
                  <i className="dot" style={{ background: p.frozen ? '#9db4c9' : ['#e8b7a0', '#9fc9be', '#b4add8', '#d9c08a'][p.id % 4] }} />
                  <span>{d.title}</span>
                  {p.frozen && <Lock size={11} className="tag-ic" />}
                  {cc > 0 && <em className="conflict-badge">{cc} 冲突</em>}
                </button>
              );
            })}
          </div>
        </div>
        <div className="aside-foot">
          <button className="nav" onClick={handleExportLog}><Download size={16} />导出完整日志</button>
          <button className="nav" onClick={() => fileRef.current?.click()}><Upload size={16} />导入日志（失败自动恢复）</button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={e => {
            const f = e.target.files?.[0];
            if (f) handleImportFile(f);
            e.target.value = '';
          }} />
          <div className="profile">
            <div className="avatar">YL</div>
            <div><b>Yuki Lin</b><small>{online ? '已连接共享库' : '离线编辑中'}</small></div>
            {online ? <Cloud size={14} color="#63926d" /> : <CloudOff size={14} color="#c98d66" />}
          </div>
        </div>
      </aside>

      <main>
        <header>
          <div>
            <div className="crumb">TYPE LIBRARY / <b>PAIRING STUDIO</b></div>
            <h1>Find the right conversation.</h1>
            <p>每次保存都是带作者与基线的新版本；离线回连按字段合并，同字段冲突两版都留。</p>
          </div>
          <div className="actions">
            <button className="outline" onClick={simulateCoworker} disabled={!pair}><BookOpen size={15} />模拟同事改稿</button>
            {online
              ? <button className="outline" onClick={() => setOnline(false)}><Wifi size={15} />断开（离线）</button>
              : <button className="primary" onClick={handleReconnect}><Cloud size={15} />回连并合并</button>}
            <button className="outline" onClick={handleExport}><Download size={15} />正式导出 CSS</button>
            <button className="primary" onClick={() => setShowAdd(true)}><Plus size={16} />New pairing</button>
          </div>
        </header>

        {pendingGlobal.length > 0 && (
          <div className="conflict-banner">
            <AlertTriangle size={16} />
            <div>
              <b>有 {pendingGlobal.length} 个字段冲突待处理，正式导出已暂停。</b>
              <span>{pendingGlobal.map(c => `#${c.pairId}「${fieldLabel(c.field)}」`).join('，')}</span>
            </div>
          </div>
        )}

        {(!pair || !draft) ? (
          <div className="empty">没有选中的配对，点 New pairing 开始。</div>
        ) : (
          <div className="layout">
            <section className="studio-wide">
              <div className="studio-head">
                <div>
                  <span>PAIRING CANVAS · {entryCount} 个版本{pair.copyOf && ` · 复制自冻结方案 #${pair.copyOf.fromPairId}`}</span>
                  <h2>{getPairData(store, selected).title}</h2>
                </div>
                <div className="head-tools">
                  <button className="tool-btn" onClick={() => setShowHistory(v => !v)} title="版本日志">
                    <History size={15} />日志
                  </button>
                  <button className="tool-btn" onClick={handleFav} title="收藏">
                    <Star size={16} fill={draft.favorite ? '#e5a35e' : 'none'} color={draft.favorite ? '#e5a35e' : '#98a4a7'} />
                  </button>
                  {pair.frozen
                    ? <button className="tool-btn frozen" onClick={handleDuplicateFrozen}><Copy size={14} />复制新版</button>
                    : <button className="tool-btn" onClick={handleFreeze}><Snowflake size={14} />冻结</button>}
                </div>
              </div>

              {pair.frozen && (
                <div className="frozen-note"><Lock size={13} /> 方案已冻结，不可越权修改；点“复制新版”基于当前内容继续迭代。</div>
              )}

              {conflicts.length > 0 && (
                <ConflictPanel
                  conflicts={conflicts}
                  decisions={decisions}
                  setDecisions={setDecisions}
                  onResolve={handleResolve}
                />
              )}

              <div className="canvas">
                <div className="canvas-bar"><span>PREVIEW</span><div><button className="on">Desktop</button><button>Tablet</button><button>Mobile</button></div></div>
                <div className="preview">
                  <span className="preview-kicker">A NOTE ON TYPE</span>
                  <h3 style={{ fontFamily: draft.headingFont, fontSize: `${draft.size}px`, fontWeight: draft.weight, letterSpacing: `${draft.tracking}px`, lineHeight: 1.05 }}>{draft.heading}</h3>
                  <p style={{ fontFamily: draft.bodyFont, lineHeight: draft.leading, letterSpacing: `${draft.tracking / 2}px` }}>{draft.body}</p>
                  <div className="preview-rule" />
                  <span className="preview-meta">PAIRING 0{selected} · {draft.category.toUpperCase()}</span>
                </div>
              </div>

              <div className="controls">
                <div className="control-head">
                  <div><span>TYPE CONTROLS</span><h3>Fine tune your pairing</h3></div>
                </div>
                <div className="text-row">
                  <label>名称<input value={draft.title} disabled={pair.frozen} onChange={e => patchDraft({ title: e.target.value })} /></label>
                  <label>分类<input value={draft.category} disabled={pair.frozen} onChange={e => patchDraft({ category: e.target.value })} /></label>
                </div>
                <div className="text-row">
                  <label className="full">标题文案<input value={draft.heading} disabled={pair.frozen} onChange={e => patchDraft({ heading: e.target.value })} /></label>
                </div>
                <div className="text-row">
                  <label className="full">正文<textarea rows={2} value={draft.body} disabled={pair.frozen} onChange={e => patchDraft({ body: e.target.value })} /></label>
                </div>
                <div className="font-row">
                  <label>Heading font
                    <select value={draft.headingFont} disabled={pair.frozen} onChange={e => patchDraft({ headingFont: e.target.value })}>
                      {fonts.map(f => <option key={f}>{f}</option>)}
                    </select>
                  </label>
                  <label>Body font
                    <select value={draft.bodyFont} disabled={pair.frozen} onChange={e => patchDraft({ bodyFont: e.target.value })}>
                      {fonts.map(f => <option key={f}>{f}</option>)}
                    </select>
                  </label>
                </div>
                <div className="range-row">
                  <label>Size <b>{draft.size}px</b><input type="range" min={28} max={76} value={draft.size} disabled={pair.frozen} onChange={e => patchDraft({ size: Number(e.target.value) })} /></label>
                  <label>Weight <b>{draft.weight}</b><input type="range" min={300} max={800} step={100} value={draft.weight} disabled={pair.frozen} onChange={e => patchDraft({ weight: Number(e.target.value) })} /></label>
                </div>
                <div className="range-row">
                  <label>Line height <b>{draft.leading.toFixed(2)}</b><input type="range" min={1} max={1.8} step=".05" value={draft.leading} disabled={pair.frozen} onChange={e => patchDraft({ leading: Number(e.target.value) })} /></label>
                  <label>Letter spacing <b>{draft.tracking}px</b><input type="range" min="-1" max={3} step=".5" value={draft.tracking} disabled={pair.frozen} onChange={e => patchDraft({ tracking: Number(e.target.value) })} /></label>
                </div>
              </div>

              <div className="studio-foot">
                <button className="delete" onClick={handleDelete} disabled={pair.frozen}><Trash2 size={15} />删除配对{pair.frozen && '（冻结）'}</button>
                <button className="save" onClick={handleSave} disabled={pair.frozen || conflicts.length > 0}>
                  ✓ 保存为新版本{conflicts.length > 0 ? '（先处理冲突）' : online ? '' : ' · 离线'}
                </button>
              </div>
            </section>

            {showHistory && <HistoryPanel pair={pair} store={store} />}
          </div>
        )}
      </main>

      {showAdd && (
        <div className="backdrop" onClick={() => setShowAdd(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>New pairing</h2>
            <label>Pairing name
              <input autoFocus value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="e.g. Quiet confidence" />
            </label>
            <div className="modal-actions">
              <button className="outline" onClick={() => setShowAdd(false)}>Cancel</button>
              <button className="primary" onClick={createNew}>Create pairing</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}

// ---------- 冲突面板：同一字段两版并存 ----------
function ConflictPanel({
  conflicts, decisions, setDecisions, onResolve,
}: {
  conflicts: FieldConflict[];
  decisions: Partial<Record<MergeableField, ConflictDecision>>;
  setDecisions: (d: Partial<Record<MergeableField, ConflictDecision>>) => void;
  onResolve: () => void;
}) {
  const done = conflicts.every(c => decisions[c.field]);
  return (
    <div className="conflict-panel">
      <div className="conflict-head">
        <AlertTriangle size={15} />
        <b>字段冲突：两边都改了同一字段，两版都在这里，请逐字段拍板</b>
      </div>
      {conflicts.map(c => {
        const d = decisions[c.field];
        return (
          <div key={c.field} className="conflict-row">
            <div className="conflict-field">{fieldLabel(c.field)} <small>基线：{String(c.base)}</small></div>
            <button className={`choice ${d?.resolution === 'local' ? 'pick' : ''}`} onClick={() => setDecisions({ ...decisions, [c.field]: { resolution: 'local' } })}>
              <span className="who">你的版本</span><span className="val">{String(c.local)}</span>
            </button>
            <button className={`choice ${d?.resolution === 'remote' ? 'pick' : ''}`} onClick={() => setDecisions({ ...decisions, [c.field]: { resolution: 'remote' } })}>
              <span className="who">同事版本</span><span className="val">{String(c.remote)}</span>
            </button>
            {d?.resolution === 'custom' && (
              <input className="custom-val" autoFocus defaultValue={String(c.customValue ?? '')}
                onChange={e => setDecisions({ ...decisions, [c.field]: { resolution: 'custom', value: e.target.value } })} />
            )}
            <button className={`choice ghost ${d?.resolution === 'custom' ? 'pick' : ''}`}
              onClick={() => setDecisions({ ...decisions, [c.field]: { resolution: 'custom', value: c.customValue ?? '' } })}>
              自定义…
            </button>
          </div>
        );
      })}
      <button className="resolve-btn" disabled={!done} onClick={onResolve}>
        {done ? '全部选定，落定合并' : `还剩 ${conflicts.filter(c => !decisions[c.field]).length} 个字段未选`}
      </button>
    </div>
  );
}

// ---------- 版本日志面板 ----------
function HistoryPanel({ pair, store }: { pair: NonNullable<Store['pairs'][number]>; store: Store }) {
  const { chain } = replayPair(pair);
  const exportEntryIds = new Set(store.exports.filter(e => e.pairId === pair.id).map(e => e.entryId));
  return (
    <aside className="history-panel">
      <div className="history-head"><History size={14} />版本日志（{chain.length}）</div>
      <div className="log-list">
        {[...chain].reverse().map((e: LogEntry) => (
          <div key={e.id} className={`log-item ${e.kind}`}>
            <div className="log-top">
              <i className={`kind kind-${e.kind}`}>{e.kind === 'snapshot' ? '基线' : e.kind === 'edit' ? '保存' : '合并'}</i>
              {exportEntryIds.has(e.id) && <em className="ex-tag">已导出</em>}
              {e.kind === 'edit' && e.resolves && <em className="ex-tag resolve">解决冲突</em>}
            </div>
            <b>#{e.id} · {e.author}</b>
            {e.kind === 'snapshot' && <small>{e.migrated ? '旧数据迁移的基线' : '快照基线'}{pair.frozen ? '（冻结源）' : ''}</small>}
            {e.kind === 'edit' && <small>改了 {Object.keys(e.changes).map(k => fieldLabel(k as MergeableField)).join('、') || '—'}</small>}
            {e.kind === 'merge' && (
              <small>
                自动合并 {Object.keys(e.changes).length} 字段
                {e.conflicts.length > 0 && (e.resolved ? `；冲突已解决（${e.conflicts.map(c => fieldLabel(c.field)).join('、')}）` : `；${e.conflicts.map(c => fieldLabel(c.field)).join('、')} 待处理`) }
              </small>
            )}
            <time>{new Date(Math.floor(e.ts / 1000)).toLocaleString('zh-CN', { hour12: false })}</time>
          </div>
        ))}
      </div>
      <div className="history-foot">末端版本 #{headEntry(pair).id}{pair.lastSyncedEntryId ? ` · 已同步至 #${pair.lastSyncedEntryId}` : ' · 未同步'}</div>
    </aside>
  );
}
