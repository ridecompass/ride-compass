// 流れのスキルに同梱したスクリプト（印を付ける・答えを記録する・起票する）の照らし。決まりに合わない入力を断り、合う入力から決まった結果を作る。
// GitHub へ書く所は、gh を打つ関数を差し替えて、書く・書かないと、落ちたときに返す文を見る。
import assert from "node:assert/strict";
import test from "node:test";
import base from "../flow.config.json" with { type: "json" };
import { questionForms } from "../src/bot.js";
import { formed as make } from "./forms.js";
import { NONE, answerBody, answerProblem, answerText, askText, checkByText, conditions, latestQuestion, withButton } from "../src/questions.js";
import { fillFields, issueProblems, parseArgs, withOrigin } from "../../../.claude/skills/file-issue/scripts/new-issue.mjs";
import { check } from "../../../.claude/skills/task-work/scripts/check.mjs";
// 読み込むだけで手順は動かない（打たれたときだけ動く）。読み込めることで、import の誤りを CI で落とす。
import "../../../.claude/skills/ask/scripts/answer.mjs";
import "../../../.claude/skills/ask/scripts/ask.mjs";

const config = base;

test("印を付ける（task-work の check.mjs）: 1つに決まる残りの条件にだけ付け、ユーザーが確かめる行は断る", () => {
  const body = withButton("要約\n\n- [ ] 道を押すと値が出る\n- [ ] 道を押すと窓が閉じる\n- [ ] 見た目\n  - 確かめる: ユーザー\n- [x] 済んだ\n", config, 1);
  const done = checkByText(body, ["道を押すと値"]);
  assert.ok(done.body.startsWith("<!-- flow-gate -->"), "本文の頭の回答のボタンは残す");
  assert.deepEqual(conditions(done.body).filter((c) => c.done).map((c) => c.text), ["道を押すと値が出る", "済んだ"]);
  const rows = [
    ["道を押すと", "2 個"], ["無い条件", "0 個"], ["済んだ", "0 個"], ["見た目", "ユーザーが確かめる条件"], ["", "空の頭"], ["  ", "空の頭"],
  ];
  for (const [head, why] of rows) assert.match(checkByText(body, [head]).problems?.join("") ?? "", new RegExp(why), head);
  assert.equal(checkByText(body, ["道を押すと値", "見た目"]).body, undefined, "1つでも合わなければ、どの行にも付けない");
  // 読んでから書くまでに本文が変わっていたら（ゲートや担当が書いた）、上書きしない。
  const run = (reads) => {
    const edits = [];
    const gh = (args, input) => (args[1] === "view" ? reads.shift() : edits.push(input));
    return { ...check(gh, "5", ["道を押すと値"]), edits };
  };
  const same = run([body, body]);
  assert.equal(same.edits.length, 1);
  assert.deepEqual(conditions(same.edits[0]).filter((c) => c.done).map((c) => c.text), ["道を押すと値が出る", "済んだ"]);
  const moved = run([body, body.replace("- [ ] 見た目", "- [x] 見た目")]);
  assert.deepEqual(moved.edits, [], "変わっていたら書かない");
  assert.match(moved.error, /読んだあとに変わった/);
});

// 書く者が埋める問い（判断・操作）は形の骨組みから作り（test/forms.js: formed）、ゲートが出す問いは、ゲートと同じ組み立てで作る。
const asked = (text) => latestQuestion([text], questionForms);

test("答えを記録する（ask の answer.mjs）: 回答フォームと同じ照らしで断り、書いた文はゲートが同じ文として読む", () => {
  const judgeText = make("判断", "どちらにしますか？", ["案A", "案B"]);
  const confirmText = askText("確かめ", questionForms, [{ text: "見た目" }]);
  const [judge, confirm, adopt, operate] = [judgeText, confirmText, askText("採否", questionForms), make("操作", "設定を変えてください", ["画面で設定を変える"])].map(asked);
  const rows = [
    [judge, { choice: "案C" }, /案にない答え/], [judge, { choice: NONE }, /書く欄に書いて/], [judge, { choice: "案A" }, null], [judge, { text: "どれでもない" }, null],
    [confirm, {}, /「完了にする」のチェックを付けるか/], [adopt, { choice: "やる" }, /着手する・保留する・見送る/], [adopt, { text: "あとで決める" }, /選べるのは/],
    [confirm, { choice: "見送る", done: true }, /選ぶ案はありません/], [confirm, { choice: "保留する", text: "あとで" }, /選ぶ案はありません/],
    [judge, { choice: "案A", done: true }, /項目の並ぶ問いにだけ/], [adopt, { choice: "着手する", done: true }, /項目の並ぶ問いにだけ/],
    [confirm, { done: true }, null], [operate, { done: true }, null], [operate, {}, /「済ませた」のチェックを付けるか/], [operate, { text: "権限が無くて止まった" }, null],
  ];
  for (const [q, a, want] of rows) want ? assert.match(answerProblem(q, a), want) : assert.equal(answerProblem(q, a), null);
  const said = "> 距離のバーは候補数の横に\n\nとユーザーがチャットで言った（2026-10-12）";
  const body = answerBody(confirm, { done: true, text: said });
  assert.match(body, /^## 回答\n\*\*完成にしてよいですか？\*\*\n\n回答: 完了にする\n- 確かめた: 見た目\n\n/);
  assert.equal(answerText(body), said, "ゲートは決まった形の行の塊のあとを、書いた文としてそのまま読む");
  // 書いた文の中の、決まった形に似た行（太字だけの行・「次のステータス:」で始まる行）も書いた文として読み、決定にしない。
  const read = (text) => latestQuestion([confirmText, answerBody(confirm, { done: true, text })], questionForms)?.answer;
  assert.deepEqual(read("**ここを直して**"), { decision: "完了", confirmed: ["見た目"], text: "**ここを直して**" }, "太字だけの文も書いた文");
  assert.deepEqual(read("次のステータス: 保留\nにしたいくらい崩れる"), { decision: "完了", confirmed: ["見た目"], text: "次のステータス: 保留\nにしたいくらい崩れる" },
    "決まった形に似た行で決定を変えない");
  assert.equal(latestQuestion([confirmText, "## 回答\n**完成にしてよいですか？**\n\n補足: 見た"], questionForms)?.answer.text, "補足: 見た", "前の形の補足も書いた文");
  // 選ばずに書いた文だけで答えても（確かめで完了にしない・どの案でもない判断）、書いた文の頭が決まった形に似ていれば、決まった形の行として読まない。
  const only = (text, q, question) => latestQuestion([question, answerBody(q, { text })], questionForms)?.answer;
  for (const text of ["次のステータス: 保留", "回答: 完了にする", "- 確かめた: 見た目\nここは崩れる", "ラベル: 急ぎ\n直して"]) {
    assert.deepEqual(only(text, confirm, confirmText), { decision: "続ける", confirmed: [], text }, text);
    assert.deepEqual(only(text, judge, judgeText), { decision: "続ける", confirmed: [], text }, text);
  }
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

test("起票する（file-issue の new-issue.mjs）: 欄を issue へ1回で入れ、落ちても作り直させず、作った番号と入れ直すコマンドを返す", () => {
  const values = [["size", "S"], ["priority", "高"]];
  // fail: 落とす gh の操作（"view" か "api"）。
  const run = (fail) => {
    const sent = [];
    const gh = (args, input) => {
      if (args.includes(fail)) throw Object.assign(new Error("落ちた"), { stderr: "許しが無い" });
      if (args[0] === "issue") return JSON.stringify({ id: "I77" });
      sent.push(JSON.parse(input).variables);
      return "{}";
    };
    return { left: fillFields(gh, 77, values), sent };
  };
  const f = base.fields;
  assert.deepEqual(run(), { left: null, sent: [{ i: "I77", v: [{ fieldId: f.size.id, singleSelectOptionId: f.size.options.S }, { fieldId: f.priority.id, singleSelectOptionId: f.priority.options.高 }] }] });
  for (const fail of ["view", "api"]) {
    const { left } = run(fail);
    assert.match(left, /^#77 は作った（作り直さない）。欄を入れられなかった（許しが無い）/, fail);
    assert.match(left, /--fill 77 --size S --priority 高$/, "入れ直すコマンド");
  }
  assert.match(fillFields(() => "{}", 77, [["size", "XL"]]), /規模「XL」は .*のどれか/, "選択肢に無い値は書かない");
});
