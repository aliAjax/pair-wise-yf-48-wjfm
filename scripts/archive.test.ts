import assert from "node:assert";

// ---- fake localStorage with a quota that triggers after N events ----
function makeStorage(maxEvents: number) {
  const store = new Map<string, string>();
  const log: string[] = [];
  return {
    store,
    log,
    getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
    setItem(k: string, v: string) {
      log.push(v);
      const data = JSON.parse(v);
      if (maxEvents < 0 || (data.events?.length ?? 0) > maxEvents) {
        const e = new Error("quota");
        (e as any).name = "QuotaExceededError";
        (e as any).code = 22;
        throw e;
      }
      store.set(k, v);
    },
    removeItem(k: string) { store.delete(k); },
    clear() { store.clear(); },
  };
}

const storage = makeStorage(30);
(globalThis as any).localStorage = storage;

const {
  ARCHIVE_VERSION, loadArchive, saveArchive, mergeArchives, migrate, emptyArchive, archiveStatus,
} = await import("../src/archive");

let passed = 0;
function ok(name: string, cond: boolean) {
  assert.ok(cond, name);
  passed++;
  console.log("  ✓", name);
}

const score = (id: string, judge: string, schemeId: string, updatedAt: string, submitted = false, comment = "草稿") => ({
  id, judge, schemeId, values: { site: 80 }, comment, submitted, conflict: false, updatedAt,
});
const event = (id: string, time: string) => ({ id, time, actor: "评委-林策", action: "x", detail: "" });

// 1. 旧版本数据：无版本号也能兼容读取，草稿与锁定结果保留
{
  const legacy = { scores: [score("j-a", "评委-林策", "a", "2026-01-01T00:00:00Z")], events: [], published: true, schemeStatuses: { a: "已锁定" } };
  storage.clear();
  storage.setItem("pair-wise-yf-48/review", JSON.stringify(legacy));
  const a = loadArchive();
  ok("旧数据带出版本号", a.version === ARCHIVE_VERSION);
  ok("旧草稿仍读得出", a.scores.length === 1 && a.scores[0].comment === "草稿");
  ok("旧锁定结果仍读得出", a.published === true && a.schemeStatuses.a === "已锁定");
}

// 2. 正常保存：成功并标记已存档
{
  storage.clear();
  archiveStatus.value = "unknown";
  const a = emptyArchive();
  a.scores.push(score("j-a", "评委-林策", "a", "2026-02-01T00:00:00Z"));
  const out = saveArchive(a);
  ok("正常保存返回 ok", out.ok === true && out.archived === true);
  ok("状态为已存档", archiveStatus.value === "archived");
  const written = JSON.parse(storage.getItem("pair-wise-yf-48/review")!);
  ok("写入数据带版本号", written.version === ARCHIVE_VERSION && written.scores.length === 1);
}

// 3. 容量不足：分批腾退旧流水后重试成功；已提交评分与锁定结果不参与腾退
{
  storage.clear();
  archiveStatus.value = "unknown";
  const a = emptyArchive();
  a.scores.push(score("draft-a", "评委-林策", "a", "2026-02-01T00:00:00Z", false));
  a.scores.push(score("sub-b", "评委-周筑", "b", "2026-02-01T00:00:00Z", true));
  a.published = true;
  a.events = Array.from({ length: 100 }, (_, i) => event(`e${i}`, `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`));
  const out = saveArchive(a);
  ok("腾退后保存成功", out.ok === true);
  ok("腾退了旧流水", out.evicted > 0);
  const written = JSON.parse(storage.getItem("pair-wise-yf-48/review")!);
  ok("已提交评分未被腾退", written.scores.some((s: any) => s.id === "sub-b" && s.submitted === true));
  ok("草稿未被腾退", written.scores.some((s: any) => s.id === "draft-a"));
  ok("锁定结果未被腾退", written.published === true);
  ok("流水已减少", written.events.length < 100);
}

// 4. 容量不足且无流水可腾退：留内存并提示未存档
{
  storage.clear();
  archiveStatus.value = "unknown";
  const tight = makeStorage(-1); // 任何写入都因容量失败
  (globalThis as any).localStorage = tight;
  const a = emptyArchive();
  a.scores.push(score("j-a", "评委-林策", "a", "2026-02-01T00:00:00Z"));
  a.events = [event("e1", "2026-01-01T00:00:00Z")];
  const out = saveArchive(a);
  ok("失败时 ok=false", out.ok === false && out.archived === false);
  ok("失败原因为容量", out.reason === "quota");
  ok("状态为未存档(内存)", archiveStatus.value === "memory");
  ok("草稿仍保留在返回副本中", out.merged.scores.some((s: any) => s.id === "j-a"));
  (globalThis as any).localStorage = storage;
}

// 5. 非容量错误：自动重试后仍失败 → 内存兜底
{
  storage.clear();
  archiveStatus.value = "unknown";
  const broken = {
    getItem: () => null,
    setItem: () => { const e = new Error("denied"); (e as any).name = "SecurityError"; throw e; },
    removeItem: () => {}, clear: () => {},
  };
  (globalThis as any).localStorage = broken;
  const out = saveArchive(emptyArchive());
  ok("非容量错误也兜底到内存", out.ok === false && archiveStatus.value === "memory");
  (globalThis as any).localStorage = storage;
}

// 6. 合并：不同项两个窗口都留下
{
  const remote = emptyArchive();
  remote.scores.push(score("j-a", "评委-林策", "a", "2026-03-01T00:00:00Z"));
  const local = emptyArchive();
  local.scores.push(score("j-b", "评委-林策", "b", "2026-03-02T00:00:00Z"));
  const { merged, conflicts } = mergeArchives(remote, local, { "j-a": "2026-03-01T00:00:00Z" });
  ok("不同项都留下", merged.scores.length === 2);
  ok("无撞车", conflicts.length === 0);
}

// 7. 合并：同一项撞车 → 共享存档留对方版本，当前窗口草稿由调用方留住
{
  const remote = emptyArchive();
  remote.scores.push(score("j-a", "评委-林策", "a", "2026-03-02T00:00:00Z", false, "对方窗口的意见"));
  const local = emptyArchive();
  local.scores.push(score("j-a", "评委-林策", "a", "2026-03-03T00:00:00Z", false, "本窗口的意见"));
  const { merged, conflicts } = mergeArchives(remote, local, { "j-a": "2026-03-01T00:00:00Z" });
  ok("检测到撞车", conflicts.length === 1 && conflicts[0].id === "j-a");
  ok("共享存档保留先写入版本", merged.scores.find((s) => s.id === "j-a")!.comment === "对方窗口的意见");
  ok("本窗口草稿可留住", conflicts[0].local.comment === "本窗口的意见");
}

// 8. 合并：本窗口没改、对方改了 → 采用对方，不算撞车
{
  const remote = emptyArchive();
  remote.scores.push(score("j-a", "评委-林策", "a", "2026-03-02T00:00:00Z", false, "对方改的"));
  const local = emptyArchive();
  local.scores.push(score("j-a", "评委-林策", "a", "2026-03-01T00:00:00Z", false, "旧的"));
  const { merged, conflicts } = mergeArchives(remote, local, { "j-a": "2026-03-01T00:00:00Z" });
  ok("采用对方新版本", merged.scores.find((s) => s.id === "j-a")!.comment === "对方改的");
  ok("不算撞车", conflicts.length === 0);
}

// 9. 合并：事件流水按 id 并集，两个窗口的记录都留下
{
  const remote = emptyArchive();
  remote.events = [event("e1", "2026-03-01T00:00:00Z"), event("e2", "2026-03-02T00:00:00Z")];
  const local = emptyArchive();
  local.events = [event("e2", "2026-03-02T00:00:00Z"), event("e3", "2026-03-03T00:00:00Z")];
  const { merged } = mergeArchives(remote, local, {});
  ok("流水并集去重", merged.events.length === 3);
}

console.log(`\n全部通过：${passed} 项`);
