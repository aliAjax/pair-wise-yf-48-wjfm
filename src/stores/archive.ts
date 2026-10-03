import type { ReviewArchive, SchemeStatus, ScoreRecord } from "../types";
import { ARCHIVE_VERSION } from "../types";

export const ARCHIVE_KEY = "pair-wise-yf-48/review";

/** 初始空存档（带上当前版本信息） */
export function emptyArchive(): ReviewArchive {
  return { version: ARCHIVE_VERSION, scores: [], events: [], published: false, schemeStatuses: {} };
}

function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && (
    error.name === "QuotaExceededError"
    || error.name === "NS_ERROR_DOM_QUOTA_REACHED"
    // 部分隐私模式下配额耗尽抛的是 AccessDenied
    || (error.name === "AccessDeniedError" && typeof navigator !== "undefined" && !navigator.cookieEnabled)
  );
}

function writeRaw(value: string): void {
  localStorage.setItem(ARCHIVE_KEY, value);
}

/** 直接落盘一次；配额不足等失败原样抛出，由上层决定重试或腾退 */
export function writeArchive(data: ReviewArchive): void {
  writeRaw(JSON.stringify({ ...data, version: ARCHIVE_VERSION }));
}

/** 旧数据按兼容方式打开：无版本字段按 v1 处理，原有草稿和锁定结果都保留 */
export function readArchive(): ReviewArchive {
  const raw = localStorage.getItem(ARCHIVE_KEY);
  if (!raw) return emptyArchive();
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyArchive();
  }
  if (typeof parsed !== "object" || parsed === null) return emptyArchive();

  const archive: ReviewArchive = {
    // 旧版数据没有 version：标成 1 走兼容迁移；无法识别的更高版本只照读，不破坏其字段
    version: typeof parsed.version === "number" ? parsed.version : 1,
    scores: Array.isArray(parsed.scores) ? parsed.scores : [],
    events: Array.isArray(parsed.events) ? parsed.events : [],
    published: Boolean(parsed.published),
    schemeStatuses: parsed.schemeStatuses && typeof parsed.schemeStatuses === "object" ? parsed.schemeStatuses : {}
  };
  // v1 -> v2：给原有记录补 baseRev 元数据；草稿（submitted=false）与锁定结果（published）保持原样可读
  if (archive.version < 2) {
    archive.scores = archive.scores.map((score) => ({
      baseRev: score.updatedAt,
      saveConflict: false,
      collisions: [],
      ...score
    }));
    archive.version = 2;
  }
  return archive;
}

/**
 * 容量不够时的腾退策略：按批次淘汰最旧的未提交草稿与旧事件流水，
 * 已提交评分（submitted）不参与腾退；锁定结果（published）状态及其锁定事件
 * 同样保留。keepKey 指向当前正在编辑的记录，永不腾退。
 */
const LOCK_ACTIONS = new Set(["锁定并发布结果"]);

export function evictBatch(archive: ReviewArchive, keepKey?: string): ReviewArchive {
  const evictableScores = archive.scores
    .filter((score) => !score.submitted && score.id !== keepKey)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const batchSize = Math.max(1, Math.ceil(evictableScores.length / 3));
  const removedScores = new Set(evictableScores.slice(0, batchSize).map((score) => score.id));

  const evictableEvents = archive.events
    .filter((event) => !LOCK_ACTIONS.has(event.action))
    .sort((a, b) => a.time.localeCompare(b.time));
  const eventBatch = Math.max(1, Math.ceil(evictableEvents.length / 3));
  const removedEvents = new Set(evictableEvents.slice(0, eventBatch).map((event) => event.id));

  return {
    ...archive,
    scores: archive.scores.filter((score) => !removedScores.has(score.id)),
    events: archive.events.filter((event) => !removedEvents.has(event.id))
  };
}

export interface PersistResult {
  ok: boolean;
  /** quota：容量不足且已无旧流水可腾退；error：其它写入失败 */
  reason?: "quota" | "error";
  evicted: { scores: number; events: number };
}

type AttemptOutcome = "ok" | "retry" | "fail";

/**
 * 带自动重试和配额腾退的落盘：
 * 1. 普通失败按退避节奏重试；
 * 2. 配额不足先分批腾退旧草稿/旧流水（已提交评分与锁定结果不动），再重试；
 * 3. 仍失败则把数据留给调用方暂存在内存里。
 */
export async function persistArchive(
  data: ReviewArchive,
  keepKey: string | undefined,
  retryDelays = [200, 800, 2000]
): Promise<PersistResult> {
  let current = data;
  let quota = false;
  let evicted = { scores: 0, events: 0 };

  const attempt = (): AttemptOutcome => {
    try {
      writeArchive(current);
      return "ok";
    } catch (error) {
      if (!isQuotaError(error)) return "retry";
      quota = true;
      const before = { scores: current.scores.length, events: current.events.length };
      const next = evictBatch(current, keepKey);
      if (next.scores.length === current.scores.length && next.events.length === current.events.length) {
        return "retry"; // 已没有可腾退的旧流水，退避后再试
      }
      evicted = {
        scores: evicted.scores + before.scores - next.scores.length,
        events: evicted.events + before.events - next.events.length
      };
      current = next;
      try {
        writeArchive(current);
        return "ok";
      } catch {
        // 腾退一批后仍不够：下一轮退避后再腾一批；其它错误同样退避重试
        return "retry";
      }
    }
  };

  for (let i = 0; i <= retryDelays.length; i++) {
    if (attempt() === "ok") return { ok: true, evicted };
    if (i < retryDelays.length) await new Promise((resolve) => setTimeout(resolve, retryDelays[i]));
  }
  return { ok: false, reason: quota ? "quota" : "error", evicted };
}

/** 三条合并结果：merge=磁盘版本更新，直接采纳；fork=同一项被两个窗口各自改过，撞车留档 */
export type MergeOutcome =
  | { kind: "merge"; archive: ReviewArchive }
  | { kind: "fork"; archive: ReviewArchive; conflicts: ScoreRecord[] };

function sameScore(a: ScoreRecord, b: ScoreRecord): boolean {
  return a.updatedAt === b.updatedAt
    && a.submitted === b.submitted
    && a.conflict === b.conflict
    && a.comment === b.comment
    && JSON.stringify(a.values) === JSON.stringify(b.values);
}

/**
 * 把本窗口视图与磁盘最新内容做三路合并（以本窗口启动时/上次同步的快照为 base）：
 * - 只有一边改了：采纳改动；
 * - 同一项两边都改（撞车）：保留两边内容，本地版本标 saveConflict 并把磁盘版本存入 collisions；
 * - 已提交/锁定状态不可逆：只要任一边为已提交/已锁定就以提交/锁定为准。
 */
export function mergeArchives(base: ReviewArchive, local: ReviewArchive, disk: ReviewArchive): MergeOutcome {
  const conflicts: ScoreRecord[] = [];
  const mergedPublished = local.published || disk.published;
  const merged: ReviewArchive = {
    version: ARCHIVE_VERSION,
    published: mergedPublished,
    schemeStatuses: mergeStatuses(local.schemeStatuses, disk.schemeStatuses, mergedPublished),
    events: mergeEvents(base.events, local.events, disk.events),
    scores: []
  };

  const keys = new Set<string>();
  [...local.scores, ...disk.scores].forEach((score) => keys.add(score.id));
  keys.forEach((id) => {
    const localScore = local.scores.find((score) => score.id === id);
    const diskScore = disk.scores.find((score) => score.id === id);
    const baseScore = base.scores.find((score) => score.id === id);

    if (localScore && !diskScore) {
      // 磁盘上已没有：本地新建的保留；与基准一致说明是被另一窗口腾退掉的旧草稿，不复活
      if (!baseScore || !sameScore(localScore, baseScore)) merged.scores.push(localScore);
      return;
    }
    if (diskScore && !localScore) {
      merged.scores.push(diskScore);
      return;
    }
    if (!localScore || !diskScore) return;

    // 磁盘与本地内容一致（或一边就是磁盘版本的原样）
    if (sameScore(localScore, diskScore) || (baseScore && sameScore(diskScore, baseScore))) {
      merged.scores.push(localScore);
      return;
    }
    if (baseScore && sameScore(localScore, baseScore)) {
      merged.scores.push(diskScore);
      return;
    }

    // 已提交优先：任一窗口已提交则提交结果生效，未提交版本作为碰撞留档不丢失
    if (localScore.submitted || diskScore.submitted) {
      const winner = localScore.submitted && diskScore.submitted
        ? (localScore.updatedAt >= diskScore.updatedAt ? localScore : diskScore)
        : (localScore.submitted ? localScore : diskScore);
      const loser = winner === localScore ? diskScore : localScore;
      if (!loser.submitted || !sameScore(loser, winner)) {
        const stashed: ScoreRecord = { ...loser, collisions: undefined, saveConflict: false };
        merged.scores.push({
          ...winner,
          saveConflict: !sameScore(loser, winner),
          collisions: dedupeCollisions([...(winner.collisions ?? []), stashed])
        });
        conflicts.push(merged.scores[merged.scores.length - 1]);
      } else {
        merged.scores.push(winner);
      }
      return;
    }

    // 草稿分叉：两边都在 base 之后改了同一项 -> 后保存者看到冲突，两份都留住
    const stashed: ScoreRecord = { ...diskScore, collisions: undefined };
    const retained: ScoreRecord = {
      ...localScore,
      saveConflict: true,
      collisions: dedupeCollisions([...(localScore.collisions ?? []), ...(diskScore.collisions ?? []), stashed])
    };
    merged.scores.push(retained);
    conflicts.push(retained);
  });

  return { kind: conflicts.length ? "fork" : "merge", archive: merged, conflicts };
}

function dedupeCollisions(items: ScoreRecord[]): ScoreRecord[] {
  const map = new Map<string, ScoreRecord>();
  items.forEach((item) => map.set(item.updatedAt, item));
  return [...map.values()];
}

const STATUS_RANK: Record<string, number> = { "待评分": 0, "评分中": 1, "已提交": 2, "已锁定": 3 };
function mergeStatuses(
  a: Record<string, SchemeStatus>,
  b: Record<string, SchemeStatus>,
  published: boolean
): Record<string, SchemeStatus> {
  const out: Record<string, SchemeStatus> = {};
  new Set([...Object.keys(a), ...Object.keys(b)]).forEach((id) => {
    const left = a[id];
    const right = b[id];
    let status = !left ? right : !right ? left : STATUS_RANK[left] >= STATUS_RANK[right] ? left : right;
    if (published) status = "已锁定";
    out[id] = status;
  });
  return out;
}

function mergeEvents(base: ReviewEventLike[], local: ReviewEventLike[], disk: ReviewEventLike[]): ReviewEventLike[] {
  const map = new Map<string, ReviewEventLike>();
  // 磁盘现存的事件都保留（已被另一窗口腾退掉的旧流水不因其还在本地副本里而复活）
  disk.forEach((event) => map.set(event.id, event));
  // 本地相对基准新增的事件加入
  const baseIds = new Set(base.map((event) => event.id));
  local.forEach((event) => {
    if (!baseIds.has(event.id)) map.set(event.id, event);
  });
  return [...map.values()].sort((a, b) => b.time.localeCompare(a.time));
}

type ReviewEventLike = ReviewArchive["events"][number];
