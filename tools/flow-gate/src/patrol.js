// 見回り（tasks#788・#843）: 振り出しを頼むだけで、実行の記録は持たない。枠が埋まっているか・動いているかは、その都度 GitHub の担当の実行の
// 一覧（src/facts.js: recentRuns）から読む。
import { DISPATCH } from "./decide.js";
import { jstText, relationsOf, taskOf } from "./facts.js";
import { FIELDS } from "./fields.js";

// 置き場の開いた issue（1件を決め直すときと同じ読み方で組む）。
async function openTasks(gh, config) {
  const [o, n] = config.tasks.split("/");
  const all = [];
  for (let after = null; ;) {
    const r = await gh.gql(`query($o:String!,$n:String!,$a:String){repository(owner:$o,name:$n){issues(states:OPEN,first:100,after:$a){pageInfo{hasNextPage endCursor}
      nodes{number state issueType{name} labels(first:20){nodes{name}} ${FIELDS} ${relationsOf()}}}}}`, { o, n, a: after });
    const page = r.repository.issues;
    all.push(...page.nodes.map((i) => ({ ...taskOf(config, i), number: i.number })));
    if (!page.pageInfo.hasNextPage) return all;
    after = page.pageInfo.endCursor;
  }
}

// 振り出さない理由（無ければ null）。担当のワークフローを無効にしたら止める。最後に終わった担当の実行が Claude の利用の上限・認証で止まって
// いたら（担当のワークフローの段 config.quotaStep が落ちた）、その終わりから pauseMinutes の間止める。runs は recentRuns の一覧。
async function stopReason(gh, config, runs) {
  const wf = await gh.rest("GET", `/repos/${config.code}/actions/workflows/${config.workflow}`);
  if (wf.state !== "active") return "担当のワークフロー（Claude Task）が無効（Actions の画面の Enable workflow で戻す）";
  const last = runs.find((r) => !r.active);
  const until = last?.updated + config.pauseMinutes * 60e3;
  if (last?.conclusion !== "failure" || !(until > Date.now())) return null;
  const { jobs } = await gh.rest("GET", `/repos/${config.code}/actions/runs/${last.id}/jobs`);
  return jobs.some((j) => j.steps?.some((s) => s.name === config.quotaStep && s.conclusion === "failure"))
    ? `担当が Claude の利用の上限か認証で止まったため、${jstText(until)} まで（担当を1件手で起こせば早く戻る）` : null;
}

// 振り出す担当の種類（無ければ null）。待つ相手（前提・子）・未来の着手可能日時・保留の親・対話作業・担当の付いたものは振り出さない。
const dispatchable = (t, config) => (t.open && !t.runs.length && !t.blocked && !t.future && !t.held && t.type !== config.dialogType ? (DISPATCH[t.status] ?? null) : null);

// 枠に空きがあり、止めていなければ、振り出せるタスクを急ぎ・優先度の順に枠の数まで振り出す。settled は決め直したばかりの
// タスク、kinds は空きを確かめる担当の種類（定時と、担当が終わったとき）。runs は出来事1件につき1回読んだ担当の実行の一覧。
export async function dispatch(gh, config, settled, kinds, runs) {
  const active = runs.filter((r) => r.active);
  const wanted = [...new Set([...kinds, ...settled.map((t) => dispatchable(t, config)).filter(Boolean)])];
  const free = Object.fromEntries(wanted.map((kind) => [kind, config.slots[kind] - active.filter((r) => r.kind === kind).length]));
  if (!Object.values(free).some((n) => n > 0) || (await stopReason(gh, config, runs))) return;
  const tasks = (await openTasks(gh, config)).map((t) => ({ ...t, runs: active.filter((r) => r.number === t.number) }));
  const rank = (t) => config.priorities.indexOf(t.priority ?? config.unsetPriority);
  const picked = Object.keys(free).flatMap((kind) => tasks.filter((t) => dispatchable(t, config) === kind)
    .sort((a, b) => b.urgent - a.urgent || rank(a) - rank(b) || a.number - b.number)
    .slice(0, Math.max(0, free[kind])).map((t) => ({ number: t.number, kind, key: `${t.number}-${Date.now()}` })));
  const results = await Promise.allSettled(picked.map((p) => gh.rest("POST", `/repos/${config.code}/actions/workflows/${config.workflow}/dispatches`,
    { ref: config.base, inputs: { issue: String(p.number), kind: p.kind, key: p.key } })));
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
}
