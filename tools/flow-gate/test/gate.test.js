// ゲートを入口から、tasks#788 の要求とユーザーと決めた約束（tasks#799）で確かめる。出来事は受け箱（src/inbox.js: Inbox）に入れて本物と同じ処理
// （src/flow.js: handle）で、回答フォームは HTTP の要求（src/form.js: answerForm）で動かし、ボード・コメント・本文・PR・ラベル・実行・状況の更新を見る。
// 期待は要求の文から書く（各行・各 assert の名前）。GitHub の代わりの world は test/world.js が持つ。待つ相手と完了の場面は gate.family.test.js、
// 問いと回答フォームの場面は gate.answer.test.js が持ち、ここは振り出し・決め直し・担当の実行・受け箱の場面を持つ。
import assert from "node:assert/strict";
import test from "node:test";
import { handle } from "../src/flow.js";
import { GitHub } from "../src/github.js";
import { nextAlarm } from "../src/inbox.js";
import { answerBody, latestQuestion, withButton } from "../src/questions.js"; // 本物のボタンと、ゲートの問いの形を入力に使う
import { config, T, END, world, ev, head, QUESTION, REPLY, ANSWER, CONFIRM, ASKED, said } from "./world.js";

test("R2・R17・R14・K1: 振り出したその場で実装（順番待ちを含む）。同時に届いた出来事でも、1つのタスクに担当は1人で、枠の数まで急ぎ・優先度の順。欄「実行の status」は実行の知らせのとおり", async () => {
  const w = world([{ n: 1, status: "実装", priority: "低" }, { n: 2, status: "実装", labels: [config.urgentLabel] }, { n: 3, status: "実装", priority: "高" },
    { n: 4, status: "実装", blockedBy: [9] }, { n: 5, status: "実装", start: "2099-01-01" }, { n: 9, status: "保留" }]);
  await Promise.all([w.push(ev.schedule()), w.push(ev.schedule()), w.push(ev.comment(1))]);
  await w.inbox.drain(config.retries);
  assert.deepEqual(w.titles().sort(), ["#2 実装", "#3 実装"]);
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => w.at(n).status), ["実装", "実装", "実装", "待機", "待機", "保留"], "待つ相手のあるものは待機");
  assert.deepEqual([w.at(1).run, w.at(2).run], [null, "queued"], "実行が無ければ空、申し込んだ実行は queued");
  await w.send(ev.run(w.run(2), "in_progress"));
  assert.equal(w.at(2).run, "in_progress");
  await w.send(ev.run({ id: 7, display_title: "#2 実装" }, "completed"));
  assert.equal(w.at(2).status, "実装", "別の実行（手で起こした実行）の終わりで、今の担当を手放さない");
  w.at(3).comments.push(END(0));
  await w.send(ev.run(w.run(3), "completed"));
  await w.send(ev.run(w.run(3), "in_progress"));
  assert.deepEqual([w.at(3).status, said(w.at(3)), w.at(3).run], ["回答", "## 問い（イレギュラー）", null], "終わったあとに届いた始まりの知らせで持ち直さない");
});

test("R3・決め1・決め7・#760: 担当の実行が終わったら、表の上から最初に当たる行で決める。状態も約束も動かさずに終えた担当だけがイレギュラー", async () => {
  const verify = { status: "検証", pr: { draft: false, checks: "SUCCESS" } };
  const merged = { state: "MERGED", merged: true };
  const rows = [
    // [要求, 始まりのタスク, 終わったときの事実（moved はその実行で約束が動いたか）, ステータス, 起きた担当の数, 最後のゲートのコメントの頭]
    ["R3a 答えの無い問い", {}, { comments: [QUESTION] }, "回答", 1, "## 問い（判断）"],
    ["R3b 下書きの PR の検査が終わっていない", {}, { pr: { draft: true, checks: "PENDING" } }, "検査", 1, null],
    ["実装担当が、検査の出ない PR を出して手放した（検査の持ち主がいない）→ イレギュラー", {}, { pr: { draft: true } }, "回答", 1, "## 問い（イレギュラー）"],
    ["R3c 下書きでない PR の検査が通った → 検証 → 検証担当", {}, { pr: { draft: false, checks: "SUCCESS" } }, "検証", 2, null],
    ["R3c 説明文を書き直して同じコミットで検査を打ち直した → 最も新しい実行の結論で決める", {}, { pr: { draft: false, checks: "SUCCESS", checksBefore: ["CANCELLED"] } }, "検証", 2, null],
    ["R3b 前の検査の実行が通っても、打ち直した実行が走っている間は検査", {}, { pr: { draft: true, checks: "PENDING", checksBefore: ["SUCCESS"] } }, "検査", 1, null],
    ["R3d 検証担当が下書きへ戻した（差し戻し）→ 実装担当", verify, { pr: { draft: true, checks: "SUCCESS", drafted: true } }, "実装", 2, null],
    ["検証担当が、マージも差し戻しも問いもせずに手放した → イレギュラー", verify, {}, "回答", 1, "## 問い（イレギュラー）"],
    ["R3e 条件が全部済んだ → 完成で閉じる", {}, { body: "- [x] 作る\n" }, "完了", 1, null],
    ["R3f 残りがユーザーの確かめだけ", {}, { body: CONFIRM }, "回答", 1, "## 問い（確かめ）"],
    ["R3g 開いた前提", {}, { blockedBy: [9] }, "待機", 1, null],
    ["R3g 未来の着手可能日時", {}, { start: "2099-01-01" }, "待機", 1, null],
    ["R3h 状態も約束も動かさずに終えた（落ちた）→ 黙って振り出し直さない", {}, {}, "回答", 1, "## 問い（イレギュラー）"],
    ["#760 約束を兄弟へ移管して終えた（約束が動いた）→ 正当。残りを次の実装担当へ", { body: "- [ ] 作る\n- [ ] 部品\n" },
      { body: "- [ ] 作る\n", made: [{ n: 10, body: "分割元: #1\n- [ ] 部品\n", created: T(5) }] }, "実装", 2, null],
    ["移管先の無い行を消して終えた（約束をなくした）→ イレギュラー", { body: "- [ ] 作る\n- [ ] 部品\n" }, { body: "- [ ] 作る\n" }, "回答", 1, "## 問い（イレギュラー）"],
    ["条件にチェックを付けて終えた（約束が動いた）→ 正当。残りを次の実装担当へ", { body: "- [ ] 作る\n- [ ] 直す\n" }, { body: "- [x] 作る\n- [ ] 直す\n" }, "実装", 2, null],
    ["決め1 検証担当がマージし、本番に出たあとに残りがある → 実装担当", verify, { pr: { ...merged, mergeChecks: "SUCCESS" } }, "実装", 2, null],
    ["マージのコミットの検査がまだ（本番に出る前に確かめを問わない）", verify, { body: CONFIRM, pr: { ...merged, mergeChecks: "PENDING" } }, "検査", 1, null],
    ["マージのコミットの検査が1つも無い（合格していない）→ 実装担当", verify, { pr: merged }, "実装", 2, null],
    ["マージのコミットの検査が落ち、後の master の実行がまだ無い → 直すか待つ相手を張る実装担当", verify, { body: CONFIRM, pr: { ...merged, mergeChecks: "FAILURE" } }, "実装", 2, null],
    ["マージのコミットの検査が取り消され、後の master の実行も無い（合格でない）→ 実装担当", verify, { body: CONFIRM, pr: { ...merged, mergeChecks: "CANCELLED" } }, "実装", 2, null],
    ["マージのコミットの上で担当の実行が取り消されても、担当の実行は検査に数えない → 確かめの問い", verify,
      { body: CONFIRM, pr: { ...merged, mergeChecks: "SUCCESS", mergeTasks: ["CANCELLED", "SUCCESS"] } }, "回答", 1, "## 問い（確かめ）"],
    ["実装担当が、落ちたマージのコミットの検査を直しも待つ相手を張りもせずに手放した → イレギュラー", { body: CONFIRM, pr: { ...merged, mergeChecks: "FAILURE" } }, { pr: { ...merged, mergeChecks: "FAILURE" } }, "回答", 1, "## 問い（イレギュラー）"],
    ["実装担当が、関係ない理由で落ちたマージのコミットの検査の原因を持つ issue を前提に張って手放した → 待機（振り出さず、問わない）", { body: CONFIRM, pr: { ...merged, mergeChecks: "FAILURE" } },
      { pr: { ...merged, mergeChecks: "FAILURE" }, blockedBy: [9] }, "待機", 1, null],
    ["必須でない検査（検査のワークフローの外）が落ちても走っていても、検査のワークフローが通れば合格 → 確かめの問い", verify,
      { body: CONFIRM, pr: { ...merged, mergeChecks: "SUCCESS", mergeOthers: ["FAILURE", "PENDING"] } }, "回答", 1, "## 問い（確かめ）"],
  ];
  for (const [name, start, { made = [], ...facts }, status, runs, comment] of rows) {
    const w = world([{ n: 1, status: "実装", ...start }, { n: 9, status: "保留" }]);
    await w.send(ev.schedule());
    const run = w.run(1);
    await w.send(ev.run(run, "requested"));
    const kind = start.status ?? "実装";
    assert.equal(w.at(1).status, kind, name);
    const before = w.at(1).body;
    Object.assign(w.at(1), facts);
    for (const i of made) w.issues.set(i.n, { state: "OPEN", comments: [], by: [], blockedBy: [], labels: [], assignees: [], ...i });
    w.at(1).comments.push(END(w.at(1).comments.length, kind, before));
    await w.send(ev.run(run, "completed"));
    assert.deepEqual([w.at(1).status, w.runs.length, said(w.at(1))], [status, runs, comment], name);
    if (status === "回答") assert.deepEqual([w.at(1).assignees, w.at(1).body.startsWith("<!-- flow-gate -->")], [[config.user], true], `${name}: ユーザーの番で、本文の頭に回答のボタン`);
    if (status === "検査") assert.equal(w.at(1).run, "in_progress", `${name}: 欄「実行の status」は、検査のワークフローの最も新しい実行の status`);
  }
});

test("出来事1つで決め直す（R2・R4〜R9・R16・K2・K5・決め5・決め7・開発機で作業中・Claude の本文の書き換え）", async () => {
  const merged = { state: "MERGED", merged: true, mergeChecks: "SUCCESS", sha: "m1" };
  const rows = [
    // [要求, タスク, 担当が付いた後に変わる事実（無ければ担当なし）, 出来事, 期待]
    ["R4 PR の検査が落ちた → 同じ枝で直す実装担当", { status: "検査", pr: { draft: true, checks: "FAILURE" } }, null, ev.ci(`${config.branchPrefix}1`), { status: "実装", runs: ["#1 実装"] }],
    ["R4 PR の検査が通った → PR をレビュー可能にして検証担当", { status: "検査", pr: { draft: true, checks: "SUCCESS" } }, null, ev.ci(`${config.branchPrefix}1`), { status: "検証", draft: false, runs: ["#1 検証"] }],
    ["原則の点検の1 マージのコミットの検査が落ちた → 本番に出ていないので確かめを問わず、直すか待つ相手を張る実装担当", { status: "検査", body: CONFIRM, pr: { ...merged, mergeChecks: "FAILURE" } }, null,
      ev.merge(1), { status: "実装", comment: null, runs: ["#1 実装"] }],
    ["親が保留の子のマージのコミットの検査が落ちた → 待機（振り出さない）", { status: "検査", parent: 4, body: "- [ ] 部品\n", pr: { ...merged, mergeChecks: "FAILURE" } }, null, ev.merge(1), { status: "待機", runs: [] }],
    ["K2・R12 確かめの答えが完了にせず文だけ → 閉じず、Claude の番（実装担当が読む）", { status: "回答", body: CONFIRM, comments: [ASKED("確かめ"), REPLY(ASKED("確かめ"), "続ける", "見た目が崩れる")] }, null, ev.comment(1),
      { state: "OPEN", status: "実装", runs: ["#1 実装"] }],
    ["決め6 前からある Claude の割り当ては外し、保留ではユーザーだけ", { status: "保留", assignees: [config.claude] }, null, ev.comment(1), { assignees: [config.user] }],
    ["R6 見送り（Close as not planned）で閉じたものは閉じたまま", { status: "完了", state: "CLOSED", reason: "NOT_PLANNED" }, null, ev.issue(1, "closed"), { state: "CLOSED" }],
    ["A 対話作業も、ステータスは事実どおり（検査の間は検査）。検査・待機は事実が動くのを待つので Claude の番", { status: "実装", type: config.dialogType, pr: { draft: true, checks: "PENDING" } }, null,
      ev.comment(1), { status: "検査", assignees: [config.claude], runs: [] }],
    ["対話作業の前提が開いている → 待機で Claude の番（ユーザーの番にしない）", { status: "実装", type: config.dialogType, blockedBy: [4] }, null, ev.comment(1),
      { status: "待機", assignees: [config.claude], runs: [] }],
    ["対話作業で開発機のセッションが作業する番（実装）、ラベル「開発機で作業中」が無い間はユーザーの番（振り出さない）", { status: "実装", type: config.dialogType }, null, ev.comment(1),
      { status: "実装", assignees: [config.user], runs: [] }],
    ["開発機のセッションが触っている間（ラベル「開発機で作業中」）は振り出さず、担当者は Claude", { status: "実装", labels: [config.devLabel] }, null, ev.comment(1),
      { status: "実装", assignees: [config.claude], runs: [] }],
    ["開発機のセッションが触っている対話作業は、担当者が Claude", { status: "実装", type: config.dialogType, labels: [config.devLabel] }, null, ev.comment(1), { assignees: [config.claude] }],
    ["R8 マージのコミットの検査が通った → 確かめの問い", { status: "検査", body: CONFIRM, pr: merged }, null, ev.merge(1), { status: "回答", comment: "## 問い（確かめ）" }],
    ["R8・決め7 検査が通ったあとに PR が下書きへ戻された（差し戻し）→ 実装担当", { status: "検証", pr: { draft: true, checks: "SUCCESS", drafted: true } }, null, ev.pr(1, "converted_to_draft"),
      { status: "実装", runs: ["#1 実装"] }],
    ["R5・決め1・決め6 判断の答えで続ける → 表で決め直して実装担当（ユーザーの番を出たら Claude の番）", { status: "回答", assignees: [config.user], comments: [QUESTION, ANSWER("続ける", "A で")] }, null,
      ev.comment(1), { status: "実装", runs: ["#1 実装"], assignees: [config.claude] }],
    ["R5・決め6 答えが保留 → 保留（ユーザーの番）", { status: "回答", comments: [QUESTION, ANSWER("保留")] }, null, ev.comment(1), { status: "保留", assignees: [config.user] }],
    ["R6・決め5 ユーザーが保留から出す → 表で決め直す", { status: "実装" }, null, ev.move(1), { status: "実装", runs: ["#1 実装"] }],
    ["R6 条件が全部済んでユーザーが完了へ動かす → 受ける（完成）", { status: "完了", body: "- [x] 作る\n" }, null, ev.move(1), { status: "完了", state: "CLOSED", reason: "COMPLETED" }],
    ["K2 条件が残ったまま完成で閉じた → 開き直す", { status: "保留", state: "CLOSED", reason: "COMPLETED" }, null, ev.issue(1, "closed"), { state: "OPEN" }],
    ["R7 担当が持っているタスクをユーザーが保留へ → その実行を取り消す", { status: "実装" }, { status: "保留" }, ev.move(1), { status: "保留", cancels: [100], assignees: [config.user] }],
    ["R2・R13・K4 担当が付いている間は決め直さず、その間に出した問いのボタンも消さない", { status: "実装" }, { comments: [QUESTION], body: withButton("- [ ] 作る\n", config, 1) }, ev.comment(1),
      { status: "実装", runs: ["#1 実装"], button: true }],
    ["R9・R13 Claude が起こした要望は採否を問い、本文の頭のボタンは問いより先に書く", { author: config.claude, type: "要望" }, null, ev.issue(1, "opened", config.claude),
      { status: "回答", comment: "## 問い（採否）", writes: ["本文", "コメント"] }],
    ["R16 対話作業は振り出さない", { type: config.dialogType }, null, ev.issue(1, "opened"), { status: "実装", runs: [] }],
    ["R16 対話作業の境目をまたがない種類の変更は通す", { status: "保留", type: "要望", typeChanges: [["不具合", "要望"]] }, null, ev.issue(1, "typed"), { type: "要望" }],
    ["R16 対話作業の境目をまたぐ種類の変更は戻す", { status: "実装", type: "不具合", typeChanges: [[config.dialogType, "不具合"]] }, null, ev.issue(1, "typed"), { type: config.dialogType }],
    ["Claude が本文の完了の条件にチェックを付けた → 決め直す", { status: "実装", body: "- [x] 作る\n" }, null, ev.issue(1, "edited", config.claude), { status: "完了" }],
    ["条件の無い issue は、約束が全部果たされた（無い）ので完成で閉じる", { status: "実装", body: "説明だけ\n" }, null, ev.comment(1), { state: "CLOSED", reason: "COMPLETED" }],
  ];
  for (const [name, task, change, event, want] of rows) {
    const w = world([{ n: 1, ...task }, { n: 4, status: "保留", priority: "高" }]);
    if (change) await w.send(ev.schedule()).then(() => w.send(ev.run(w.run(1), "requested")));
    Object.assign(w.at(1), change);
    await w.send(event);
    const i = w.at(1);
    const got = { status: i.status, state: i.state, reason: i.reason, type: i.type, priority: i.priority, assignees: i.assignees, comment: head(i), runs: w.titles(),
      draft: i.pr?.draft, button: i.body.startsWith("<!-- flow-gate -->"),
      cancels: w.writes.filter(([k]) => k === "取り消し").map(([, id]) => id), writes: w.writes.filter(([, n]) => n === 1).map(([k]) => k) };
    assert.deepEqual(Object.fromEntries(Object.keys(want).map((k) => [k, got[k]])), want, name);
  }
});

test("1件の決め直しの書き込みは、GitHub への書き込みの要求1回にまとめる（本文・欄・ラベル・コメント・閉じる）", async () => {
  // 回数そのものが GitHub の利用の上限と費用に効くので、書き込みの要求の数を確かめる。
  const w = world([{ n: 1, author: config.claude, type: "要望", labels: [config.urgentLabel] }, { n: 2, status: "回答", body: "- [x] 作る\n", labels: ["問い: 判断"], comments: [QUESTION] }]);
  let before = w.mutations ?? 0;
  await w.send(ev.issue(1, "opened", config.claude));
  assert.deepEqual([w.at(1).status, w.at(1).labels.sort(), head(w.at(1))], ["回答", ["問い: 採否", config.urgentLabel].sort(), "## 問い（採否）"]);
  assert.equal(w.mutations - before, 1, "本文のボタン・ステータス・担当者・ラベル・問いのコメントを1回で書く");
  before = w.mutations;
  await w.send(ev.comment(2, config.claude));
  assert.deepEqual([w.at(2).state, w.at(2).labels, w.mutations - before], ["CLOSED", [], 1], "ラベルを外して閉じるのも1回");
});

test("tasks#842・#843 担当者を手で変えたら決め直して戻す。1つのタスクを触るのは1者だけ", async () => {
  // 担当者を手で変えたら、その出来事で決め直し、ゲートの決めた値へ戻す。
  const hand = world([{ n: 1, status: "回答", comments: [QUESTION], assignees: [config.user, config.claude] }]);
  await hand.send(ev.issue(1, "assigned"));
  assert.deepEqual(hand.at(1).assignees, [config.user], "回答の担当者はユーザーだけ");
  // 1つのタスクを触るのは1者だけ: 同じ issue の実行が2本あれば、いちばん古いものを残してほかを取り消す。
  const two = world([{ n: 1, status: "実装" }]);
  two.runs.push({ id: 7, display_title: "#1 実装 a", status: "in_progress", created_at: "2026-10-11T00:00:00Z" },
    { id: 8, display_title: "#1 実装 b", status: "queued", created_at: "2026-10-11T00:00:05Z" });
  await two.send(ev.run(two.runs[1], "requested"));
  assert.deepEqual([two.at(1).status, two.writes.filter(([k]) => k === "取り消し").map(([, id]) => id)], ["実装", [8]]);
  // もう終わった実行の取り消しは GitHub が断る（409）が、取り消しは済んでいるので、出来事の処理を落とさない。
  const gone = world([{ n: 1, status: "実装" }]);
  gone.ended = [8];
  gone.runs.push(...two.runs.map((r) => ({ ...r })));
  await assert.doesNotReject(handle(gone.gh, { inbox: gone.inbox }, config, ...ev.run(gone.runs[1], "requested")), "409 で出来事の処理を落とさない");
  assert.equal(gone.at(1).status, "実装");
});

test("検査の出ない PR は合格していないので実装。実装担当がそのまま手放したらイレギュラーで、「やり直す」と答えたら実装担当へ渡す", async () => {
  // 実装担当が、検査の出ない PR を出して手放した（実装のまま）→ イレギュラー → 「やり直す」と答える。
  const handOff = async (w) => {
    await w.send(ev.schedule());
    const run = w.run(1);
    await w.send(ev.run(run, "requested"));
    w.at(1).pr = { draft: true };
    w.at(1).comments.push(END(0));
    await w.send(ev.run(run, "completed"));
    assert.equal(head(w.at(1)), "## 問い（イレギュラー）");
    w.at(1).comments.push(answerBody(latestQuestion(w.at(1).comments, config.questionForms), { next: "続ける" }));
  };
  const w = world([{ n: 1, status: "実装" }]);
  await handOff(w);
  await w.send(ev.comment(1));
  assert.deepEqual([w.at(1).status, w.titles(), w.at(1).assignees], ["実装", ["#1 実装", "#1 実装"], [config.claude]], "実装担当へ渡す");
  // 枠が埋まっていてすぐ振り出せなくても、答えのあとに担当が終わるまで「やり直す」を保つ。
  const full = world([{ n: 1, status: "実装" }, { n: 2, status: "実装" }, { n: 3, status: "実装" }]);
  await handOff(full);
  assert.deepEqual(full.titles().filter((t) => t !== "#1 実装"), ["#2 実装", "#3 実装"], "実装の枠（2）が埋まる");
  await full.send(ev.comment(1));
  await full.send(ev.comment(1));
  assert.equal(full.at(1).status, "実装", "次の決め直しでも検査へ戻さない");
  await full.send(ev.run(full.run(2), "completed"));
  assert.deepEqual([full.at(1).status, full.titles().filter((t) => t === "#1 実装").length], ["実装", 2], "枠が空いたら実装担当へ渡す");
  // 答えのあとに担当が終わっていれば（終わりのコメントが issue に残る）、「やり直す」は効き終わっている。
  const ended = world([{ n: 1, status: "回答", pr: { draft: true, checks: "PENDING" }, comments: [...w.at(1).comments, END(w.at(1).comments.length + 1)] }]);
  await ended.send(ev.comment(1, config.claude));
  assert.equal(ended.at(1).status, "検査", "担当が終わったあとの検査は検査");
});

test("前提が閉じたら、後ろで待っていたタスクも決め直して振り出す（閉じた issue の先は、決め直しで読んだ事実から取る）", async () => {
  const w = world([{ n: 6, status: "待機", blockedBy: [7] }, { n: 7, status: "回答", state: "CLOSED" }]);
  await w.send(ev.issue(7, "closed"));
  assert.deepEqual([w.at(6).status, w.titles()], ["実装", ["#6 実装"]]);
});

test("K6・受け箱: 止めたら振り出さない。処理が落ちても出来事を失わず、一時の失敗はやり直し、直らない失敗はすぐ諦める", async () => {
  for (const [name, stop] of [["担当のワークフローが無効", { workflow: "disabled_manually" }], ["利用の上限で止まった直後",
    { last: [{ id: 5, status: "completed", conclusion: "failure", updated_at: new Date().toISOString() }], steps: [{ name: config.quotaStep, conclusion: "failure" }] }]]) {
    const off = world([{ n: 1, status: "実装" }], stop);
    await off.send(ev.schedule());
    assert.deepEqual(off.titles(), [], name);
  }
  const w = world([{ n: 1, status: "実装", body: "- [x] 作る\n" }, { n: 2, status: "実装", body: "- [x] 作る\n" }]);
  w.fail = Object.assign(new Error("GitHub が 502"), { transient: true });
  assert.ok((await w.send(ev.comment(1))) > Date.now(), "一時の失敗は、間をあけて起こす時刻を返す");
  w.fail = null;
  assert.ok((await w.send(ev.comment(2))) > Date.now(), "やり直しを待つ出来事がある間は、その時刻を返す");
  assert.deepEqual([w.at(1).status, w.at(2).status], ["実装", "完了"], "待っている出来事があっても、後ろの出来事は先に進む");
  assert.equal(await w.inbox.drain(config.retries, Date.now() + 3600e3), null);
  assert.equal(w.at(1).status, "完了", "やり直しで処理した");
  w.fail = new Error("GitHub が 404");
  assert.equal(await w.send(ev.comment(1)), null, "やり直しても直らない失敗は、すぐ諦める");
  w.fail = null;
  // 1回の起こしで処理する数を限ったら、残りがあれば今の時刻を返し、アラームを置き直す（置かれたアラームが無いときも置く）。
  const many = world([{ n: 1, status: "実装" }, { n: 2, status: "実装" }]);
  await many.push(ev.comment(1));
  await many.push(ev.comment(2));
  const now = Date.now();
  assert.equal(await many.inbox.drain(config.retries, now, 1), now);
  assert.equal((await many.inbox.pending("issue_comment")).length, 1, "限った数のあとの出来事は残る");
  for (const [next, set, want] of [[now, null, now], [now, now + 1, now], [now + 1, now, null], [null, null, null]]) assert.equal(nextAlarm(next, set), want, `${next} ${set}`);
});

test("読むのに要求の要る事実は、決め方が使うときだけ読む（担当が動いている間は、採否の問いを古いコメントまでさかのぼって探さない）", async () => {
  const notes = Array.from({ length: 45 }, (_, k) => `メモ ${k}`);
  const w = world([{ n: 1, author: config.claude, type: "要望", status: "実装", comments: [ASKED("採否"), REPLY(ASKED("採否"), "続ける"), ...notes] }]);
  await w.send(ev.schedule());
  const run = w.run(1);
  const before = w.olderReads; // 振り出す前の決め直しは、担当がまだいないので読む
  await w.send(ev.run(run, "requested"));
  assert.equal(w.olderReads, before, "担当が動いている間は、採否を問うたかを読まない");
  w.at(1).comments.push(END(w.at(1).comments.length));
  await w.send(ev.run(run, "completed"));
  assert.deepEqual([w.olderReads - before, w.at(1).comments.filter((c) => c.startsWith("## 問い（採否）")).length], [1, 1], "担当が終わって採否を問うかを決めるときに1回だけさかのぼり、問い直さない");
});

test("tasks#788 定時は、ユーザーの番でない開いた issue を決め直して、ボードと事実の食い違いを直す。ユーザーの番の issue は、ユーザーの出来事で決め直す", async () => {
  const w = world([{ n: 1, status: "検証", assignees: [config.claude] }, { n: 2, status: "検証", assignees: [config.user] }], { workflow: "disabled" });
  await w.send(ev.schedule());
  assert.deepEqual([w.at(1).status, w.at(2).status], ["実装", "検証"], "PR の無い検証は実装へ直す。ユーザーの番のものは定時では触らない");
});

test("採否を問う issue（Claude が起こした要望）でも、ゲートが出した確かめの問いは、事実が続く間は1つだけ（問い直さない）", async () => {
  const w = world([{ n: 1, author: config.claude, type: "要望", status: "検査", body: CONFIRM, pr: { state: "MERGED", merged: true, mergeChecks: "SUCCESS", sha: "m1" },
    comments: [ASKED("採否"), REPLY(ASKED("採否"), "続ける"), END(2)] }]);
  await w.send(ev.merge(1));
  await w.send(ev.comment(1, config.claude));
  assert.deepEqual([w.at(1).status, w.at(1).comments.filter((c) => c.startsWith("## 問い（確かめ）")).length], ["回答", 1]);
});

test("tasks#938 master とぶつかった PR は、検査が通っていても実装（取り込むのは実装担当）。計算中（UNKNOWN）はぶつかりに数えない", async () => {
  for (const [mergeable, status, title] of [["CONFLICTING", "実装", "#1 実装"], ["UNKNOWN", "検証", "#1 検証"]]) {
    const w = world([{ n: 1, status: "検査", pr: { draft: false, checks: "SUCCESS", mergeable } }]);
    await w.send(ev.ci(`${config.branchPrefix}1`));
    assert.deepEqual([w.at(1).status, w.titles()], [status, [title]], mergeable);
  }
});

test("tasks#938 振り出す前に、今の事実で決め直す（保存したステータスが古いまま担当を起こさない）", async () => {
  // 検証と決めたあとに、出来事の届かない所で事実が動いた: master が進んで PR がぶつかった・担当が問いを出して終えた。
  const w = world([{ n: 1, status: "検証", pr: { draft: false, checks: "SUCCESS", mergeable: "CONFLICTING" } }, { n: 2, status: "実装", comments: [QUESTION] }]);
  await w.send(ev.schedule());
  assert.deepEqual([w.at(1).status, w.at(2).status, w.titles()], ["実装", "回答", ["#1 実装"]], "ぶつかった PR に検証担当を、答えを待つ問いに実装担当を起こさない");
});

test("tasks#1079・tasks#1182 マージのコミットの master の実行が合格せずに終わったら（後の push で取り消された・落ちた）、その変更を判定に入れる後の master の実行（first-parent の子の側で一番近い、取り消されていないもの）の結論で決める。それも落ちていれば、さらに後の実行まで辿る", async () => {
  const merged = (sha, parent, mergeChecks) => ({ state: "MERGED", merged: true, sha, parent, mergeChecks });
  const rows = [
    // [要求, 後のマージのコミットの検査（古い順。m2 は m1 の子、m3 は m2 の子）, #1 のステータス, 振り出した担当]
    ["後の実行が走っている間は検査（打ち直す担当を振り出さない）", ["PENDING"], "検査", []],
    ["後の実行が通った → 本番に出たので確かめを問う", ["SUCCESS"], "回答", []],
    ["後の実行も取り消され、さらに後の実行が通った → 確かめを問う", ["CANCELLED", "SUCCESS"], "回答", []],
    ["後の実行が落ちた → #1 の変更も検査が通っていないので、直すか待つ相手を張る実装担当", ["FAILURE"], "実装", ["#1 実装"]],
    ["後の実行が落ち、さらに後の実行が通った → #1 の変更も含めて通ったので確かめを問う", ["FAILURE", "SUCCESS"], "回答", []],
  ];
  for (const [rowName, later, status, runs] of rows) for (const own of ["CANCELLED", "FAILURE"]) {
    const name = `#1 の実行が ${own}、${rowName}`;
    const w = world([{ n: 1, status: "検査", body: CONFIRM, pr: merged("m1", "m0", own) },
      ...later.map((checks, k) => ({ n: k + 2, status: "検査", body: "- [ ] 作る\n", pr: merged(`m${k + 2}`, `m${k + 1}`, checks) }))]);
    await w.send(ev.merge(1)); // #1 の実行が合格せずに終わった知らせ
    await w.send(ev.merge(later.length + 1)); // 一番後の実行の知らせ（#1 の番号は名前に無い）
    assert.deepEqual([w.at(1).status, said(w.at(1)), w.titles().filter((t) => t.startsWith("#1 "))],
      [status, status === "回答" ? "## 問い（確かめ）" : null, runs], name);
    if (status === "検査") assert.equal(w.at(1).run, "in_progress", `${name}: 欄「実行の status」は、代わりに検査を持つ実行の status`);
  }
});

test("tasks#1149 受け箱: GitHub が上限の 403・429 を返した出来事は、示された時刻より前には打ち直さずにやり直す。上限でない 403 は1回で諦める", async () => {
  const fetched = globalThis.fetch;
  // 本物の GitHub.rest が、差し替えた応答から作る失敗。
  const refused = async (status, headers, text = "{}") => {
    globalThis.fetch = async () => new Response(text, { status, headers });
    try {
      return await new GitHub("t").rest("GET", "/x").then(() => null, (e) => e);
    } finally {
      globalThis.fetch = fetched;
    }
  };
  const now = Date.now();
  const reset = Math.ceil(now / 1000) + 7200;
  for (const [name, status, headers, text, at] of [["二次の上限（retry-after）", 403, { "retry-after": "7200" }, "{}", now + 7200e3],
    ["主の上限（x-ratelimit-reset）", 429, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }, "{}", reset * 1000],
    ["時刻の無い二次の上限", 403, {}, '{"message":"You have exceeded a secondary rate limit."}', now + 60e3]]) {
    const w = world([{ n: 1, status: "実装", body: "- [x] 作る\n" }]);
    w.fail = await refused(status, headers, text);
    assert.ok((await w.send(ev.comment(1))) >= at, `${name}: 示された時刻に起こす`);
    w.fail = null;
    await w.inbox.drain(config.retries, at - 1);
    assert.equal(w.at(1).status, "実装", `${name}: 時刻より前には打ち直さない`);
    assert.equal(await w.inbox.drain(config.retries, at + 1000), null);
    assert.equal(w.at(1).status, "完了", `${name}: 時刻のあとにやり直す`);
  }
  const w = world([{ n: 1, status: "実装", body: "- [x] 作る\n" }]);
  w.fail = await refused(403, { "x-ratelimit-remaining": "4999" }, '{"message":"Resource not accessible by integration"}');
  assert.equal(await w.send(ev.comment(1)), null, "上限でない 403 は1回で諦める");
  assert.deepEqual(await w.inbox.pending("issue_comment"), []);
});

test("tasks#1149 番号のあとに名前の付いた作業ブランチの出来事は、どの issue も決め直さず、例外を投げない", async () => {
  const w = world([{ n: 1, status: "検査", pr: { draft: true, checks: "FAILURE" } }]);
  for (const [name, payload] of [ev.pr("1-layers", "synchronize"), ev.ci(`${config.branchPrefix}1-layers`)]) await handle(w.gh, { inbox: w.inbox }, config, name, payload);
  assert.deepEqual([w.at(1).status, w.writes, w.titles()], ["検査", [], []]);
});
