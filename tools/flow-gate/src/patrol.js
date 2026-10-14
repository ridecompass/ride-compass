// 見回り（tasks#788・#843）: 振り出しを頼むだけで、実行の記録は持たない。枠が埋まっているか・動いているかは、その都度 GitHub の担当の実行の
// 一覧（src/facts.js: recentRuns）から読む。
import { dispatchKind } from "./decide.js";
import { jstText, relationsOf, taskOf } from "./facts.js";
import { FIELDS } from "./fields.js";
import { settle } from "./gate.js";
import { pages } from "./github.js";

// 置き場の開いた issue（1件を決め直すときと同じ読み方で組む）。定時は、振り出しと決め直す番号の列挙の両方にこの1回を使う（src/flow.js: handle）。
export async function openTasks(gh, config) {
  const { owner: o, name: n } = config.repos.tasks;
  const issues = await Array.fromAsync(pages(gh, `query($o:String!,$n:String!,$a:String){repository(owner:$o,name:$n){issues(states:OPEN,first:100,after:$a){pageInfo{hasNextPage endCursor}
    nodes{number state issueType{name} labels(first:20){nodes{name}} assignees(first:10){nodes{login}} ${FIELDS} ${relationsOf()}}}}}`, { o, n }, (d) => d.repository.issues));
  return issues.map((i) => ({ ...taskOf(config, i), number: i.number }));
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
  return jobs.some((j) => j.steps.some((s) => s.name === config.quotaStep && s.conclusion === "failure"))
    ? `担当が Claude の利用の上限か認証で止まったため、${jstText(until)} まで（担当を1件手で起こせば早く戻る）` : null;
}
// 枠に空きがあり、止めていなければ、振り出せるタスクを急ぎ・優先度の順に枠の数まで振り出す。settled は決め直したばかりの
// タスク、kinds は空きを検証担当の種類（定時と、担当が終わったとき）。runs は出来事1件につき1回読んだ担当の実行の一覧、tasks は
// 同じ出来事で読んだ開いた issue の一覧（無ければ、振り出すときだけ読む）。
export async function dispatch(gh, config, settled, kinds, runs, tasks = null) {
  const active = runs.filter((r) => r.active);
  const wanted = [...new Set([...kinds, ...settled.map((t) => dispatchKind(t)).filter(Boolean)])];
  const free = Object.fromEntries(wanted.map((kind) => [kind, config.slots[kind] - active.filter((r) => r.kind === kind).length]));
  if (!Object.values(free).some((n) => n > 0) || (await stopReason(gh, config, runs))) return;
  const open = (tasks ?? (await openTasks(gh, config))).map((t) => ({ ...t, runs: active.filter((r) => r.number === t.number) }));
  const rank = (t) => config.priorities.indexOf(t.priority ?? config.unsetPriority);
  const picked = Object.keys(free).flatMap((kind) => open.filter((t) => dispatchKind(t) === kind)
    .sort((a, b) => b.urgent - a.urgent || rank(a) - rank(b) || a.number - b.number)
    .slice(0, Math.max(0, free[kind])).map((t) => ({ number: t.number, kind, key: `${t.number}-${Date.now()}` })));
  // 一覧のステータスは前に決めた値で、決め直しの前に事実が動いている（問いを出した直後の実装・master が進んでぶつかった PR 等）。この出来事で
  // 決め直していないものは、起こす前に今の事実で決め直し、同じ担当がまだ要るものだけを起こす。外れた枠は次の出来事か定時が埋める。
  const fresh = await Promise.all(picked.map(async (p) => settled.some((t) => t.number === p.number)
    || dispatchKind(await settle(gh, config, p.number, runs)) === p.kind));
  const results = await Promise.allSettled(picked.filter((_, i) => fresh[i]).map((p) => gh.rest("POST", `/repos/${config.code}/actions/workflows/${config.workflow}/dispatches`,
    { ref: config.base, inputs: { issue: String(p.number), kind: p.kind, key: p.key } })));
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
}
