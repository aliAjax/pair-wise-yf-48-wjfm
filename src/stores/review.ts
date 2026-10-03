import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type { Criterion, ReviewEvent, Scheme, ScoreRecord, Viewer } from "../types";
import {
  ARCHIVE_KEY,
  ARCHIVE_VERSION,
  archiveStatus,
  didMigrate,
  loadArchive,
  migrate,
  saveArchive,
  type ArchiveV1,
  type SaveOutcome,
} from "../archive";

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
  return { id: `${judge}-${schemeId}`, judge, schemeId, values: Object.fromEntries(criteria.map((item) => [item.id, 60])), comment: "", submitted: false, conflict: false, updatedAt: new Date().toISOString() };
}

export const useReviewStore = defineStore("review", () => {
  const initial = loadArchive();
  const viewer = ref<Viewer>("评委-林策");
  const schemes = ref<Scheme[]>(seedSchemes.map((scheme) => ({ ...scheme, status: initial.schemeStatuses?.[scheme.id] ?? scheme.status })));
  const scores = ref<ScoreRecord[]>(initial.scores ?? []);
  const events = ref<ReviewEvent[]>(initial.events ?? []);
  const published = ref<boolean>(initial.published ?? false);

  /** 本窗口上次同步时各项的 updatedAt，用于撞车检测 */
  const syncedAt = ref<Record<string, string>>(Object.fromEntries(scores.value.map((item) => [item.id, item.updatedAt])));
  /** 最近一次撞车（其他窗口改过同一项），用于提示并留住草稿 */
  const lastConflict = ref<{ id: string } | null>(null);
  /** 最近一次保存腾退的旧流水条数 */
  const lastEvicted = ref<number>(0);

  const isOrganizer = computed(() => viewer.value === "主办方");
  const judge = computed(() => viewer.value.startsWith("评委-") ? viewer.value : null);
  const visibleScores = computed(() => isOrganizer.value ? scores.value : scores.value.filter((score) => score.judge === judge.value));

  function log(action: string, detail: string) {
    events.value.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor: viewer.value, action, detail });
  }

  function findScore(schemeId: string): ScoreRecord | null {
    const currentJudge = judge.value;
    if (!currentJudge) return null;
    return scores.value.find((score) => score.judge === currentJudge && score.schemeId === schemeId) ?? null;
  }

  function record(schemeId: string) {
    const currentJudge = judge.value;
    if (!currentJudge) return null;
    let item = scores.value.find((score) => score.judge === currentJudge && score.schemeId === schemeId);
    if (!item) {
      item = emptyScore(currentJudge, schemeId);
      scores.value.push(item);
    }
    return item;
  }

  /** 由评分与锁定状态重算方案状态（只升不降的语义在合并层保证）。 */
  function recomputeStatuses() {
    for (const scheme of schemes.value) {
      if (published.value) { scheme.status = "已锁定"; continue; }
      const rows = scores.value.filter((score) => score.schemeId === scheme.id);
      scheme.status = rows.length === 0 ? "待评分" : rows.every((score) => score.submitted) ? "已提交" : "评分中";
    }
  }

  function buildArchive(): ArchiveV1 {
    return {
      version: ARCHIVE_VERSION,
      savedAt: new Date().toISOString(),
      scores: scores.value.map((score) => ({ ...score })),
      events: events.value.map((event) => ({ ...event })),
      published: published.value,
      schemeStatuses: Object.fromEntries(schemes.value.map((scheme) => [scheme.id, scheme.status]))
    };
  }

  /** 保存当前状态到存档层：自动重试、容量腾退、失败留内存、撞车留住草稿。 */
  function persist(): SaveOutcome {
    const outcome = saveArchive(buildArchive(), { baseTimestamps: syncedAt.value });
    lastEvicted.value = outcome.evicted;
    if (outcome.ok) {
      const merged = outcome.merged;
      const conflictIds = new Set(outcome.conflicts.map((item) => item.id));
      const localById = new Map(scores.value.map((score) => [score.id, score]));
      // 事件流水与全局状态采用合并结果；评分保留本窗口草稿（撞车项不回滚当前编辑）。
      events.value = merged.events;
      published.value = merged.published;
      scores.value = merged.scores.map((score) => (conflictIds.has(score.id) ? (localById.get(score.id) ?? score) : score));
      for (const score of scores.value) {
        const conflict = outcome.conflicts.find((item) => item.id === score.id);
        syncedAt.value[score.id] = conflict ? conflict.remote.updatedAt : score.updatedAt;
      }
      recomputeStatuses();
      lastConflict.value = outcome.conflicts.length ? { id: outcome.conflicts[0].id } : null;
    } else {
      // 存档失败：当前状态原样保留在内存中，提示未存档。
      lastConflict.value = outcome.conflicts.length ? { id: outcome.conflicts[0].id } : null;
    }
    return outcome;
  }

  function saveDraft(schemeId: string, values: Record<string, number>, comment: string, conflict: boolean): SaveOutcome | null {
    const item = record(schemeId);
    if (!item || item.submitted) return null;
    item.values = { ...values };
    item.comment = comment;
    item.conflict = conflict;
    item.updatedAt = new Date().toISOString();
    const scheme = schemes.value.find((entry) => entry.id === schemeId);
    log("保存评分草稿", `${scheme?.code ?? schemeId}${conflict ? "，声明利益冲突" : ""}`);
    recomputeStatuses();
    return persist();
  }

  function submit(schemeId: string, values: Record<string, number>, comment: string, conflict: boolean): SaveOutcome | null {
    const item = record(schemeId);
    if (!item) return null;
    item.values = { ...values };
    item.comment = comment;
    item.conflict = conflict;
    item.submitted = true;
    item.updatedAt = new Date().toISOString();
    const scheme = schemes.value.find((entry) => entry.id === schemeId);
    log("提交评分", scheme?.code ?? schemeId);
    recomputeStatuses();
    return persist();
  }

  function recalled(schemeId: string): SaveOutcome | null {
    const item = record(schemeId);
    if (!item || published.value) return null;
    item.submitted = false;
    log("退回评分修改", schemes.value.find((scheme) => scheme.id === schemeId)?.code ?? schemeId);
    recomputeStatuses();
    return persist();
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

  function publish(): SaveOutcome | null {
    if (!schemes.value.every((scheme) => allSubmittedFor(scheme.id))) return null;
    published.value = true;
    log("锁定并发布结果", `${schemes.value.length} 个匿名方案`);
    recomputeStatuses();
    return persist();
  }

  function setViewer(value: Viewer) { viewer.value = value; }

  // 打开存档后由评分与锁定状态重算方案状态，保证与数据一致（兼容旧存档）。
  recomputeStatuses();

  /** 其他窗口写入后同步过来：采用对方评分但不覆盖本窗口正在编辑的草稿。 */
  function onStorage(event: StorageEvent) {
    if (event.key !== ARCHIVE_KEY || !event.newValue) return;
    let remote: ArchiveV1;
    try {
      remote = migrate(JSON.parse(event.newValue));
    } catch {
      return;
    }
    for (const remoteScore of remote.scores) {
      const baseTs = syncedAt.value[remoteScore.id] ?? "";
      const local = scores.value.find((score) => score.id === remoteScore.id);
      const localDirty = !!local && local.updatedAt > baseTs;
      if (!localDirty) {
        const idx = scores.value.findIndex((score) => score.id === remoteScore.id);
        if (idx >= 0) scores.value[idx] = { ...remoteScore };
        else scores.value.push({ ...remoteScore });
        syncedAt.value[remoteScore.id] = remoteScore.updatedAt;
      }
    }
    const have = new Set(events.value.map((item) => item.id));
    for (const remoteEvent of remote.events) {
      if (!have.has(remoteEvent.id)) {
        events.value.unshift(remoteEvent);
        have.add(remoteEvent.id);
      }
    }
    if (remote.published) published.value = true;
    recomputeStatuses();
  }

  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);

  return {
    viewer, schemes, criteria, judges, scores, events, published, ranking, visibleScores, isOrganizer, judge,
    archiveStatus, didMigrate, lastConflict, lastEvicted,
    setViewer, findScore, record, saveDraft, submit, recalled, publish, allSubmittedFor
  };
});
