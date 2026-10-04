import { X } from 'lucide-react';
import {
  FIELD_LABELS,
  formatFieldValue,
  mainChain,
  type EntryKind,
  type VersionEntry,
  type VersionLog,
} from '../lib/versionLog';

const KIND_LABEL: Record<EntryKind, string> = {
  baseline: '基线',
  create: '创建',
  edit: '编辑',
  merge: '回连合并',
  resolve: '解决冲突',
  freeze: '冻结',
  fork: '复制新版本',
  snapshot: '压缩快照',
  conflict: '冲突',
};

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

function entryLines(e: VersionEntry): string[] {
  if (e.kind === 'snapshot')
    return [`压缩了 ${e.compactedCount ?? 0} 条旧记录`, `涉及作者：${(e.compactedAuthors ?? []).join('、') || '—'}`];
  if (e.kind === 'merge')
    return e.changes.length
      ? [`自动并入 ${e.changes.length} 个字段：${e.changes.map((c) => FIELD_LABELS[c.field]).join('、')}`]
      : ['与对端汇合，无字段需要变更'];
  if (e.kind === 'conflict' && e.conflict)
    return [
      `字段「${FIELD_LABELS[e.conflict.field]}」两边都改过，已各留一版`,
      `本地 ${e.conflict.localAuthor}：${formatFieldValue(e.conflict.field, e.conflict.localValue)}`,
      `对端 ${e.conflict.remoteAuthor}：${formatFieldValue(e.conflict.field, e.conflict.remoteValue)}`,
    ];
  if (e.kind === 'freeze') return ['方案冻结，之后只能复制新版本'];
  if (e.kind === 'fork') return ['从冻结方案复制出的可编辑新版本'];
  if (e.kind === 'baseline') return ['旧数据迁移为基线'];
  return e.changes.map((c) => `${FIELD_LABELS[c.field]}：${formatFieldValue(c.field, c.from)} → ${formatFieldValue(c.field, c.to)}`);
}

interface Props {
  log: VersionLog;
  pairId: number | null;
  pairTitle: string;
  onClose: () => void;
  onExportLog: () => void;
  onImportLog: (file: File) => void;
  onSimulateTeammate: () => void;
}

export default function HistoryDrawer({ log, pairId, pairTitle, onClose, onExportLog, onImportLog, onSimulateTeammate }: Props) {
  const chain = pairId === null ? [] : mainChain(log, pairId);
  const entries = [...chain].reverse();
  return (
    <div className="drawer-wrap">
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-head">
          <div>
            <span className="drawer-kicker">VERSION LOG</span>
            <h2>版本历史 · {pairTitle}</h2>
            <small>{chain.length} 个版本 · 保存即记录作者、基线与字段改动</small>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="drawer-body">
          {entries.map((e) => (
            <div key={e.id} className={`v-entry kind-${e.kind}`}>
              <div className="v-entry-top">
                <span className="v-badge">{KIND_LABEL[e.kind]}</span>
                <b>{e.author}</b>
                <time>{fmtTime(e.timestamp)}</time>
              </div>
              {entryLines(e).map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          ))}
          {entries.length === 0 && <p className="drawer-empty">该配对还没有版本记录</p>}
        </div>
        <div className="drawer-foot">
          <button className="outline" onClick={onExportLog}>导出日志</button>
          <label className="outline file-btn">
            导入日志
            <input
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onImportLog(f);
                e.target.value = '';
              }}
            />
          </label>
          <button className="outline" onClick={onSimulateTeammate}>模拟同事编辑</button>
        </div>
      </aside>
    </div>
  );
}
