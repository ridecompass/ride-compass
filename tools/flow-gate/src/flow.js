// 出来事1件の処理。出来事が指す issue をゲートが決め直し、見回りが振り出す（振り出したタスクは、実行の始まりの知らせで決め直す）。
// 定時は、時刻が事実になるもの（着手可能日時・利用の上限の止めが解ける）の振り出しと、取りこぼした出来事の直し（ユーザーの番でない開いた
// issue を1件ずつの出来事（recheck）として受け箱に入れ、ゲートに決め直させる。見回りは状態を決めない）。
import { recentRuns, runOf } from "./facts.js";
import { ignored, route, settle } from "./gate.js";
import { dispatch, openTasks } from "./patrol.js";

export async function handle(gh, { inbox }, config, name, payload) {
  if (name === "schedule") {
    // 担当の実行の一覧と開いた issue の一覧は、定時の1回につき1回ずつ読み、振り出しと決め直しの両方に使う（持ち続けない）。
    const [runs, tasks] = await Promise.all([recentRuns(gh, config), openTasks(gh, config)]);
    await dispatch(gh, config, [], Object.keys(config.slots), runs, tasks);
    // 前の回の決め直しがまだ受け箱に残っていれば、重ねて入れない。ユーザーの番のものは、ユーザーの出来事で決め直す。
    const queued = new Set((await inbox.pending("recheck")).map((p) => p.number));
    for (const t of tasks) if (!t.assignees.includes(config.user) && !queued.has(t.number)) await inbox.push("recheck", { number: t.number });
    return;
  }
  if (name === "recheck") {
    const runs = await recentRuns(gh, config);
    return dispatch(gh, config, [await settle(gh, config, payload.number, runs)], [], runs);
  }
  if (ignored(config, name, payload)) return;
  const w = payload.workflow_run;
  const run = name === "workflow_run" && w.path.endsWith(config.workflow) && runOf(w.display_title);
  const { numbers, moved, around } = run ? { numbers: [run.number] } : await route(gh, config, name, payload);
  if (!numbers.length) return; // 担当でないワークフローの出来事等。実行の一覧も読まない
  const runs = await recentRuns(gh, config);
  const settled = await Promise.all(numbers.map((n) => settle(gh, config, n, runs, moved)));
  // 出来事が矢印の先も指す issue（around）と、ゲートがいま閉じた issue の矢印1本の先も、閉じるものが無くなるまで、振り出す前に決め直す
  // （古いステータスで親を振り出さない）。先の番号は、決め直しで読んだ事実にある。
  const seen = new Set(numbers);
  const spreads = (s) => s.closedNow || (around && numbers.includes(s.number));
  for (let wave = settled; wave.length;) {
    const next = [...new Set(wave.filter(spreads).flatMap((s) => s.near))].filter((n) => !seen.has(n));
    next.forEach((n) => seen.add(n));
    wave = await Promise.all(next.map((n) => settle(gh, config, n, runs)));
    settled.push(...wave);
  }
  await dispatch(gh, config, settled, run && payload.action === "completed" ? [run.kind] : [], runs);
}
