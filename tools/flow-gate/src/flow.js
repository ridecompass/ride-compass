// 出来事1件の処理。出来事が指す issue をゲートが決め直し、見回りが振り出す（振り出したタスクは、実行の始まりの知らせで決め直す）。
// 定時は、時刻が事実になるもの（着手可能日時・利用の上限の止めが解ける）の振り出しと、取りこぼした出来事の直し（ユーザーの番でない開いた
// issue を1件ずつの出来事（recheck）として受け箱に入れ、ゲートに決め直させる。見回りは状態を決めない）。
import { recentRuns, runOf } from "./facts.js";
import { ignored, near, route, settle } from "./gate.js";
import { dispatch } from "./patrol.js";

export async function handle(gh, { inbox }, config, name, payload) {
  if (name === "schedule") {
    // 担当の実行の一覧は、出来事1件につき1回読み、その出来事の決め直しと振り出しに渡す（持ち続けない）。
    await dispatch(gh, config, [], Object.keys(config.slots), await recentRuns(gh, config));
    // 前の回の決め直しがまだ受け箱に残っていれば、重ねて入れない。
    const queued = new Set((await inbox.pending("recheck")).map((p) => p.number));
    for (const number of await mine(gh, config)) if (!queued.has(number)) await inbox.push("recheck", { number });
    return;
  }
  if (name === "recheck") {
    const runs = await recentRuns(gh, config);
    return dispatch(gh, config, [await settle(gh, config, payload.number, runs)], [], runs);
  }
  if (ignored(config, name, payload)) return;
  const w = payload.workflow_run;
  const run = name === "workflow_run" && w.path.endsWith(config.workflow) && runOf(w.display_title);
  const { numbers, moved } = run ? { numbers: [run.number] } : await route(gh, config, name, payload);
  if (!numbers.length) return; // 担当でないワークフローの出来事等。実行の一覧も読まない
  const runs = await recentRuns(gh, config);
  const settled = await Promise.all(numbers.map((n) => settle(gh, config, n, runs, moved)));
  // ゲートがいま閉じた issue の矢印1本の先も、閉じるものが無くなるまで、振り出す前に決め直す（古いステータスで親を振り出さない）。
  const seen = new Set(numbers);
  for (let wave = settled; wave.length;) {
    const next = [...new Set((await Promise.all(wave.filter((s) => s.closedNow).map((s) => near(gh, config, s.number)))).flat())].filter((n) => !seen.has(n));
    next.forEach((n) => seen.add(n));
    wave = await Promise.all(next.map((n) => settle(gh, config, n, runs)));
    settled.push(...wave);
  }
  await dispatch(gh, config, settled, run && payload.action === "completed" ? [run.kind] : [], runs);
}

// 定時に決め直す issue: ユーザーの番でない開いた issue の全部（取りこぼした出来事で止まったものを直す。issue の更新の時刻はゲート自身の書き込みでも進むので、それで絞らない）。
async function mine(gh, config) {
  const q = encodeURIComponent(`repo:${config.tasks} is:issue is:open -assignee:${config.user}`);
  const numbers = [];
  for (let page = 1; ; page++) {
    const { items } = await gh.rest("GET", `/search/issues?q=${q}&per_page=100&page=${page}`);
    numbers.push(...items.map((i) => i.number));
    if (items.length < 100) return numbers;
  }
}
