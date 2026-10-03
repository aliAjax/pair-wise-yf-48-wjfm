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
async function publish() {
  const complete = store.schemes.every((scheme) => store.allSubmittedFor(scheme.id));
  if (!complete) { message.warning("仍有评委未提交，不能锁定结果"); return; }
  const result = await store.publish();
  if (!result) return;
  if (!result.persisted) {
    message.warning("锁定结果尚未存档，已留在内存中自动重试；请保持页面打开");
    return;
  }
  if (result.evicted && (result.evicted.scores || result.evicted.events)) {
    message.info(`存档容量不足，已腾退 ${result.evicted.scores} 条旧草稿、${result.evicted.events} 条旧流水`);
  }
  message.success("评分结果已锁定发布");
}
</script>
<template>
  <NAlert v-if="store.unsaved" type="error" show-icon style="margin-bottom:14px">部分评分或锁定结果<strong>尚未写入本地存档</strong>，正暂存内存并自动重试；请勿关闭页面。</NAlert>
  <NAlert v-if="!store.published" type="warning" show-icon>结果尚未锁定。为避免影响独立判断，主办方当前只能看到提交进度。</NAlert>
  <div class="result-grid">
    <NCard title="提交进度"><article v-for="scheme in store.schemes" :key="scheme.id" class="progress-row"><div><b>{{ scheme.code }} {{ scheme.title }}</b><small>{{ store.judges.filter((judge) => store.scores.some((score) => score.schemeId === scheme.id && score.judge === judge && score.submitted)).length }} / {{ store.judges.length }} 已提交</small></div><NTag :type="store.allSubmittedFor(scheme.id) ? 'success' : 'warning'">{{ store.allSubmittedFor(scheme.id) ? "齐备" : "待提交" }}</NTag></article></NCard>
    <NCard title="评分纪律"><div class="discipline"><p>评委只能查看自己的评分，主办方在锁定前无法读取分值。</p><p>存在利益冲突的评分保留审计记录，但不参与最终排名。</p><p>评分提交后可由评委主动退回，结果锁定后不可修改。</p></div><NButton type="primary" block :disabled="store.published" @click="publish">锁定并发布结果</NButton></NCard>
  </div>
  <NCard title="最终排名" class="ranking"><NEmpty v-if="!store.published" description="锁定后查看最终排名" /><NTable v-else :columns="columns" :data="store.ranking.map((item, index) => ({ ...item, rank: index + 1 }))" :bordered="false" /></NCard>
</template>
