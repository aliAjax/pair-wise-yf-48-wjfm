export type Viewer = "评委-林策" | "评委-周筑" | "主办方";
export type SchemeStatus = "待评分" | "评分中" | "已提交" | "已锁定";

export interface Scheme {
  id: string;
  code: string;
  title: string;
  synopsis: string;
  publicNo: string;
  status: SchemeStatus;
}

export interface Criterion {
  id: string;
  name: string;
  description: string;
  weight: number;
  max: number;
}

/** 撞车时留档的另一个窗口版本，本身仍是一条可被恢复采用的完整评分 */
export type StashedScore = ScoreRecord;

export interface ScoreRecord {
  id: string;
  judge: Viewer;
  schemeId: string;
  values: Record<string, number>;
  comment: string;
  submitted: boolean;
  conflict: boolean;
  updatedAt: string;
  /** 本版本是在哪个版本（updatedAt）基础上编辑出来的，用于区分线性更新与分叉撞车 */
  baseRev?: string;
  /** 后保存的一方发现同一项已被其他窗口改动时置位：提示冲突，本窗口内容继续作为草稿保留 */
  saveConflict?: boolean;
  /** 撞车时留档的其它窗口版本，全部保留不覆盖，解决冲突时可取用 */
  collisions?: StashedScore[];
}

export interface ReviewEvent {
  id: string;
  time: string;
  actor: Viewer;
  action: string;
  detail: string;
}

/** 当前存档版本。旧版数据没有 version 字段，读取时按 v1 兼容迁移并补齐该字段 */
export const ARCHIVE_VERSION = 2;

export interface ReviewArchive {
  version: number;
  scores: ScoreRecord[];
  events: ReviewEvent[];
  published: boolean;
  schemeStatuses: Record<string, SchemeStatus>;
}
