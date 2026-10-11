// 流れのスキルに同梱したスクリプト（印を付ける・答えを記録する・起票する）の照らし。決まりに合わない入力を断り、合う入力から決まった結果を作る。
// GitHub へ書く所は gh を打つだけなので、ここでは照らしと組み立て（スクリプトが使う関数）を見る。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import base from "../flow.config.json" with { type: "json" };
import { NONE, answerBody, answerProblem, answerText, checkByText, conditions, latestQuestion, withButton } from "../src/questions.js";
import { issueProblems, parseArgs, withOrigin } from "../../../.claude/skills/file-issue/scripts/new-issue.mjs";
// 読み込むだけで手順は動かない（打たれたときだけ動く）。読み込めることで、import の誤りを CI で落とす。
import "../../../.claude/skills/task-work/scripts/check.mjs";
import "../../../.claude/skills/ask/scripts/answer.mjs";
import "../../../.claude/skills/ask/scripts/ask.mjs";

const config = { ...base, questionTemplate: readFileSync(new URL("../question_template.md", import.meta.url), "utf8") };

test("印を付ける（task-work の check.mjs）: 1つに決まる残りの条件にだけ付け、ユーザーが確かめる行と子の行は断る", () => {
  const body = withButton("要約\n\n- [ ] 道を押すと値が出る\n- [ ] 道を押すと窓が閉じる\n- [ ] 見た目\n  - 確かめる: ユーザー\n- [ ] 区間の値\n  - 子: #9\n- [x] 済んだ\n", config, 1);
  const done = checkByText(body, ["道を押すと値"]);
  assert.ok(done.body.startsWith("<!-- flow-gate -->"), "本文の頭の回答のボタンは残す");
  assert.deepEqual(conditions(done.body).filter((c) => c.done).map((c) => c.text), ["道を押すと値が出る", "済んだ"]);
  const rows = [
    ["道を押すと", "2 個"], ["無い条件", "0 個"], ["済んだ", "0 個"], ["見た目", "ユーザーが確かめる条件"], ["区間の値", "子 #9 が受け持つ条件"], ["", "空の頭"], ["  ", "空の頭"],
  ];
  for (const [head, why] of rows) assert.match(checkByText(body, [head]).problems?.join("") ?? "", new RegExp(why), head);
  assert.equal(checkByText(body, ["道を押すと値", "見た目"]).body, undefined, "1つでも合わなければ、どの行にも付けない");
});

test("答えを記録する（ask の answer.mjs）: 回答フォームと同じ照らしで断り、書いた文はゲートが同じ文として読む", () => {
  const judge = { kind: "判断", text: "どちらにしますか？", plans: ["案A", "案B"] };
  const rows = [
    [judge, { choice: "案C" }, /案にない答え/], [judge, { choice: NONE }, /書く欄に書いて/], [judge, { choice: "案A" }, null], [{ ...judge, plans: [] }, { choice: "見送る" }, /この問いに案はありません/],
    [{ kind: "確かめ", text: "完成にしてよいですか？", plans: [] }, {}, /完了にするか/], [{ kind: "採否", text: "着手しますか？", plans: [] }, { choice: "やる" }, /着手する・保留する・見送る/],
    [{ kind: "確かめ", text: "完成にしてよいですか？", plans: [] }, { choice: "見送る", done: true }, /確かめの問いに選択肢はありません/],
    [{ kind: "確かめ", text: "完成にしてよいですか？", plans: [] }, { choice: "保留する", text: "あとで" }, /確かめの問いに選択肢はありません/],
    [judge, { choice: "案A", done: true }, /確かめの問いにだけ/], [{ kind: "採否", text: "着手しますか？", plans: [] }, { choice: "着手する", done: true }, /確かめの問いにだけ/],
    [{ kind: "確かめ", text: "完成にしてよいですか？", plans: [] }, { done: true }, null],
  ];
  for (const [q, a, want] of rows) want ? assert.match(answerProblem(q, a), want) : assert.equal(answerProblem(q, a), null);
  const said = "> 距離のバーは候補数の横に\n\nとユーザーがチャットで言った（2026-10-12）";
  const body = answerBody({ kind: "確かめ", text: "完成にしてよいですか？" }, { done: true, items: ["見た目"], text: said });
  assert.match(body, /^## 回答\n\*\*完成にしてよいですか？\*\*\n\n回答: 完了にする\n- 確かめた: 見た目\n\n/);
  assert.equal(answerText(body), said, "ゲートは決まった形の行の塊のあとを、書いた文としてそのまま読む");
  // 書いた文の中の、決まった形に似た行（太字だけの行・「次のステータス:」で始まる行）も書いた文として読み、決定にしない。
  const confirm = "## 問い（確かめ）\n完成にしてよいですか？";
  const read = (text) => latestQuestion([confirm, answerBody({ kind: "確かめ", text: "完成にしてよいですか？" }, { done: true, items: ["見た目"], text })])?.answer;
  assert.deepEqual(read("**ここを直して**"), { decision: "完了", confirmed: ["見た目"], text: "**ここを直して**" }, "太字だけの文も書いた文");
  assert.deepEqual(read("次のステータス: 保留\nにしたいくらい崩れる"), { decision: "完了", confirmed: ["見た目"], text: "次のステータス: 保留\nにしたいくらい崩れる" },
    "決まった形に似た行で決定を変えない");
  assert.equal(latestQuestion([confirm, "## 回答\n**完成にしてよいですか？**\n\n補足: 見た"])?.answer.text, "補足: 見た", "前の形の補足も書いた文");
});

test("起票する（file-issue の new-issue.mjs）: 本文の形・子の決まり・欄の値を照らす", () => {
  const ok = "要約の1行\n\n<details><summary>要望: 困りごと</summary>\n\n- 困る\n\n</details>\n\n<details><summary>やること</summary>\n\n1. 作る\n\n</details>\n\n" +
    "<details><summary>完了の条件</summary>\n\n- [ ] 作った\n\n</details>\n";
  const child = ok.replace("- [ ] 作った", "親の行の下に - 子: を付ける");
  assert.deepEqual(issueProblems(ok, { type: "要望", size: "S", priority: "中" }), []);
  assert.deepEqual(issueProblems(child, { type: "要望", child: true, size: "S" }), [], "子は条件と優先度を持たない");
  const rows = [
    [ok.replace("要約の1行\n\n", ""), { type: "要望", size: "S", priority: "中" }, /畳まない要約が無い/],
    [ok.replace("やること", "経緯"), { type: "要望", size: "S", priority: "中" }, /順か重なりが違う/],
    [ok.replace("やること", "メモ"), { type: "要望", size: "S", priority: "中" }, /知らない節「メモ」/],
    [ok, { type: "不具合", size: "S", priority: "中" }, /種類「不具合」に合わない節「要望: 困りごと」/],
    [child, { type: "要望", size: "S", priority: "中" }, /完了の条件が無い/],
    [ok, { type: "要望" }, /規模と優先度を入れる/],
    [ok, { type: "要望", child: true }, /子は完了の条件を持たない/],
    [child, { type: "要望", child: true, priority: "高" }, /子に優先度・着手可能日時を入れない/],
    [ok, { type: "要望", size: "XL", priority: "中" }, /規模「XL」/],
    [ok, { type: "要望", size: "S", priority: "中", start: "来週" }, /着手可能日時「来週」/],
    [ok.replace("<details><summary>やること", "<details>\n<summary>メモ"), { type: "要望", size: "S", priority: "中" }, /知らない節「メモ」/],
    [`${ok}\n## 補足\n\nメモ\n`, { type: "要望", size: "S", priority: "中" }, /見出し（#）は使わない/],
  ];
  for (const [body, opts, want] of rows) assert.match(issueProblems(body, opts).join("・"), want, String(want));
  assert.deepEqual(issueProblems(ok.replace("- [ ] 作った", "済んだら閉じる"), { type: config.dialogType }), ["完了の条件が無い"], "対話作業は欄を求めないが、条件は要る");
  assert.match(withOrigin(ok, 724), /^要約の1行\n\n分割元: #724\n\n<details>/, "分割元の行は要約のあとに置く");
  assert.equal(withOrigin(withOrigin(ok, 724), 724).match(/分割元/g).length, 1, "二度は置かない");
  assert.deepEqual(parseArgs(["--title", "題", "--body-file", "b.md", "--blocked-by", "5"]), { title: "題", "body-file": "b.md", "blocked-by": "5" });
  for (const argv of [["--blokced-by", "5"], ["--title"], ["--title", "--size", "S"], ["題"]]) assert.equal(parseArgs(argv), null, argv.join(" "));
});
