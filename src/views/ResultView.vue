<script setup lang="ts">
import { NAlert, NButton, NCard, NEmpty, NTable, NTag, useMessage } from "naive-ui";
import { useReviewStore } from "../stores/review";
const store = useReviewStore();
const message = useMessage();
const columns = [
  { title: "名次", key: "rank", width: 70 },
  { title: "匿名编号", key: "code" },
  { title: "方案", key: "title" },
  { title: "有效评委", key: "judgeCount" },
  { title: "利益冲突", key: "conflicts" },
  { title: "加权总分", key: "total" }
];
function publish() {
  const complete = store.schemes.every((scheme) => store.allSubmittedFor(scheme.id));
  if (!complete) { message.warning("仍有评委未提交，不能锁定结果"); return; }
  const outcome = store.publish();
  if (!outcome) { message.warning("当前状态不可锁定结果"); return; }
  if (!outcome.ok) { message.warning("存档失败：已自动重试仍未写入，锁定结果先保留在内存中（未存档），请清理空间后重试"); return; }
  if (outcome.evicted > 0) { message.success(`评分结果已锁定发布（容量不足，已腾退 ${outcome.evicted} 条旧流水后存档）`); return; }
  message.success("评分结果已锁定发布");
}
</script>
<template>
  <NAlert v-if="!store.published" type="warning" show-icon>结果尚未锁定。为避免影响独立判断，主办方当前只能看到提交进度。</NAlert>
  <NAlert v-if="store.archiveStatus === 'memory'" type="error" show-icon>当前无法写入本地存储，结果仅保留在内存中（未存档），刷新或重开将丢失。</NAlert>
  <NAlert v-if="store.didMigrate" type="info" show-icon>已兼容打开旧版存档：原有草稿与锁定结果均已保留，并补充版本信息。</NAlert>
  <div class="result-grid">
    <NCard title="提交进度"><article v-for="scheme in store.schemes" :key="scheme.id" class="progress-row"><div><b>{{ scheme.code }} {{ scheme.title }}</b><small>{{ store.judges.filter((judge) => store.scores.some((score) => score.schemeId === scheme.id && score.judge === judge && score.submitted)).length }} / {{ store.judges.length }} 已提交</small></div><NTag :type="store.allSubmittedFor(scheme.id) ? 'success' : 'warning'">{{ store.allSubmittedFor(scheme.id) ? "齐备" : "待提交" }}</NTag></article></NCard>
    <NCard title="评分纪律"><div class="discipline"><p>评委只能查看自己的评分，主办方在锁定前无法读取分值。</p><p>存在利益冲突的评分保留审计记录，但不参与最终排名。</p><p>评分提交后可由评委主动退回，结果锁定后不可修改。</p></div><NButton type="primary" block :disabled="store.published" @click="publish">锁定并发布结果</NButton></NCard>
  </div>
  <NCard title="最终排名" class="ranking"><NEmpty v-if="!store.published" description="锁定后查看最终排名" /><NTable v-else :columns="columns" :data="store.ranking.map((item, index) => ({ ...item, rank: index + 1 }))" :bordered="false" /></NCard>
</template>
