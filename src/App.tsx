import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  ChevronDown,
  Copy,
  Download,
  Grid3X3,
  Heart,
  History,
  Lock,
  Plus,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
  Star,
  Trash2,
  Type,
} from 'lucide-react';
import HistoryDrawer from './components/HistoryDrawer';
import ConflictPanel from './components/ConflictPanel';
import {
  appendEdit,
  createPair,
  deletePair,
  exportBlockers,
  FIELD_LABELS,
  forkPair,
  freezePair,
  FrozenError,
  isFrozen,
  mainChain,
  materializeAll,
  openConflicts,
  resolveConflict,
  MAX_VERSIONS_PER_PAIR,
  type ExportBlocker,
  type PairState,
  type VersionLog,
} from './lib/versionLog';
import {
  commitLog,
  CURRENT_AUTHOR,
  exportLogText,
  importLogFromText,
  loadLog,
  simulateTeammateEdit,
  syncWithRemote,
} from './lib/storage';

const fonts = ['Fraunces', 'DM Sans', 'Space Grotesk', 'Newsreader', 'IBM Plex Sans', 'Playfair Display'];

type Toast = { text: string; kind: 'ok' | 'err' } | null;

function download(filename: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function App() {
  const [log, setLog] = useState<VersionLog>(() => loadLog());
  const [selected, setSelected] = useState<number | null>(null);
  const [headingFont, setHeadingFont] = useState('Fraunces');
  const [bodyFont, setBodyFont] = useState('DM Sans');
  const [size, setSize] = useState(46);
  const [weight, setWeight] = useState(600);
  const [leading, setLeading] = useState(1.25);
  const [tracking, setTracking] = useState(0);
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [showConflicts, setShowConflicts] = useState(false);
  const [exportBlocks, setExportBlocks] = useState<ExportBlocker[] | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pairs = materializeAll(log);
  const current = pairs.find((p) => p.id === selected) ?? pairs[0] ?? null;
  const frozen = current ? isFrozen(log, current.id) : false;
  const versionCount = current ? mainChain(log, current.id).length : 0;
  const conflictCount = openConflicts(log).length;

  useEffect(() => {
    if (current && selected !== current.id) setSelected(current.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  const notify = (text: string, kind: 'ok' | 'err' = 'ok') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, kind });
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  };

  /** 统一落库入口：写入 + 超量压缩（被引用方案保留） */
  const applyLog = (next: VersionLog, notice?: string) => {
    const committed = commitLog(next);
    setLog(committed.log);
    if (committed.compressedAway > 0)
      notify(`版本超过 ${MAX_VERSIONS_PER_PAIR} 个，已压缩 ${committed.compressedAway} 条旧记录（被引用方案已保留）`);
    else if (notice) notify(notice);
  };

  const guardFrozen = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      if (e instanceof FrozenError) notify('方案已冻结，不能直接修改，只能复制新版本', 'err');
      else throw e;
    }
  };

  const create = () => {
    if (!newTitle.trim()) return;
    const { log: next, pairId } = createPair(log, CURRENT_AUTHOR, newTitle.trim());
    applyLog(next);
    setSelected(pairId);
    setNewTitle('');
    setShowAdd(false);
  };

  const saveFields = (updates: Partial<PairState>, notice?: string) =>
    guardFrozen(() => {
      if (!current) return;
      const { log: next, changed } = appendEdit(log, current.id, CURRENT_AUTHOR, updates);
      if (changed.length === 0) return;
      applyLog(next, notice ?? `已保存：${changed.map((f) => FIELD_LABELS[f]).join('、')}（作者 ${CURRENT_AUTHOR}）`);
    });

  const toggleFav = () => current && saveFields({ favorite: !current.favorite });

  const handleDelete = () => {
    if (!current) return;
    if (!window.confirm(`删除配对「${current.title}」？删除会作为字段改动记入版本日志。`)) return;
    guardFrozen(() => applyLog(deletePair(log, current.id, CURRENT_AUTHOR), '已删除（日志中可溯源）'));
  };

  const handleFreeze = () => current && applyLog(freezePair(log, current.id, CURRENT_AUTHOR), '方案已冻结，之后只能复制新版本');
  const handleFork = () => current && applyLog(forkPair(log, current.id, CURRENT_AUTHOR), '已从冻结方案复制新版本，可以继续编辑');

  const handleSync = () => {
    const { log: merged, stats, firstSync } = syncWithRemote(log);
    applyLog(merged);
    if (firstSync) notify('已连接团队库，本地版本已发布');
    else if (stats.conflicts.length > 0) {
      notify(`同步完成：${stats.conflicts.length} 个字段两边都改过，已各留一版待处理`, 'err');
      setShowConflicts(true);
    } else
      notify(`同步完成：自动合并 ${stats.autoMergedFields} 个字段，新增 ${stats.addedPairs} 个配对，快进 ${stats.fastForwarded} 个`);
  };

  const handleImport = async (file: File) => {
    try {
      const text = await file.text();
      const { log: merged, stats } = importLogFromText(text, log);
      applyLog(merged);
      notify(
        `导入完成：新增 ${stats.addedPairs} 个配对，自动合并 ${stats.autoMergedFields} 个字段` +
          (stats.conflicts.length ? `，${stats.conflicts.length} 个冲突待处理` : ''),
      );
      if (stats.conflicts.length) setShowConflicts(true);
    } catch (e) {
      notify(`导入失败：${e instanceof Error ? e.message : '未知错误'}。已从完整日志恢复，可修正后重试`, 'err');
    }
  };

  const handleSimulate = () => {
    const sim = simulateTeammateEdit(log);
    if (!sim) notify('团队库暂无可编辑的配对', 'err');
    else notify(`同事 ${sim.author} 离线改了「${sim.pairTitle}」的${FIELD_LABELS[sim.field]}，点「同步团队库」合并`);
  };

  /** 正式导出：冲突未处理完则停住并说明字段 */
  const exportCss = () => {
    if (!current) return;
    const blockers = exportBlockers(log);
    if (blockers.length > 0) {
      setExportBlocks(blockers);
      return;
    }
    const css = `/* ${current.title} */\n.heading { font-family: '${headingFont}'; font-size: ${size}px; font-weight: ${weight}; }\n.body { font-family: '${bodyFont}'; line-height: ${leading}; letter-spacing: ${tracking}px; }`;
    download('type-pair.css', css, 'text/css');
    notify('已导出 CSS');
  };

  return (
    <div className="app">
      <aside>
        <div className="brand">
          <div className="brand-mark">
            <Type size={18} />
          </div>
          <div>
            <b>Type Pairer</b>
            <small>FIND YOUR VOICE</small>
          </div>
        </div>
        <div className="nav-section">
          <span>LIBRARY</span>
          <button className="nav active">
            <Grid3X3 size={16} />
            All pairings <b>{pairs.length}</b>
          </button>
          <button className="nav">
            <Heart size={16} />
            Favorites <b>{pairs.filter((p) => p.favorite).length}</b>
          </button>
          <button className="nav" onClick={() => setShowHistory(true)}>
            <History size={16} />
            Version log <b>{log.entries.length}</b>
          </button>
        </div>
        <div className="saved">
          <div className="saved-head">
            <span>COLLECTIONS</span>
            <button onClick={() => setShowAdd(true)}>
              <Plus size={14} />
            </button>
          </div>
          <button className="collection">
            <i style={{ background: '#e8b7a0' }} />
            Editorial <b>{pairs.filter((p) => p.category === 'Editorial').length}</b>
          </button>
          <button className="collection">
            <i style={{ background: '#9fc9be' }} />
            Portfolio <b>{pairs.filter((p) => p.category === 'Portfolio').length}</b>
          </button>
          <button className="collection">
            <i style={{ background: '#b4add8' }} />
            Brand voice <b>{pairs.filter((p) => p.category === 'Brand').length}</b>
          </button>
        </div>
        <div className="aside-foot">
          <button className="nav">
            <Settings2 size={16} />
            Preferences
          </button>
          <div className="profile">
            <div className="avatar">YL</div>
            <div>
              <b>{CURRENT_AUTHOR}</b>
              <small>Design workspace</small>
            </div>
            <ChevronDown size={14} />
          </div>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <div className="crumb">
              TYPE LIBRARY / <b>PAIRING STUDIO</b>
            </div>
            <h1>Find the right conversation.</h1>
            <p>Explore combinations, tune the details, and save what feels like you.</p>
          </div>
          <div className="actions">
            {conflictCount > 0 && (
              <button className="outline warn" onClick={() => setShowConflicts(true)}>
                <AlertTriangle size={15} />
                {conflictCount} 个冲突
              </button>
            )}
            <button className="outline" onClick={handleSync}>
              <RefreshCw size={15} />
              同步团队库
            </button>
            <button className="outline" onClick={exportCss}>
              <Download size={15} />
              导出 CSS
            </button>
            <button className="primary" onClick={() => setShowAdd(true)}>
              <Plus size={16} />
              New pairing
            </button>
          </div>
        </header>
        <div className="layout">
          <section className="gallery">
            <div className="gallery-head">
              <div>
                <h2>Saved pairings</h2>
                <span>{pairs.length} compositions</span>
              </div>
              <div className="view-toggle">
                <button className="on">
                  <Grid3X3 size={14} />
                </button>
                <button>
                  <BookOpen size={14} />
                </button>
              </div>
            </div>
            <div className="pair-list">
              {pairs.map((p) => (
                <button
                  key={p.id}
                  className={current?.id === p.id ? 'pair selected' : 'pair'}
                  onClick={() => setSelected(p.id)}
                >
                  <div className="pair-top">
                    <span>
                      {p.category}
                      {isFrozen(log, p.id) && <Lock size={10} className="lock-inline" />}
                    </span>
                    <Heart size={15} fill={p.favorite ? '#e88769' : 'none'} color={p.favorite ? '#e88769' : '#aeb5b7'} />
                  </div>
                  <strong style={{ fontFamily: p.id === 1 ? 'Fraunces' : 'Georgia' }}>{p.heading}</strong>
                  <p style={{ fontFamily: p.id === 1 ? 'DM Sans' : 'Arial' }}>{p.body}</p>
                  <div className="pair-foot">
                    <span>{p.title}</span>
                    <small>Open canvas →</small>
                  </div>
                </button>
              ))}
            </div>
          </section>
          {current && (
            <section className="studio">
              <div className="studio-head">
                <div>
                  <span>PAIRING CANVAS</span>
                  <h2>{current.title}</h2>
                  <small className="version-meta">
                    {versionCount} 个版本 · {frozen ? '已冻结' : '可编辑'}
                  </small>
                </div>
                <div className="studio-actions">
                  <button className="favorite" onClick={() => setShowHistory(true)} title="版本历史">
                    <History size={16} color="#98a4a7" />
                  </button>
                  {frozen ? (
                    <button className="favorite" onClick={handleFork} title="复制新版本">
                      <Copy size={16} color="#8d6042" />
                    </button>
                  ) : (
                    <button className="favorite" onClick={handleFreeze} title="冻结方案">
                      <Lock size={16} color="#98a4a7" />
                    </button>
                  )}
                  <button className="favorite" onClick={toggleFav} disabled={frozen}>
                    <Star size={16} fill={current.favorite ? '#e5a35e' : 'none'} color={current.favorite ? '#e5a35e' : '#98a4a7'} />
                  </button>
                </div>
              </div>
              {frozen && (
                <div className="frozen-banner">
                  <Lock size={14} /> 此方案已冻结，不可直接修改。
                  <button onClick={handleFork}>复制新版本</button>
                </div>
              )}
              <div className="canvas">
                <div className="canvas-bar">
                  <span>PREVIEW</span>
                  <div>
                    <button>Desktop</button>
                    <button>Tablet</button>
                    <button>Mobile</button>
                  </div>
                </div>
                <div className="preview">
                  <span className="preview-kicker">A NOTE ON TYPE</span>
                  <h3
                    style={{
                      fontFamily: headingFont,
                      fontSize: `${size}px`,
                      fontWeight: weight,
                      letterSpacing: `${tracking}px`,
                      lineHeight: 1.05,
                    }}
                  >
                    {current.heading}
                  </h3>
                  <p style={{ fontFamily: bodyFont, lineHeight: leading, letterSpacing: `${tracking / 2}px` }}>{current.body}</p>
                  <div className="preview-rule" />
                  <span className="preview-meta">
                    PAIRING #{String(current.id).slice(-6)} · {current.category.toUpperCase()}
                  </span>
                </div>
              </div>
              <PairEditor
                key={`${current.id}:${log.heads[current.id]}`}
                pair={current}
                disabled={frozen}
                onSave={(updates) => saveFields(updates)}
              />
              <div className="controls">
                <div className="control-head">
                  <div>
                    <span>TYPE CONTROLS</span>
                    <h3>Fine tune your pairing</h3>
                  </div>
                  <SlidersHorizontal size={17} />
                </div>
                <div className="font-row">
                  <label>
                    Heading font
                    <select value={headingFont} onChange={(e) => setHeadingFont(e.target.value)}>
                      {fonts.map((f) => (
                        <option key={f}>{f}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Body font
                    <select value={bodyFont} onChange={(e) => setBodyFont(e.target.value)}>
                      {fonts.map((f) => (
                        <option key={f}>{f}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="range-row">
                  <label>
                    Size <b>{size}px</b>
                    <input type="range" min="28" max="76" value={size} onChange={(e) => setSize(Number(e.target.value))} />
                  </label>
                  <label>
                    Weight <b>{weight}</b>
                    <input
                      type="range"
                      min="300"
                      max="800"
                      step="100"
                      value={weight}
                      onChange={(e) => setWeight(Number(e.target.value))}
                    />
                  </label>
                </div>
                <div className="range-row">
                  <label>
                    Line height <b>{leading.toFixed(2)}</b>
                    <input
                      type="range"
                      min="1"
                      max="1.8"
                      step=".05"
                      value={leading}
                      onChange={(e) => setLeading(Number(e.target.value))}
                    />
                  </label>
                  <label>
                    Letter spacing <b>{tracking}px</b>
                    <input
                      type="range"
                      min="-1"
                      max="3"
                      step=".5"
                      value={tracking}
                      onChange={(e) => setTracking(Number(e.target.value))}
                    />
                  </label>
                </div>
              </div>
              <div className="studio-foot">
                <button className="delete" onClick={handleDelete}>
                  <Trash2 size={15} />
                  Delete pairing
                </button>
                <span className="autosave-note">版本日志自动保存 · 作者 {CURRENT_AUTHOR}</span>
              </div>
            </section>
          )}
        </div>
      </main>
      {showAdd && (
        <div className="backdrop" onClick={() => setShowAdd(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>New pairing</h2>
            <label>
              Pairing name
              <input
                autoFocus
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="e.g. Quiet confidence"
              />
            </label>
            <div className="modal-actions">
              <button className="outline" onClick={() => setShowAdd(false)}>
                Cancel
              </button>
              <button className="primary" onClick={create}>
                Create pairing
              </button>
            </div>
          </div>
        </div>
      )}
      {showHistory && (
        <HistoryDrawer
          log={log}
          pairId={current?.id ?? null}
          pairTitle={current?.title ?? ''}
          onClose={() => setShowHistory(false)}
          onExportLog={() => download('type-pair-log.json', exportLogText(log), 'application/json')}
          onImportLog={handleImport}
          onSimulateTeammate={handleSimulate}
        />
      )}
      {showConflicts && (
        <ConflictPanel
          log={log}
          onClose={() => setShowConflicts(false)}
          onResolve={(conflictId, choice) => {
            const next = resolveConflict(log, conflictId, choice, CURRENT_AUTHOR);
            applyLog(next, '冲突已解决');
            if (openConflicts(next).length === 0) setShowConflicts(false);
          }}
        />
      )}
      {exportBlocks && (
        <div className="backdrop" onClick={() => setExportBlocks(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>
              <AlertTriangle size={18} /> 正式导出已暂停
            </h2>
            <p className="muted">以下配对的字段存在未解决的冲突，处理完才能导出：</p>
            <ul className="blocker-list">
              {exportBlocks.map((b) => (
                <li key={b.pairId}>
                  「{b.title}」：{b.fields.map((f) => FIELD_LABELS[f]).join('、')}
                </li>
              ))}
            </ul>
            <div className="modal-actions">
              <button className="outline" onClick={() => setExportBlocks(null)}>
                知道了
              </button>
              <button
                className="primary"
                onClick={() => {
                  setExportBlocks(null);
                  setShowConflicts(true);
                }}
              >
                前往处理冲突
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}

/** 配对内容编辑：一次保存把多个字段改动记成一个版本 */
function PairEditor({
  pair,
  disabled,
  onSave,
}: {
  pair: PairState;
  disabled: boolean;
  onSave: (updates: Partial<PairState>) => void;
}) {
  const [title, setTitle] = useState(pair.title);
  const [heading, setHeading] = useState(pair.heading);
  const [body, setBody] = useState(pair.body);
  const [category, setCategory] = useState(pair.category);
  const dirty =
    title !== pair.title || heading !== pair.heading || body !== pair.body || category !== pair.category;
  return (
    <div className={`controls editor ${disabled ? 'disabled' : ''}`}>
      <div className="control-head">
        <div>
          <span>PAIR CONTENT</span>
          <h3>配对内容（保存即记入版本日志）</h3>
        </div>
      </div>
      <div className="font-row">
        <label>
          标题
          <input className="text-input" value={title} disabled={disabled} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          分类
          <input
            className="text-input"
            value={category}
            disabled={disabled}
            onChange={(e) => setCategory(e.target.value)}
          />
        </label>
      </div>
      <div className="font-row">
        <label>
          标题文案
          <input
            className="text-input"
            value={heading}
            disabled={disabled}
            onChange={(e) => setHeading(e.target.value)}
          />
        </label>
        <label>
          正文文案
          <input className="text-input" value={body} disabled={disabled} onChange={(e) => setBody(e.target.value)} />
        </label>
      </div>
      <div className="editor-foot">
        <button
          className="primary"
          disabled={disabled || !dirty}
          onClick={() => onSave({ title: title.trim() || pair.title, heading, body, category: category.trim() })}
        >
          保存修改
        </button>
        {disabled && <small className="muted">已冻结，只能复制新版本</small>}
      </div>
    </div>
  );
}
