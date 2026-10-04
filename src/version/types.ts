// 可合并的版本日志 —— 类型定义
// 设计要点见 engine.ts 顶部注释。

/** 配对中可被三方合并的字段（按字段合并，离线回连不互相覆盖） */
export type MergeableField =
  | 'title'
  | 'heading'
  | 'body'
  | 'category'
  | 'headingFont'
  | 'bodyFont'
  | 'size'
  | 'weight'
  | 'leading'
  | 'tracking';

/** 不参与字段合并、只做本地标记的字段 */
export type LocalOnlyField = 'favorite';

export type FieldKey = MergeableField | LocalOnlyField;

export type FieldValue = string | number | boolean;

/** 一份配对的完整字段内容（快照基线也是这个形状） */
export interface PairData {
  title: string;
  heading: string;
  body: string;
  category: string;
  headingFont: string;
  bodyFont: string;
  size: number;
  weight: number;
  leading: number;
  tracking: number;
  favorite: boolean;
}

export const MERGEABLE_FIELDS: MergeableField[] = [
  'title', 'heading', 'body', 'category',
  'headingFont', 'bodyFont', 'size', 'weight', 'leading', 'tracking',
];

/** 单个字段的冲突：两边都改且改后不同，两版都保留 */
export interface FieldConflict {
  field: MergeableField;
  base: FieldValue;
  local: FieldValue;
  remote: FieldValue;
  /** 处理冲突时选择哪一版；未选完之前禁止正式导出 */
  resolution?: 'local' | 'remote' | 'custom';
  /** resolution=custom 时由作者手工填写的值 */
  customValue?: FieldValue;
}

/**
 * 日志条目。每个配对一条线性日志链（parent 指向上一条）。
 * 三种条目：
 *  - snapshot 迁移基线 / 压缩后产生的新基线，带完整字段
 *  - edit     一次保存：作者 + 基线(parentId) + 字段改动
 *  - merge    回连合并：记录双方来源、各字段自动合并结果与冲突
 */
export type LogEntry = SnapshotEntry | EditEntry | MergeEntry;

interface EntryBase {
  id: number;
  pairId: number;
  ts: number;
  author: string;
  parentId: number | null;
}

export interface SnapshotEntry extends EntryBase {
  kind: 'snapshot';
  /** 迁移基线标记，便于在日志中区分旧数据 */
  migrated?: boolean;
  data: PairData;
}

export interface EditEntry extends EntryBase {
  kind: 'edit';
  changes: Record<string, FieldValue>;
  /** 冲突解决提交：resolves 列出本次提交拍板的字段 */
  resolves?: MergeableField[];
}

export interface MergeEntry extends EntryBase {
  kind: 'merge';
  /** 合并时本地侧的末端条目 */
  localHeadId: number;
  /** 合并时远端侧的末端条目 */
  remoteHeadId: number;
  /** 远端日志里同一条 merge 的 id，便于推送后对齐 */
  remoteEntryId: number;
  /** 自动合并后、无冲突字段直接落定的改动（相对共同祖先） */
  changes: Partial<Record<MergeableField, FieldValue>>;
  /** 两边都改且改后不同的字段：两版都保留 */
  conflicts: FieldConflict[];
  resolved: boolean;
}

export interface CopyRef {
  /** 由哪个配对复制而来 */
  fromPairId: number;
  /** 锁定的具体版本条目 */
  entryId: number;
  ts: number;
}

/** 一次正式导出记录；被引用的版本压缩时不得消失 */
export interface ExportRecord {
  id: number;
  ts: number;
  pairId: number;
  entryId: number;
  author: string;
}

export interface PairRecord {
  id: number;
  createdAt: number;
  /** 冻结后不可越权修改/删除，只能复制出新版本继续做 */
  frozen: boolean;
  /** 复制自被冻结方案时，保留对旧版本的引用 */
  copyOf?: CopyRef;
  entries: LogEntry[];
  /** 本地已推送（与远端共享）的末端条目 id；其后为离线待同步条目 */
  lastSyncedEntryId: number | null;
}

/** 模拟的“共享库”服务端状态（本演示存在 localStorage 里） */
export interface RemoteState {
  pairs: Record<number, PairRecord>;
  /** 删除墓碑，回连后对端也会删掉 */
  tombstones: number[];
  nextEntryId: number;
}

export interface Store {
  version: 1;
  author: string;
  online: boolean;
  pairs: Record<number, PairRecord>;
  /** 删除墓碑，回连后对端也会删掉 */
  tombstones: number[];
  nextPairId: number;
  /** 与 RemoteState 共享的条目 id 键空间，回连时取两边最大值并消解碰撞 */
  nextEntryId: number;
  exports: ExportRecord[];
}

/** 落盘格式契约（与 Store 同构，单独命名以强调导入导出按完整日志处理） */
export type SerializedStore = Store;

export const EMPTY_DATA: PairData = {
  title: '',
  heading: '',
  body: '',
  category: 'Untitled',
  headingFont: 'Fraunces',
  bodyFont: 'DM Sans',
  size: 46,
  weight: 600,
  leading: 1.25,
  tracking: 0,
  favorite: false,
};
