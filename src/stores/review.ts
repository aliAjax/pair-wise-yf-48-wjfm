import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type { Criterion, ReviewArchive, ReviewEvent, Scheme, ScoreRecord, StashedScore, Viewer } from "../types";
import { ARCHIVE_KEY, mergeArchives, persistArchive, readArchive } from "./archive";

const judges: Viewer[] = ["评委-林策", "评委-周筑"];
const seedSchemes: Scheme[] = [
  { id: "a", code: "S-01", title: "潮间带公共客厅", synopsis: "通过退台屋面把社区活动引向水岸，底层保留可被潮水短暂侵入的公共空间。", publicNo: "投递号 7182", status: "待评分" },
  { id: "b", code: "S-02", title: "风廊共生院", synopsis: "以双庭院组织低能耗社区中心，利用贯穿体量连接既有街巷。", publicNo: "投递号 6610", status: "待评分" },
  { id: "c", code: "S-03", title: "折线工坊", synopsis: "保留旧修理厂桁架，置入可拆装工坊和培训空间。", publicNo: "投递号 8024", status: "待评分" }
];
const criteria: Criterion[] = [
  { id: "site", name: "场地回应", description: "与气候、地貌和周边公共空间的关系", weight: 30, max: 100 },
  { id: "program", name: "功能组织", description: "空间组织、流线和公共性", weight: 25, max: 100 },
  { id: "structure", name: "结构与建造", description: "结构逻辑、材料和建造可行性", weight: 25, max: 100 },
  { id: "sustain", name: "环境策略", description: "节能、碳排和长期维护", weight: 20, max: 100 }
];

function emptyScore(judge: Viewer, schemeId: string): ScoreRecord {
  const now = new Date().toISOString();
  return { id: `${judge}-${schemeId}`, judge, schemeId, values: Object.fromEntries(criteria.map((item) => [item.id, 60])), comment: "", submitted: false, conflict: false, updatedAt: now, baseRev: now, saveConflict: false, collisions: [] };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export interface SaveOutcome {
  /** 已写入本地存档；false 表示暂存内存、等待重试 */
  persisted: boolean;
  /** 与另一窗口的同一项撞车：对方版本已留档，本版本作为草稿保留 */
  conflict: boolean;
  /** 本次为腾出空间批量淘汰的旧流水数量 */
  evicted?: { scores: number; events: number };
}

export const useReviewStore = defineStore("review", () => {
  // 启动时按版本兼容方式读档（旧版草稿、已锁定结果都照常读出并迁移）
  const initial = readArchive();
  // snapshot = 上次确认落盘的内容，作为跨窗口三路合并的共同基准
  let snapshot: ReviewArchive = clone(initial);

  const viewer = ref<Viewer>("评委-林策");
  const schemes = ref<Scheme[]>(seedSchemes.map((scheme) => ({ ...scheme, status: initial.schemeStatuses[scheme.id] ?? scheme.status })));
  const scores = ref<ScoreRecord[]>(initial.scores);
  const events = ref<ReviewEvent[]>(initial.events);
  const published = ref<boolean>(initial.published);

  /** 最近一次落盘失败：数据仍在内存中，界面需提示“未存档” */
  const unsaved = ref(false);
  /** 最近一次保存时的冲突记录（供视图即时提示） */
  const lastConflicts = ref<ScoreRecord[]>([]);

  const isOrganizer = computed(() => viewer.value === "主办方");
  const judge = computed(() => viewer.value.startsWith("评委-") ? viewer.value : null);
  const visibleScores = computed(() => isOrganizer.value ? scores.value : scores.value.filter((score) => score.judge === judge.value));

  function log(action: string, detail: string) {
    events.value.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor: viewer.value, action, detail });
  }

  /** 仅打开查看、从未保存过的空草稿：不落盘、不参与跨窗口合并 */
  const phantoms = new WeakSet<ScoreRecord>();
  /** 已在内存或磁盘中存在过的记录 id：避免合并进真实记录后又被误当成幻影草稿 */
  const knownIds = new Set<string>(initial.scores.map((item) => item.id));

  function record(schemeId: string) {
    const currentJudge = judge.value;
    if (!currentJudge) return null;
    let item = scores.value.find((score) => score.judge === currentJudge && score.schemeId === schemeId);
    if (!item) {
      item = emptyScore(currentJudge, schemeId);
      if (!knownIds.has(item.id)) phantoms.add(item);
      scores.value.push(item);
    }
    return item;
  }

  function stamp(item: ScoreRecord, values: Record<string, number>, comment: string, conflict: boolean) {
    phantoms.delete(item);
    item.baseRev = item.updatedAt;
    item.values = { ...values };
    item.comment = comment;
    item.conflict = conflict;
    item.updatedAt = new Date().toISOString();
    markChanged();
  }

  function saveDraft(schemeId: string, values: Record<string, number>, comment: string, conflict: boolean): Promise<SaveOutcome | null> {
    const item = record(schemeId);
    if (!item || item.submitted) return Promise.resolve(null);
    stamp(item, values, comment, conflict);
    const scheme = schemes.value.find((entry) => entry.id === schemeId);
    if (scheme && scheme.status === "待评分") scheme.status = "评分中";
    log("保存评分草稿", `${scheme?.code ?? schemeId}${conflict ? "，声明利益冲突" : ""}`);
    return flush();
  }

  async function submit(schemeId: string, values: Record<string, number>, comment: string, conflict: boolean): Promise<SaveOutcome | null> {
    const item = record(schemeId);
    if (!item) return null;
    stamp(item, values, comment, conflict);
    item.submitted = true;
    item.saveConflict = false;
    const scheme = schemes.value.find((entry) => entry.id === schemeId);
    if (scheme) scheme.status = allSubmittedFor(schemeId) ? "已提交" : "评分中";
    log("提交评分", scheme?.code ?? schemeId);
    return flush();
  }

  async function recalled(schemeId: string) {
    const item = record(schemeId);
    if (!item || published.value) return;
    item.submitted = false;
    log("退回评分修改", schemes.value.find((scheme) => scheme.id === schemeId)?.code ?? schemeId);
    await flush();
  }

  function allSubmittedFor(schemeId: string) {
    return judges.every((name) => scores.value.some((score) => score.judge === name && score.schemeId === schemeId && score.submitted));
  }

  const ranking = computed(() => {
    if (!published.value) return [];
    return schemes.value.map((scheme) => {
      const rows = scores.value.filter((score) => score.schemeId === scheme.id && score.submitted && !score.conflict);
      const total = rows.length ? rows.reduce((sum, row) => sum + criteria.reduce((value, criterion) => value + row.values[criterion.id] * criterion.weight / 100, 0), 0) / rows.length : 0;
      return { ...scheme, total: Number(total.toFixed(2)), judgeCount: rows.length, conflicts: scores.value.filter((score) => score.schemeId === scheme.id && score.conflict).length };
    }).sort((a, b) => b.total - a.total);
  });

  async function publish(): Promise<SaveOutcome | null> {
    if (!schemes.value.every((scheme) => allSubmittedFor(scheme.id))) return null;
    published.value = true;
    schemes.value.forEach((scheme) => { scheme.status = "已锁定"; });
    log("锁定并发布结果", `${schemes.value.length} 个匿名方案`);
    return flush();
  }

  /** 撞车后采用留档的对方版本：在其基础上继续作为本窗口草稿 */
  async function adoptCollision(schemeId: string, stashed: StashedScore) {
    const item = record(schemeId);
    if (!item || item.submitted) return;
    phantoms.delete(item);
    item.baseRev = stashed.updatedAt;
    item.values = { ...stashed.values };
    item.comment = stashed.comment;
    item.conflict = stashed.conflict;
    item.updatedAt = new Date().toISOString();
    item.collisions = (item.collisions ?? []).filter((entry) => entry.updatedAt !== stashed.updatedAt);
    item.saveConflict = item.collisions.length > 0;
    log("采用冲突留档版本", schemes.value.find((scheme) => scheme.id === schemeId)?.code ?? schemeId);
    await flush();
    return { values: { ...item.values }, comment: item.comment, conflict: item.conflict };
  }

  /** 撞车后确认保留自己的草稿：清除冲突提示，对方版本继续留在 collisions 中可查 */
  async function keepMine(schemeId: string) {
    const item = record(schemeId);
    if (!item) return;
    item.saveConflict = false;
    log("保留本窗口评分草稿", schemes.value.find((scheme) => scheme.id === schemeId)?.code ?? schemeId);
    await flush();
  }

  function setViewer(value: Viewer) { viewer.value = value; }

  /* ---------- 可恢复存档：合并 → 落盘（重试/腾退）→ 失败留内存 ---------- */

  let dirty = false;
  let queued = false;
  let chain: Promise<SaveOutcome | null> = Promise.resolve(null);
  const outerRetryDelays = [5000, 15000, 60000];
  let outerAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function markChanged() {
    dirty = true;
  }

  function currentArchive(): ReviewArchive {
    return {
      version: snapshot.version,
      scores: clone(scores.value.filter((item) => !phantoms.has(item))),
      events: clone(events.value),
      published: published.value,
      schemeStatuses: Object.fromEntries(schemes.value.map((scheme) => [scheme.id, scheme.status]))
    };
  }

  const statusRank: Record<string, number> = { "待评分": 0, "评分中": 1, "已提交": 2, "已锁定": 3 };

  function applyArchive(archive: ReviewArchive) {
    archive.scores.forEach((item) => knownIds.add(item.id));
    scores.value = archive.scores;
    events.value = archive.events;
    published.value = archive.published;
    const statuses = archive.published
      ? Object.fromEntries(schemes.value.map((scheme) => [scheme.id, "已锁定" as const]))
      : archive.schemeStatuses;
    schemes.value.forEach((scheme) => {
      const incoming = statuses[scheme.id];
      if (incoming && statusRank[incoming] > statusRank[scheme.status]) scheme.status = incoming;
    });
  }

  function enqueue(task: () => Promise<SaveOutcome>) {
    chain = chain.then(() => task());
    return chain;
  }

  function scheduleFlush() {
    if (queued) return;
    queued = true;
    // 合并串行执行；同一轮连续修改只落一次盘
    enqueue(async () => {
      queued = false;
      return runPersist();
    });
  }

  function flush(): Promise<SaveOutcome | null> {
    scheduleFlush();
    return chain;
  }

  async function runPersist(): Promise<SaveOutcome> {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    const local = currentArchive();
    // 保存前先读盘：另一个窗口可能已经写入，两边都要留下，撞车则分叉留档
    const disk = readArchive();
    const outcome = mergeArchives(snapshot, local, disk);
    const conflicts = outcome.kind === "fork" ? outcome.conflicts : [];
    lastConflicts.value = conflicts;
    // 合并结果先进入内存：即使落盘失败，数据也不丢
    applyArchive(outcome.archive);
    dirty = false;

    // 当前窗口最近编辑的草稿不参与腾退
    const keepKey = [...outcome.archive.scores]
      .filter((item) => !item.submitted)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id;
    const result = await persistArchive(outcome.archive, keepKey);

    if (result.ok) {
      snapshot = clone(outcome.archive);
      unsaved.value = false;
      outerAttempt = 0;
      return { persisted: true, conflict: conflicts.length > 0, evicted: result.evicted };
    }

    // 仍失败：先留在内存里，按更长节奏自动重试（重试也排在保存队列中，避免与手动保存并发落盘）
    unsaved.value = true;
    const delay = outerRetryDelays[Math.min(outerAttempt, outerRetryDelays.length - 1)];
    outerAttempt += 1;
    enqueue(() => new Promise<SaveOutcome>((resolve) => {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        resolve(runPersist());
      }, delay);
    }));
    return { persisted: false, conflict: conflicts.length > 0 };
  }

  /** 别的窗口写入时触发：本地无改动则直接采用；有改动则走合并落盘，两边都留住 */
  function syncFromStorage() {
    const disk = readArchive();
    if (!dirty && !unsaved.value) {
      snapshot = clone(disk);
      applyArchive(disk);
      return;
    }
    scheduleFlush();
  }

  window.addEventListener("storage", (event) => {
    if (event.key === ARCHIVE_KEY) syncFromStorage();
  });
  window.addEventListener("online", () => { if (unsaved.value) scheduleFlush(); });

  return {
    viewer, schemes, criteria, judges, scores, events, published, ranking, visibleScores,
    isOrganizer, judge, unsaved, lastConflicts,
    setViewer, record, saveDraft, submit, recalled, publish, allSubmittedFor,
    adoptCollision, keepMine
  };
});
