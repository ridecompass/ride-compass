// 出来事1件の処理。担当の実行の知らせは見回りへ、ほかはゲートへ渡し、見回りが起こしたタスクはその場で決め直す（持った。順番待ちを含む）。
// 定時は、時刻が事実になるもの（着手可能日時・利用の上限の止めが解ける）の振り出しと、状況の更新と、時間の経過で変わる決め方（動きの確かめ）の
// きっかけ。見回りは状態を決めず、ユーザーの番でない開いた issue を1件ずつの出来事（recheck）として受け箱に入れ、ゲートに決め直させる。
import { runOf } from "./facts.js";
import { ignored, near, reportHealth, route, settle } from "./gate.js";

export async function handle(gh, { patrol, inbox }, config, name, payload) {
  if (name === "schedule") {
    const sent = await dispatch(gh, patrol, config, [], Object.keys(config.slots), true);
    await reportHealth(gh, config, { stopped: sent.stopped, failed: await inbox.failed() });
    await inbox.clear();
    for (const number of await quiet(gh, config)) await inbox.push("recheck", { number });
    return;
  }
  if (name === "recheck") return dispatch(gh, patrol, config, [await settle(gh, config, payload.number, await patrol.state())], []);
  if (ignored(config, name, payload)) return;
  const w = payload.workflow_run;
  const run = name === "workflow_run" && w.path.endsWith(config.workflow) && runOf(w.display_title);
  if (run) await patrol.observe({ ...run, id: w.id, state: payload.action });
  const { numbers, moved } = run ? { numbers: [run.number] } : await route(gh, config, name, payload);
  const held = await patrol.state();
  const settled = await Promise.all(numbers.map((n) => settle(gh, config, n, held, moved)));
  // ゲートがいま閉じた issue の矢印1本の先も、閉じるものが無くなるまで、振り出す前に決め直す（古いステータスで親を振り出さない）。
  const seen = new Set(numbers);
  for (let wave = settled; wave.length;) {
    const next = [...new Set((await Promise.all(wave.filter((s) => s.closedNow).map((s) => near(gh, config, s.number)))).flat())].filter((n) => !seen.has(n));
    next.forEach((n) => seen.add(n));
    wave = await Promise.all(next.map((n) => settle(gh, config, n, held)));
    settled.push(...wave);
  }
  await dispatch(gh, patrol, config, settled, run && payload.action === "completed" ? [run.kind] : []);
}

async function dispatch(gh, patrol, config, settled, kinds, always) {
  const sent = await patrol.dispatch(gh, config, settled, kinds, always);
  const held = await patrol.state();
  await Promise.all(sent.picked.map((p) => settle(gh, config, p.number, held)));
  return sent;
}

// 動きを確かめ直す issue: ユーザーの番でない開いた issue のうち、issue が設定の時間（stallHours）更新されていないもの（それより新しければ、
// 止まったとは決まらない。PR の動きは issue の更新に出ないので、ここで除いたものはゲートが PR まで読んで決める）。
async function quiet(gh, config) {
  const before = new Date(Date.now() - config.stallHours * 3600e3).toISOString().slice(0, 19);
  const q = encodeURIComponent(`repo:${config.tasks} is:issue is:open -assignee:${config.user} updated:<${before}`);
  const numbers = [];
  for (let page = 1; ; page++) {
    const { items } = await gh.rest("GET", `/search/issues?q=${q}&per_page=100&page=${page}`);
    numbers.push(...items.map((i) => i.number));
    if (items.length < 100) return numbers;
  }
}
