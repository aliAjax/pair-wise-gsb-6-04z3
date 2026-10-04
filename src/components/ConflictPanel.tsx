import { AlertTriangle, X } from 'lucide-react';
import { FIELD_LABELS, formatFieldValue, materialize, openConflicts, type VersionLog } from '../lib/versionLog';

interface Props {
  log: VersionLog;
  onResolve: (conflictId: string, choice: 'local' | 'remote') => void;
  onClose: () => void;
}

/** 冲突处理面板：同一字段两边都改过的，保留两版，由人选定一版 */
export default function ConflictPanel({ log, onResolve, onClose }: Props) {
  const conflicts = openConflicts(log);
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal conflict-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head-row">
          <h2>
            <AlertTriangle size={18} /> 待处理的冲突（{conflicts.length}）
          </h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        {conflicts.length === 0 && <p className="muted">没有未解决的冲突，可以正式导出。</p>}
        {conflicts.map((c) => {
          const pair = materialize(log, c.pairId);
          return (
            <div key={c.conflictId} className="conflict-card">
              <div className="conflict-title">
                「{pair?.title ?? `#${c.pairId}`}」 · 字段 <b>{FIELD_LABELS[c.field]}</b> 两边都改过
              </div>
              <div className="conflict-sides">
                <div className="side">
                  <span>本地 · {c.localAuthor}</span>
                  <p>{formatFieldValue(c.field, c.localValue)}</p>
                  <button className="outline" onClick={() => onResolve(c.conflictId, 'local')}>
                    保留本地
                  </button>
                </div>
                <div className="side">
                  <span>对端 · {c.remoteAuthor}</span>
                  <p>{formatFieldValue(c.field, c.remoteValue)}</p>
                  <button className="outline" onClick={() => onResolve(c.conflictId, 'remote')}>
                    采用对端
                  </button>
                </div>
              </div>
              <small className="muted">基线值：{formatFieldValue(c.field, c.baseValue)}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}
