<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { NAlert, NButton, NCard, NInput, NProgress, NRate, NSwitch, NTag, useMessage } from "naive-ui";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useReviewStore } from "../stores/review";
import type { StashedScore } from "../types";

const store = useReviewStore();
const message = useMessage();
const selectedId = defineModel<string>("selectedId", { default: "a" });
const selected = computed(() => store.schemes.find((item) => item.id === selectedId.value) ?? store.schemes[0]);
const currentScore = computed(() => store.record(selected.value.id));
const defaults = () => Object.fromEntries(store.criteria.map((item) => [item.id, 60])) as Record<string, number>;
const form = reactive({ values: defaults(), comment: "", conflict: false });
const formDirty = computed(() => JSON.stringify(form.values) !== JSON.stringify(currentScore.value?.values ?? defaults()) || form.comment !== (currentScore.value?.comment ?? "") || form.conflict !== (currentScore.value?.conflict ?? false));
const schema = toTypedSchema(z.object({ comment: z.string().min(4, "请至少填写4个字的评审意见") }));
const { errors, validate } = useForm({ validationSchema: schema });

function hydrate() {
  const record = currentScore.value;
  form.values = { ...(record?.values ?? defaults()) };
  form.comment = record?.comment ?? "";
  form.conflict = record?.conflict ?? false;
}

watch(selectedId, hydrate, { immediate: true });

// 另一个窗口改了同一项且已合并（未撞车）：表单干净时直接呈现最新内容
watch(() => currentScore.value?.updatedAt, () => {
  if (!formDirty.value && !currentScore.value?.saveConflict) hydrate();
});

const weighted = computed(() => store.criteria.reduce((sum, item) => sum + form.values[item.id] * item.weight / 100, 0));
const disabled = computed(() => store.isOrganizer || currentScore.value?.submitted || store.published);
const collision = computed(() => currentScore.value?.saveConflict ? currentScore.value : null);

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
async function persistWithFeedback(action: () => Promise<{ persisted: boolean; conflict: boolean; evicted?: { scores: number; events: number } } | null>, okText: string) {
  const result = await action();
  if (!result) return;
  if (!result.persisted) {
    message.warning("存档暂时失败，评分已留在本窗口内存中，将自动重试，请勿关闭页面");
    return;
  }
  if (result.evicted && (result.evicted.scores || result.evicted.events)) {
    message.info(`存档容量不足，已腾退 ${result.evicted.scores} 条旧草稿、${result.evicted.events} 条旧流水后保存成功`);
  }
  if (result.conflict) {
    message.warning("与另一窗口的保存撞车，对方版本已留档，请在冲突提示中选择保留哪一版");
    return;
  }
  message.success(okText);
}

function draft() {
  void persistWithFeedback(() => store.saveDraft(selected.value.id, form.values, form.comment, form.conflict), "评分草稿已保存到本地");
}
async function submit() {
  const result = await validate({ values: form } as any);
  if (!result.valid) return;
  await persistWithFeedback(() => store.submit(selected.value.id, form.values, form.comment, form.conflict), "匿名评分已提交");
}
async function adopt(stashed: StashedScore) {
  const adopted = await store.adoptCollision(selected.value.id, stashed);
  if (adopted) {
    form.values = { ...adopted.values };
    form.comment = adopted.comment;
    form.conflict = adopted.conflict;
    message.success("已采用另一窗口的版本，可在此基础上继续修改后保存");
  }
}
async function keepMine() {
  await store.keepMine(selected.value.id);
  message.success("已保留本窗口草稿，对方版本仍在留档中可查");
}
</script>

<template>
  <NAlert v-if="store.isOrganizer" type="info" show-icon>主办方在结果锁定前不能查看任何评委的评分值。</NAlert>
  <NAlert v-if="store.unsaved" type="error" show-icon style="margin-top:10px">当前评分<strong>尚未存档</strong>，已暂存在本窗口内存中并会自动重试；请保留本页面不要关闭，恢复后将自动写入。</NAlert>
  <div class="workspace">
    <NCard title="匿名方案" class="scheme-panel"><button v-for="item in store.schemes" :key="item.id" class="scheme" :class="{ active: selectedId === item.id }" @click="selectedId = item.id"><span>{{ item.code }}</span><b>{{ item.title }}</b><small>{{ item.publicNo }} · {{ item.status }}</small><small v-if="store.scores.some((score) => score.schemeId === item.id && score.judge === store.judge && score.saveConflict)" style="color:#d48806;font-weight:700">存在保存冲突</small></button></NCard>
    <NCard class="score-panel">
      <template #header><div class="card-title"><div><small>{{ selected.code }} · {{ selected.publicNo }}</small><h2>{{ selected.title }}</h2></div><NTag :type="selected.status === '已锁定' ? 'success' : 'warning'">{{ selected.status }}</NTag></div></template>
      <p class="synopsis">{{ selected.synopsis }}</p>
      <NAlert v-if="collision" type="warning" show-icon title="同一项在两个窗口同时保存，内容撞车">
        <div class="collision-box">
          <p>本窗口的版本已作为草稿保留（下方表单内容，{{ formatTime(collision.updatedAt) }} 保存）。另一个窗口的版本已全部留档，不会丢失，请核对后选择：</p>
          <div v-for="stashed in collision.collisions ?? []" :key="stashed.updatedAt" class="collision-row">
            <div><b>另一窗口版本</b><small>{{ formatTime(stashed.updatedAt) }} 保存{{ stashed.submitted ? " · 对方已提交" : "" }}；加权 {{ store.criteria.reduce((sum, item) => sum + stashed.values[item.id] * item.weight / 100, 0).toFixed(1) }}</small><p v-if="stashed.comment">“{{ stashed.comment }}”</p></div>
            <NButton size="small" :disabled="disabled || stashed.submitted" @click="adopt(stashed)">采用此版本</NButton>
          </div>
          <div class="collision-actions"><NButton size="small" type="primary" :disabled="disabled" @click="keepMine">保留我的草稿</NButton><small v-if="(collision.collisions ?? []).some((item) => item.submitted)">对方版本已提交时，采用按钮不可用；如需以草稿覆盖，请联系主办方退回后再处理。</small></div>
        </div>
      </NAlert>
      <div class="criteria">
        <article v-for="item in store.criteria" :key="item.id"><div><b>{{ item.name }}</b><span>权重 {{ item.weight }}%</span><p>{{ item.description }}</p></div><NRate v-model:value="form.values[item.id]" :count="5" :disabled="disabled" /><small>{{ form.values[item.id] }} / {{ item.max }}</small></article>
      </div>
      <div class="weighted"><span>加权得分</span><NProgress type="line" :percentage="weighted" :height="18" /><b>{{ weighted.toFixed(1) }}</b></div>
      <label class="conflict-switch"><NSwitch v-model:value="form.conflict" :disabled="disabled" /><span><b>声明利益冲突</b><small>声明后本评分不计入最终排名</small></span></label>
      <label class="field"><span>评审意见（评委间不可见）</span><NInput v-model:value="form.comment" type="textarea" :disabled="disabled" placeholder="填写对方案的具体意见" /><small>{{ errors.comment }}</small></label>
      <div class="actions"><NButton :disabled="disabled" @click="draft">保存草稿</NButton><NButton type="primary" :disabled="disabled" @click="submit">提交本方案评分</NButton><NButton v-if="currentScore?.submitted && !store.published" quaternary @click="store.recalled(selected.id)">退回修改</NButton></div>
    </NCard>
  </div>
</template>
