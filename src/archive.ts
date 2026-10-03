import { ref } from "vue";
import type { ReviewEvent, ScoreRecord, SchemeStatus } from "./types";

/**
 * 评分存档层：把评分草稿与提交结果写成可恢复的存档。
 * - 写入失败自动重试；仍失败则保留在内存并标记“未存档”。
 * - 容量不足时把旧流水（评审事件）分批腾退再重试；已提交评分与锁定结果不参与腾退。
 * - 多窗口并发保存时按项合并；同一项撞车时，共享存档保留先写入的版本，当前窗口草稿由调用方留住。
 * - 旧版本数据打开时按兼容方式读取并带上版本号，草稿与锁定结果都保留。
 */
export const ARCHIVE_KEY = "pair-wise-yf-48/review";
export const ARCHIVE_VERSION = 1;
const EVICT_BATCH = 20;
const MAX_EVICTION_ROUNDS = 200;

export interface ArchiveV1 {
  version: number;
  savedAt: string;
  scores: ScoreRecord[];
  events: ReviewEvent[];
  published: boolean;
  schemeStatuses: Record<string, SchemeStatus>;
}

export interface ConflictInfo {
  id: string;
  remote: ScoreRecord;
  local: ScoreRecord;
}

export interface SaveOptions {
  /** 本窗口上次同步时各项的 updatedAt，用于判断其他窗口是否改过同一项 */
  baseTimestamps?: Record<string, string>;
}

export interface SaveOutcome {
  ok: boolean;
  archived: boolean;
  /** 本次腾退的旧流水条数 */
  evicted: number;
  evictedIds: string[];
  conflicts: ConflictInfo[];
  /** 最终写入（或尝试写入）的存档；失败时为已腾退但写不进的副本 */
  merged: ArchiveV1;
  reason?: "quota" | "error";
}

/** 全局存档状态：archived=已写入本地；memory=仅在内存（未存档）；unknown=尚未尝试 */
export const archiveStatus = ref<"archived" | "memory" | "unknown">("unknown");
/** 打开的是否为没有版本号的旧数据（用于提示“已兼容升级”） */
export const didMigrate = ref(false);

let memoryArchive: ArchiveV1 | null = null;

export function emptyArchive(): ArchiveV1 {
  return { version: ARCHIVE_VERSION, savedAt: new Date().toISOString(), scores: [], events: [], published: false, schemeStatuses: {} };
}

/** 把任意历史数据兼容成当前版本的存档；旧草稿与锁定结果都保留。 */
export function migrate(raw: unknown): ArchiveV1 {
  const base = emptyArchive();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const isLegacy = r.version == null;
  didMigrate.value = isLegacy;
  return {
    version: ARCHIVE_VERSION,
    savedAt: typeof r.savedAt === "string" ? r.savedAt : new Date().toISOString(),
    scores: Array.isArray(r.scores) ? (r.scores as ScoreRecord[]) : [],
    events: Array.isArray(r.events) ? (r.events as ReviewEvent[]) : [],
    published: !!r.published,
    schemeStatuses: (r.schemeStatuses ?? {}) as Record<string, SchemeStatus>,
  };
}

function readStorage(): string | null {
  try {
    return localStorage.getItem(ARCHIVE_KEY);
  } catch {
    return null;
  }
}

function isQuotaError(e: unknown): boolean {
  return !!e && typeof e === "object" && ((e as DOMException).name === "QuotaExceededError" || (e as DOMException).code === 22);
}

function tryWrite(archive: ArchiveV1): { ok: boolean; quota: boolean } {
  try {
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(archive));
    return { ok: true, quota: false };
  } catch (e) {
    return { ok: false, quota: isQuotaError(e) };
  }
}

/** 读取其他窗口已写入的最新存档；本地存储不可用时回退到内存副本。 */
function readRemote(): ArchiveV1 {
  if (archiveStatus.value === "memory" && memoryArchive) return memoryArchive;
  const text = readStorage();
  if (text) {
    try {
      return migrate(JSON.parse(text));
    } catch {
      /* 存档损坏，回退内存 */
    }
  }
  return memoryArchive ?? emptyArchive();
}

/** 打开存档：兼容旧版本，失败时回退内存或空存档。 */
export function loadArchive(): ArchiveV1 {
  const text = readStorage();
  if (text) {
    try {
      return migrate(JSON.parse(text));
    } catch {
      /* 存档损坏，回退内存 */
    }
  }
  return memoryArchive ?? emptyArchive();
}

const STATUS_RANK: Record<SchemeStatus, number> = { "待评分": 0, "评分中": 1, "已提交": 2, "已锁定": 3 };

/**
 * 把本窗口存档与其他窗口写入的存档合并。
 * - 评分按 id 逐项合并：本窗口改过且对方没动过 → 用本窗口；对方改过且本窗口没动 → 用对方；两边都改 → 撞车，共享存档保留对方版本。
 * - 事件流水按 id 并集（两个窗口的记录都留下）。
 * - 方案状态只升不降；published 任一窗口锁定即为锁定。
 */
export function mergeArchives(remote: ArchiveV1, local: ArchiveV1, base: Record<string, string>): { merged: ArchiveV1; conflicts: ConflictInfo[] } {
  const conflicts: ConflictInfo[] = [];
  const byId = new Map<string, ScoreRecord>();
  for (const s of remote.scores) byId.set(s.id, { ...s });
  for (const s of local.scores) {
    const r = byId.get(s.id);
    const baseTs = base[s.id] ?? "";
    const localChanged = s.updatedAt > baseTs;
    const remoteChanged = !!r && r.updatedAt > baseTs;
    if (remoteChanged && localChanged) {
      conflicts.push({ id: s.id, remote: { ...r! }, local: { ...s } });
      // 共享存档保留先写入的版本；当前窗口的草稿由调用方在状态中保留，不被回滚。
    } else if (localChanged) {
      byId.set(s.id, { ...s });
    }
  }

  const eventMap = new Map<string, ReviewEvent>();
  for (const e of remote.events) eventMap.set(e.id, e);
  for (const e of local.events) if (!eventMap.has(e.id)) eventMap.set(e.id, e);
  const events = [...eventMap.values()].sort((a, b) => (a.time < b.time ? 1 : -1));

  const statusIds = new Set([...Object.keys(remote.schemeStatuses), ...Object.keys(local.schemeStatuses)]);
  const schemeStatuses: Record<string, SchemeStatus> = {};
  for (const id of statusIds) {
    const rs = remote.schemeStatuses[id];
    const ls = local.schemeStatuses[id];
    schemeStatuses[id] = (STATUS_RANK[rs ?? "待评分"] >= STATUS_RANK[ls ?? "待评分"] ? rs : ls) ?? ls ?? rs ?? "待评分";
  }

  const merged: ArchiveV1 = {
    version: ARCHIVE_VERSION,
    savedAt: new Date().toISOString(),
    scores: [...byId.values()],
    events,
    published: remote.published || local.published,
    schemeStatuses,
  };
  return { merged, conflicts };
}

/** 最旧的流水优先，分批腾退；评分与锁定结果不在此处理。 */
function evictOldestEvents(archive: ArchiveV1, batchSize: number): { archive: ArchiveV1; evictedIds: string[] } {
  const ascending = [...archive.events].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const evicted = ascending.slice(0, batchSize);
  const evictedIds = new Set(evicted.map((e) => e.id));
  return {
    archive: { ...archive, events: archive.events.filter((e) => !evictedIds.has(e.id)) },
    evictedIds: [...evictedIds],
  };
}

/**
 * 保存存档：合并 → 写入；容量不足则分批腾退旧流水后重试；仍失败则留内存并标记未存档。
 */
export function saveArchive(local: ArchiveV1, opts: SaveOptions = {}): SaveOutcome {
  const { merged, conflicts } = mergeArchives(readRemote(), local, opts.baseTimestamps ?? {});
  let candidate = merged;
  let evicted = 0;
  const evictedIds: string[] = [];
  let reason: "quota" | "error" = "error";

  for (let round = 0; round <= MAX_EVICTION_ROUNDS; round++) {
    const res = tryWrite(candidate);
    if (res.ok) {
      memoryArchive = null;
      archiveStatus.value = "archived";
      return { ok: true, archived: true, evicted, evictedIds, conflicts, merged: candidate };
    }
    if (res.quota) {
      reason = "quota";
      if (candidate.events.length === 0) break; // 旧流水已腾退殆尽，仍放不下
      const ev = evictOldestEvents(candidate, EVICT_BATCH);
      candidate = ev.archive;
      evicted += ev.evictedIds.length;
      evictedIds.push(...ev.evictedIds);
      continue;
    }
    // 非容量错误：自动重试两次
    let gaveUp = true;
    for (let retry = 0; retry < 2; retry++) {
      const r2 = tryWrite(candidate);
      if (r2.ok) {
        memoryArchive = null;
        archiveStatus.value = "archived";
        return { ok: true, archived: true, evicted, evictedIds, conflicts, merged: candidate };
      }
      if (r2.quota) {
        reason = "quota";
        gaveUp = false;
        break;
      }
    }
    if (gaveUp) break;
  }

  // 存档失败：保留在内存，提示未存档
  memoryArchive = candidate;
  archiveStatus.value = "memory";
  return { ok: false, archived: false, evicted, evictedIds, conflicts, merged: candidate, reason };
}
