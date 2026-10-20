// ゲートを入口から、待つ相手（前提・子）と完了の場面で確かめる。偽の世界は test/world.js、ほかの場面は gate.test.js と gate.answer.test.js が持つ。
import assert from "node:assert/strict";
import test from "node:test";
import { NO_GRANDCHILD, originLine } from "../src/family.js";
import { conditions, droppedQuestion, withButton } from "../src/questions.js"; // 本物のボタンと、ゲートの問いの形を入力に使う
import { config, T, END, world, ev, head, said, ASK_DROPPED, QUESTION, REPLY, CONFIRMED, ASKED } from "./world.js";

// 分けたタスクの扱い（tasks#824・#842 の C4）: 子は要望の値（優先度・日時・急ぎ・保留・採否）を親から継ぎ、約束（完了の条件）は自分の本文に持つ。
// 待つ相手は前提と子で、閉じたことと保留が矢印1本ずつ伝わる。
const asked = (i) => i.comments.filter((c) => c.startsWith("## 問い")).length;
const ACCEPT = "- [ ] 動く\n  - 確かめる: ユーザー\n"; // 親（要望）の約束: ユーザーが確かめる要望の結果
const PART = "- [ ] 部品\n"; // 子（機能）の約束

test("tasks#868 答えの無い問いが残っていても、完了の条件が全部済めば完成で閉じ、ボタンを外す（採否の問いも）", async () => {
  const merged = { state: "MERGED", merged: true, mergeChecks: "SUCCESS", sha: "m1" };
  const rows = [
    // [要求, タスク, 出来事, 期待するステータス]
    ["#865 イレギュラーを問うたあと、別の所で作って条件が全部済んだ", { body: withButton("- [x] 作る\n", config, 1), comments: [ASKED("イレギュラー")] }, ev.comment(1, config.claude), "完了"],
    ["判断を問うたあとで条件が全部済んだ", { body: withButton("- [x] 作る\n", config, 1), comments: [QUESTION] }, ev.comment(1, config.claude), "完了"],
    ["確かめを問うたあとでユーザーの確かめの行にもチェックが付いた", { body: withButton("- [x] 作る\n- [x] 見た目\n  - 確かめる: ユーザー\n", config, 1), comments: [ASKED("確かめ")] },
      ev.issue(1, "edited"), "完了"],
    ["問いのあとで、子の PR がマージされ、マージのコミットの検査が通り、子の条件が全部済んだ", { parent: 2, body: withButton("- [x] 部品\n", config, 1), comments: [ASKED("イレギュラー")], pr: merged },
      ev.merge(1), "完了"],
    ["採否を問うたあとで条件が全部済んだ", { author: config.claude, type: "要望", body: withButton("- [x] 作る\n", config, 1), comments: [ASKED("採否")] }, ev.comment(1, config.claude), "完了"],
  ];
  for (const [name, task, event, status] of rows) {
    const w = world([{ n: 1, status: "回答", assignees: [config.user], ...task }, { n: 2, status: "待機", body: "- [ ] a\n  - 確かめる: ユーザー\n" }]);
    await w.send(event);
    const i = w.at(1);
    const done = status === "完了";
    assert.deepEqual([i.status, i.state, i.reason, i.body.startsWith("<!-- flow-gate -->"), i.assignees], [status, done ? "CLOSED" : "OPEN", done ? "COMPLETED" : null, !done, done ? [] : [config.user]], name);
  }
});

test("原則7: 約束が全部果たされたら、どの時点でも完了（PR・前提・子・担当の実行・マージの検査に関係なく）。ユーザーの保留と、まだ読んでいない文は待つ", async () => {
  const done = "- [x] 作る\n";
  const rows = [
    // [要求, タスク, 期待するステータス]
    ["検査の終わっていない PR が開いている", { pr: { draft: true, checks: "PENDING" } }, "完了"],
    ["前提が開いている", { blockedBy: [9] }, "完了"],
    ["子が開いている", { n: 1 }, "完了"],
    ["マージのコミットの検査が落ちたまま", { pr: { state: "MERGED", merged: true, mergeChecks: "FAILURE" } }, "完了"],
    ["ユーザーが保留にした", { status: "保留" }, "保留"],
  ];
  for (const [name, task, status] of rows) {
    const w = world([{ n: 1, status: "実装", body: done, ...task }, { n: 2, parent: 1, status: "実装", body: "- [ ] 部品\n" }, { n: 9, status: "実装" }]);
    await w.send(ev.issue(1, "edited", config.claude));
    assert.deepEqual([w.at(1).status, w.at(1).state], [status, status === "完了" ? "CLOSED" : "OPEN"], name);
  }
  const run = world([{ n: 1, status: "実装", body: "- [ ] 作る\n" }]);
  await run.send(ev.schedule());
  run.at(1).body = done; // 担当が動いている間に、約束が全部果たされた
  await run.send(ev.issue(1, "edited", config.claude));
  assert.deepEqual([run.at(1).state, run.writes.filter(([k]) => k === "取り消し").length], ["CLOSED", 1], "担当が動いていても完了にし、要らなくなった実行は取り消す");
  const said = world([{ n: 1, status: "実装", body: done, comments: ["ここも直して"], by: [config.user] }]);
  await said.send(ev.comment(1));
  assert.deepEqual([said.at(1).status, said.at(1).state], ["実装", "OPEN"], "ユーザーの文を Claude がまだ読んでいなければ、読むまで待つ");
});

test("tasks#877 問いを出した事実が無くなったら、条件が残っていても回答に留めず表で決め直し、ボタンを外す。事実が残る問いと Claude の判断の問いは待つ", async () => {
  const left = "- [x] 作る\n- [ ] 見た目\n  - 確かめる: ユーザー\n- [ ] 直す\n";
  const rows = [
    // [要求, タスク, 出来事, 期待するステータス]
    ["見送りの前提について問うたあとで、前提が開き直された", { blockedBy: [7], comments: [ASK_DROPPED([7])] }, ev.issue(7, "reopened"), "待機"],
    ["イレギュラーを問うたあとで、作業ブランチの PR が開かれた", { comments: [END(0), ASKED("イレギュラー")], pr: { created: T(1), checks: "PENDING" } }, ev.pr(1, "opened"), "検査"],
    ["イレギュラーを問うたあとで、問う前からあった PR がマージされた", { comments: [END(0, "検証"), ASKED("イレギュラー")], pr: { state: "MERGED", merged: true, mergeChecks: "SUCCESS", sha: "m1", mergedAt: T(1) } },
      ev.merge(1), "実装"],
    ["確かめを問うたあとで、Claude が確かめる条件が足された", { body: withButton(left, config, 1), comments: [ASKED("確かめ")] }, ev.issue(1, "edited", config.claude), "実装"],
    ["見送りの前提がまだ見送りのままなら待つ", { blockedBy: [8], comments: [ASK_DROPPED([8])] }, ev.comment(1, config.claude), "回答"],
    ["検証担当が手放したイレギュラーは、問う前からある開いた PR では片付かない", { comments: [END(0, "検証"), ASKED("イレギュラー")], pr: { checks: "SUCCESS" } }, ev.pr(1, "synchronize"), "回答"],
    ["Claude の判断の問いは、ゲートが中身を読まないので待つ", { comments: [QUESTION] }, ev.comment(1, config.claude), "回答"],
  ];
  for (const [name, task, event, status] of rows) {
    const w = world([{ n: 1, status: "回答", assignees: [config.user], body: withButton("- [ ] 作る\n", config, 1), ...task }, { n: 7, status: "実装" },
      { n: 8, status: "完了", state: "CLOSED", reason: "NOT_PLANNED" }], { workflow: "disabled" });
    await w.send(event);
    const i = w.at(1);
    const asking = status === "回答";
    assert.deepEqual([i.status, i.state, i.body.startsWith("<!-- flow-gate -->"), i.assignees, asked(i)], [status, "OPEN", asking, asking ? [config.user] : [config.claude], 1], name);
  }
});

test("C4 待つ相手: 開いた子がある親は待機し、確かめを問わない。子が全部閉じたら親の確かめを一度だけ問う（子の約束は子の本文にあり、親の行にチェックを付けない）", async () => {
  const w = world([{ n: 1, status: "実装", body: ACCEPT }, { n: 2, parent: 1, status: "実装", body: PART }]);
  await w.send(ev.comment(1));
  assert.deepEqual([w.at(1).status, asked(w.at(1))], ["待機", 0], "#633: 子が開いている間は、親の確かめを問わない");
  Object.assign(w.at(2), { state: "CLOSED", reason: "COMPLETED", body: "- [x] 部品\n" });
  await w.send(ev.issue(2, "closed"));
  assert.deepEqual([w.at(1).body.includes("- [ ] 動く"), w.at(1).status, head(w.at(1)), asked(w.at(1))], [true, "回答", "## 問い（確かめ）", 1]);
  await w.send(ev.comment(1));
  assert.equal(asked(w.at(1)), 1, "確かめは一度だけ");
  CONFIRMED(w.at(1));
  await w.send(ev.comment(1));
  assert.deepEqual([w.at(1).state, w.at(1).reason], ["CLOSED", "COMPLETED"], "確かめることを全部 YES にしたら、約束が全部果たされて閉じる");
});

test("tasks#824 継承: 子は優先度・着手可能日時・急ぎ・保留を親の値で見る。子は自分の約束が全部果たされ、マージのコミットの検査が通ったら閉じ、親へ伝わる", async () => {
  // 子の欄が空のままなら既定の「中」で並び、番号の小さい #3 が先になる。親の値を見ると、高い親の子 #8 が先になる。
  const w = world([{ n: 1, status: "実装", priority: "高", body: ACCEPT }, { n: 8, parent: 1, body: PART }, { n: 3, status: "実装", priority: "中" },
    { n: 4, status: "実装", priority: "低", body: ACCEPT }, { n: 5, parent: 4, status: "実装", body: PART }]);
  await w.send(ev.issue(8, "opened"));
  assert.deepEqual([w.at(8).state, w.at(8).priority], ["OPEN", null], "作ったとたんに閉じず、優先度の欄は空のまま");
  assert.deepEqual(w.titles().sort(), ["#3 実装", "#8 実装"], "高い親の子を、低い親の子より先に振り出す（親は子を待つ）");
  Object.assign(w.at(8), { body: "- [x] 部品\n", pr: { state: "MERGED", merged: true, mergeChecks: "SUCCESS", sha: "m8" } });
  w.at(8).comments.push(END(0));
  await w.send(ev.run(w.run(8), "completed"));
  assert.deepEqual([w.at(8).state, w.at(8).reason], ["CLOSED", "COMPLETED"]);
  assert.deepEqual([w.at(1).status, head(w.at(1))], ["回答", "## 問い（確かめ）"], "子が閉じたら、同じ出来事の中で親を決め直す");

  const v = world([{ n: 1, status: "保留", body: ACCEPT }, { n: 2, parent: 1, status: "実装", body: PART },
    { n: 3, status: "実装", start: "2099-01-01", body: ACCEPT }, { n: 4, parent: 3, status: "実装", body: PART },
    { n: 5, status: "実装", priority: "低", labels: [config.urgentLabel], body: ACCEPT }, { n: 6, parent: 5, status: "実装", body: PART },
    { n: 7, status: "実装", priority: "高" }]);
  await v.send(ev.schedule());
  assert.deepEqual(v.titles().sort(), ["#6 実装", "#7 実装"], "保留の親の子・日時が先の親の子は振り出さず、急ぎの親の子を先に並べる");
  assert.deepEqual([v.at(2).status, v.at(4).status], ["待機", "待機"], "保留の親の子・日時が先の親の子は待機");
});

test("tasks#824 親が閉じたら: 開き直されない閉じ方なら、開いている子を見送りで閉じて知らせる（動いている実行も取り消す）", async () => {
  const w = world([{ n: 1, status: "実装", body: ACCEPT }, { n: 2, parent: 1, status: "実装", body: PART }, { n: 3, status: "実装", blockedBy: [2] }]);
  await w.send(ev.schedule());
  await w.send(ev.run(w.run(2), "requested"));
  Object.assign(w.at(1), { state: "CLOSED", reason: "COMPLETED", body: "- [x] 動く\n  - 確かめる: ユーザー\n" }); // ユーザーが「満たされた」と閉じた
  await w.send(ev.issue(1, "closed"));
  assert.deepEqual([w.at(2).state, w.at(2).reason, head(w.at(2)), w.writes.filter(([k]) => k === "取り消し").map(([, id]) => id)],
    ["CLOSED", "NOT_PLANNED", "親 #1 が閉じたので、見送りで閉じます。", [w.run(2).id]]);
  assert.deepEqual([w.at(3).status, head(w.at(3))], ["回答", "## 問い（続行）"], "ゲートが閉じた子の先（その子を待つ issue）まで、同じ出来事の中で決め直す");
  for (const [name, parent, want] of [["条件の残る親を完成で閉じた → 親は開き直し、子はそのまま", { reason: "COMPLETED" }, ["OPEN", "OPEN"]],
    ["親を見送りで閉じた → 子も見送り", { reason: "NOT_PLANNED" }, ["CLOSED", "CLOSED"]]]) {
    const x = world([{ n: 1, status: "実装", state: "CLOSED", body: ACCEPT, ...parent }, { n: 2, parent: 1, status: "保留", body: PART }]);
    await x.send(ev.issue(1, "closed"));
    assert.deepEqual([x.at(1).state, x.at(2).state], want, name);
  }
});

test("tasks#824 待つ相手が見送りで閉じたら、続けるかを一度だけ問う（前提でも子でも同じ）", async () => {
  const w = world([{ n: 6, status: "待機", blockedBy: [7] }, { n: 7, status: "完了", state: "CLOSED", reason: "NOT_PLANNED" }]);
  await w.send(ev.issue(7, "closed"));
  assert.deepEqual([w.at(6).status, head(w.at(6)), w.at(6).comments.at(-1).includes(droppedQuestion([7]))], ["回答", "## 問い（続行）", true]);
  w.at(6).comments.push(REPLY(ASK_DROPPED([7]), "続ける"));
  await w.send(ev.comment(6));
  assert.deepEqual([w.at(6).status, w.titles(), asked(w.at(6))], ["実装", ["#6 実装"], 1], "続けると決めたら問い直さない");
  const x = world([{ n: 1, status: "待機", body: ACCEPT }, { n: 2, parent: 1, status: "完了", state: "CLOSED", reason: "NOT_PLANNED", body: PART }]);
  await x.send(ev.issue(2, "closed"));
  assert.deepEqual([x.at(1).status, head(x.at(1))], ["回答", "## 問い（続行）"], "子が見送りなら、親で問う");
});

test("tasks#824 採否は親か分割元から受け継ぎ、一度だけ問う。孫は張られた直後に外す", async () => {
  const w = world([{ n: 1, status: "実装" }, { n: 2, author: config.claude, type: "要望", parent: 1, body: PART },
    { n: 3, author: config.claude, type: "要望", body: `${originLine(1)}\n- [ ] 作る\n` }, { n: 4, author: config.claude, type: "要望" }]);
  for (const n of [2, 3, 4]) await w.send(ev.issue(n, "opened", config.claude));
  assert.deepEqual([2, 3, 4].map((n) => asked(w.at(n))), [0, 0, 1], "採否を問うのは、親も分割元も持たない新しい要望だけ");
  w.at(4).comments.push(REPLY(ASKED("採否"), "続ける"), QUESTION);
  await w.send(ev.comment(4, config.claude));
  assert.equal(w.at(4).comments.filter((c) => c.startsWith("## 問い（採否）")).length, 1, "採否を問うたことがあれば、ほかの問いのあとでも問い直さない");

  for (const [name, list, [p, c], want] of [
    ["親に親がある", [{ n: 1 }, { n: 2, parent: 1 }, { n: 3, parent: 2 }], [2, 3], null],
    ["子が子を持つ", [{ n: 5 }, { n: 6, parent: 5 }, { n: 7, parent: 6 }], [5, 6], null],
    ["正しい親子は外さず、親は子を待つ", [{ n: 1, status: "実装" }, { n: 2, parent: 1, status: "保留", body: PART }], [1, 2], 1]]) {
    const g = world(list);
    await g.send(ev.sub(p, c));
    assert.equal(g.at(c).parent, want, name);
    if (!want) assert.ok(g.at(c).comments.at(-1).endsWith(NO_GRANDCHILD), name);
    else assert.equal(g.at(p).status, "待機", name);
  }
});

test("tasks#824 レビューの直し: 重複も見送り側・古い問いもさかのぼる・閉じた親の子は振り出さない・見送りで閉じたら PR も閉じる", async () => {
  const dup = world([{ n: 1, status: "待機", body: ACCEPT }, { n: 2, parent: 1, status: "完了", state: "CLOSED", reason: "DUPLICATE", body: PART }]);
  await dup.send(ev.issue(2, "closed"));
  assert.deepEqual([dup.at(1).status, head(dup.at(1))], ["回答", "## 問い（続行）"], "重複で閉じた子も、続けるかを問う");

  const old = world([{ n: 6, status: "待機", blockedBy: [7], comments: [ASK_DROPPED([7]), REPLY(ASK_DROPPED([7]), "続ける"),
    ...Array.from({ length: 45 }, (_, k) => `メモ ${k}`)] }, { n: 7, status: "完了", state: "CLOSED", reason: "NOT_PLANNED" }]);
  await old.send(ev.comment(6));
  assert.deepEqual([asked(old.at(6)), old.titles()], [1, ["#6 実装"]], "最近の40件より前に答えた問いも見つけ、問い直さない");

  const gone = world([{ n: 1, status: "完了", state: "CLOSED", reason: "COMPLETED", body: "- [x] a\n" }, { n: 2, parent: 1, status: "実装", body: PART }]);
  await gone.send(ev.schedule());
  assert.deepEqual(gone.titles(), [], "親が閉じた子は、決め直す前でも振り出さない");

  const pr = world([{ n: 1, status: "完了", state: "CLOSED", reason: "NOT_PLANNED" }, { n: 2, parent: 1, status: "検証", body: PART, pr: { draft: false, checks: "SUCCESS" } }]);
  await pr.send(ev.issue(1, "closed"));
  assert.deepEqual([pr.at(2).state, pr.at(2).reason, pr.at(2).pr.state], ["CLOSED", "NOT_PLANNED", "CLOSED"], "見送りで閉じた子の開いた PR も閉じる");
});

test("tasks#824 親子を外したら親は待ちをやめ、子を開き直したら親はまた待つ", async () => {
  const w = world([{ n: 1, status: "待機", body: "- [ ] a\n" }, { n: 2, status: "保留", body: PART }]);
  await w.send(ev.sub(1, 2, "sub_issue_removed"));
  assert.deepEqual(w.titles(), ["#1 実装"], "外された子を待たない");
  const x = world([{ n: 1, status: "回答", body: ACCEPT }, { n: 2, parent: 1, status: "完了", body: PART }]);
  await x.send(ev.issue(2, "reopened"));
  assert.deepEqual([x.at(1).status, asked(x.at(1)), x.titles()], ["待機", 0, ["#2 実装"]], "開き直した子を待ち、親の確かめを問わない");
});

test("tasks#824・#878・C4 記法: 条件はチェックの行から字下げした続きまで。「- 確かめる:」「- 見る所と要点:」だけが属性で、文の中の括弧や小項目は文の続き", () => {
  assert.deepEqual(conditions("- [ ] 道を押すと値が出る（区間の境目を含む）\n  境目では両側の値\n  - 夜間も含む\n- [x] 済んだ\n- [ ] 見た目（色）\n\n  - 確かめる: ユーザー\n  - 見る所と要点: [画面](https://github.test/c) の帯の色\n説明の段落\n"), [
    { index: 0, text: "道を押すと値が出る（区間の境目を含む） 境目では両側の値 - 夜間も含む", done: false, verify: "Claude", look: null },
    { index: 3, text: "済んだ", done: true, verify: "Claude", look: null },
    { index: 4, text: "見た目（色）", done: false, verify: "ユーザー", look: "[画面](https://github.test/c) の帯の色" }], "続きの間の空行のあとの属性も、同じ条件の属性");
});

test("tasks#878 確かめの問いの確かめることに、ユーザーが確かめる条件ごとの文と見る所と要点が並び、書かれていない条件はそう出る。答えは条件の文で当たる", async () => {
  const look = "[撮った画面](https://github.test/c) で、値の欄に区間の値が出ている";
  const w = world([{ n: 1, status: "検査", body: `- [x] 作る\n- [ ] 道を押すと値が出る\n  - 確かめる: ユーザー\n  - 見る所と要点: ${look}\n- [ ] 見た目\n  - 確かめる: ユーザー\n`,
    pr: { state: "MERGED", merged: true, mergeChecks: "SUCCESS", sha: "m1" } }]);
  await w.send(ev.merge(1));
  const asked = w.at(1).comments.at(-1);
  assert.deepEqual([w.at(1).status, head(w.at(1))], ["回答", "## 問い（確かめ）"], "条件を並べた確かめの問いは、形に合う");
  assert.ok(asked.includes(`- 道を押すと値が出る\n  - 見る所と要点: ${look}`), asked);
  assert.ok(asked.includes("- 見た目\n  - 見る所と要点: 書かれていません"), asked);
  CONFIRMED(w.at(1));
  await w.send(ev.comment(1));
  assert.deepEqual([w.at(1).state, w.at(1).reason], ["CLOSED", "COMPLETED"]);
});

test("tasks#938 前提の対話作業が config.dialogIdleHours より長く動いていなければ、待っているタスクにユーザーへの知らせを一度だけ出す", async () => {
  const old = new Date(Date.now() - (config.dialogIdleHours * 3600e3 + 60e3)).toISOString();
  const fresh = new Date(Date.now() - (config.dialogIdleHours * 3600e3 - 60e3)).toISOString();
  const notices = (i) => i.comments.filter((c) => c.includes(`@${config.user}`));
  for (const [name, blocker, count] of [["動いていない対話作業", { type: config.dialogType, updated: old }, 1], ["まだ動いている対話作業", { type: config.dialogType, updated: fresh }, 0],
    ["対話作業でない前提", { type: "保守", updated: old }, 0]]) {
    const w = world([{ n: 1, status: "実装", blockedBy: [9] }, { n: 9, status: "実装", ...blocker }]);
    await w.send(ev.schedule());
    await w.send(ev.schedule());
    assert.deepEqual([w.at(1).status, notices(w.at(1)).length], ["待機", count], name);
    if (count) assert.match(notices(w.at(1))[0], /#9/, `${name}: どの前提かを書く`);
  }
});

test("tasks#1078 完了の条件が全部済んでも、本文の「やること」に行き先を名指していない項目が残る間は完成で閉じず、実装担当へ渡して一度だけ知らせる", async () => {
  // 項目1の行き先を変え、項目2は見送りで結んでおく。完了の条件は全部済んでいる。
  const body = (...to) => ["<details><summary>やること</summary>", "", "1. 作る", ...to.map((t) => `   - 行き先: ${t}`), "2. 消す", "   - 行き先: 見送り（要らないと分かった）",
    "", "</details>", "", "- [x] 作る", ""].join("\n");
  const rows = [
    // [要求, 項目1の行き先, 閉じるか]
    ["行き先が無い", [], false],
    ["今の完了の条件の文の頭を指す", ["完了の条件「作る」"], true],
    ["今の完了の条件に無い文を指す", ["完了の条件「消えた条件」"], false],
    ["ほかの issue を指す", ["#5 へ寄せた"], true],
    ["自分を指す", ["#1"], false],
    ["理由の無い見送り", ["見送り"], false],
    ["当たらない行き先と並べても、名指した行き先が1つあればよい", ["完了の条件「消えた条件」", "#5"], true],
  ];
  for (const [name, to, closes] of rows) {
    const w = world([{ n: 1, status: "実装", body: body(...to) }]);
    await w.send(ev.issue(1, "edited", config.claude));
    const i = w.at(1);
    assert.deepEqual([i.state, i.status, w.titles()], closes ? ["CLOSED", "完了", []] : ["OPEN", "実装", ["#1 実装"]], name);
    if (!closes) assert.match(said(i), /「やること」の 1「作る」 が行き先を名指していない/, `${name}: どの項目かを知らせる`);
  }
  const w = world([{ n: 1, status: "検証", body: body() }]);
  await w.send(ev.issue(1, "edited", config.claude));
  await w.send(ev.comment(1));
  assert.equal(w.at(1).comments.filter((c) => c.includes("行き先を名指していない")).length, 1, "直るまで同じ知らせを重ねない");
  w.at(1).body = body("完了の条件「作る」");
  await w.send(ev.issue(1, "edited", config.claude));
  assert.equal(w.at(1).state, "CLOSED", "実装担当が行き先を書いたら完成で閉じる");
});
