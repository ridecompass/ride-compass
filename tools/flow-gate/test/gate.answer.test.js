// ゲートを入口から、問いと答え・回答フォームの場面で確かめる。偽の世界は test/world.js、ほかの場面は gate.test.js と gate.family.test.js が持つ。
import assert from "node:assert/strict";
import test from "node:test";
import { MATERIAL, formed as FORMED } from "./forms.js";
import { answerForm } from "../src/form.js";
import { APPLIED, NEXT, askText, checkQuestion, conditions, latestQuestion, loadForms, withButton, withValues } from "../src/questions.js"; // 本物のボタンと、ゲートの問いの形を入力に使う
import { config, T, END, world, ev, head, ASK_DROPPED, QUESTION, REPLY, ANSWER, CONFIRM, ASKED, env, connect, url, open, answer } from "./world.js";

test("答えは、そのあとにユーザーがステータスを変えたか開き直したら当て直さない（ゲートは自分の書いた値でなく、時系列の事実で決める）", async () => {
  const w = world([{ n: 1, status: "回答", comments: [QUESTION, ANSWER("保留")] },
    { n: 2, status: "回答", author: config.claude, type: "要望", comments: [ASKED("採否"), REPLY(ASKED("採否"), "見送り")] }]);
  await w.send(ev.comment(1));
  assert.equal(w.at(1).status, "保留", "答えの保留を当てる");
  Object.assign(w.at(1), { status: "実装", moves: [[config.user, 1, config.fields.status.name]] });
  await w.send(ev.move(1));
  assert.deepEqual([w.at(1).status, w.titles()], ["実装", ["#1 実装"]], "ユーザーが保留から出したら、古い答えで保留へ戻さない");
  await w.send(ev.comment(2));
  assert.deepEqual([w.at(2).state, w.at(2).reason], ["CLOSED", "NOT_PLANNED"], "答えの見送りを当てる");
  Object.assign(w.at(2), { state: "OPEN", reason: null, moves: [[config.user, 1]] });
  await w.send(ev.issue(2, "reopened"));
  assert.deepEqual([w.at(2).state, w.at(2).status], ["OPEN", "実装"], "ユーザーが開き直したら、古い答えで閉じ直さない");
  Object.assign(w.at(1), { status: "保留", moves: [[config.claude, 1, config.fields.status.name]] });
  await w.send(ev.move(1));
  assert.equal(w.at(1).status, "保留", "ユーザーでない者の変更は、答えを置き換えない");
});

test("tasks#307・K3・G4・G7: 本文の印の間・形に合わない問い・ボードの移動・着手可能日時の形", async () => {
  const w = world([{ n: 1, status: "実装", body: "<!-- flow-gate -->\nメモ\n<!-- /flow-gate -->\n\n- [ ] 作る\n" },
    { n: 2, status: "回答", comments: ["## 問い（判断）\n形に合わない"] }, { n: 3, status: "実装", start: "来週" }, { n: 4, status: "実装", start: "2099-01-01 25:00" }]);
  await w.send(ev.issue(1, "edited"));
  assert.deepEqual([w.at(1).body.startsWith("メモ\n"), w.at(1).comments.length], [true, 1], "G3 印の間の見知らぬ行は、消さずに印の外の先頭へ出してコメントで知らせる");
  await w.send(ev.comment(2, config.claude));
  assert.match(head(w.at(2)), /形が外れているので.*判断は「### 案」を1行1つ以上書く/, "K3 形の外れた問いは、読めない理由を知らせる");
  await w.send(ev.issue(3, "edited"));
  assert.deepEqual([/着手可能日時「来週」/.test(head(w.at(3))), w.titles().includes("#3 実装")], [true, false], "G7 形の合わない着手可能日時は知らせ、まだ先と読んで振り出さない");
  await w.send(ev.issue(4, "edited"));
  assert.deepEqual([/着手可能日時「2099-01-01 25:00」/.test(head(w.at(4))), w.titles().includes("#4 実装")], [true, false], "tasks#1167 形は合っても暦に無い日時は、形の合わない値と同じに扱う");
  w.at(1).status = "完了";
  await w.send(ev.move(1));
  const told = w.at(1).comments.at(-1);
  assert.deepEqual([w.at(1).state, [`「${w.at(1).status}」`, "保留", "完了"].every((t) => told.includes(t))], ["OPEN", true], "G4 戻した先と、ユーザーが直接決められるのは保留と完了だけであることを知らせる");
});

test("書いた文は Claude が読むまで決定を当てず、読んだあとに一度だけ当てて知らせる", async () => {
  const done = REPLY(ASKED("確かめ"), "続ける", "距離のバーは候補数の横に置いて");
  const yes = CONFIRM.replace("- [ ] 見た目", "- [x] 見た目"); // 回答フォームで見た目を YES にした
  const w = world([{ n: 1, status: "回答", body: yes, comments: [ASKED("確かめ"), done] }]);
  await w.send(ev.comment(1));
  assert.deepEqual([w.at(1).state, w.at(1).status, w.titles()], ["OPEN", "実装", ["#1 実装"]], "#724: 約束が全部果たされても、文があれば閉じず、実装担当が読む");
  Object.assign(w.at(1), { body: `${yes}- [ ] 距離のバーを候補数の横へ置く\n`, pr: { draft: true, checks: "PENDING" } }); // 担当が読んで条件に足し、作った
  w.at(1).comments.push(END(2));
  await w.send(ev.run(w.run(1), "completed"));
  assert.deepEqual([w.at(1).state, w.at(1).status, head(w.at(1))], ["OPEN", "検査", `${APPLIED}（続ける）。`],
    "読んだあとに答えを当て、当てたことを知らせる。足した条件が残るので閉じない");
  await w.send(ev.comment(1, config.claude));
  assert.equal(w.at(1).comments.filter((c) => c.startsWith(APPLIED)).length, 1, "答えは一度だけ当てる");

  const drop = world([{ n: 2, status: "回答", author: config.claude, type: "要望",
    comments: [ASKED("採否"), REPLY(ASKED("採否"), "見送り", "代わりにパネル全体を2列にしたい")] }]);
  await drop.send(ev.comment(2));
  assert.deepEqual([drop.at(2).state, drop.at(2).status], ["OPEN", "実装"], "見送るでも文があれば、閉じる前に実装担当が読む");
  drop.at(2).comments.push(END(2));
  await drop.send(ev.run(drop.run(2), "completed"));
  assert.deepEqual([drop.at(2).state, drop.at(2).reason, head(drop.at(2))], ["CLOSED", "NOT_PLANNED", `${APPLIED}（見送り）。`], "読んだあとに見送りで閉じる");

  const late = world([{ n: 3, status: "完了", state: "CLOSED", reason: "COMPLETED", body: "- [x] 作る\n", closedAt: T(0.5), comments: [END(0), "ここも直して"], by: [undefined, config.user] }]);
  await late.send(ev.comment(3));
  assert.deepEqual([late.at(3).state, late.at(3).status], ["OPEN", "実装"], "閉じたあとのコメントは、開き直して実装担当が読む");
  late.at(3).comments.push(END(2));
  await late.send(ev.run(late.run(3), "completed"));
  assert.deepEqual([late.at(3).state, late.at(3).reason], ["CLOSED", "COMPLETED"], "読んで条件が全部済んでいれば、完成で閉じ直す");

  const closing = world([{ n: 4, status: "実装", state: "CLOSED", reason: "NOT_PLANNED", comments: ["やめる"], by: [config.user] }]);
  await closing.send(ev.issue(4, "closed"));
  assert.equal(closing.at(4).state, "CLOSED", "閉じるときに一緒に書いた文は、閉じる決定の一部（開き直さない）");

  const mid = world([{ n: 5, status: "実装" }]);
  await mid.send(ev.schedule());
  const run = mid.run(5);
  mid.at(5).comments.push("途中で書いた");
  mid.at(5).by[0] = config.user;
  mid.at(5).comments.push(END(0)); // 担当は書かれる前に読み始めた
  await mid.send(ev.run(run, "completed"));
  assert.deepEqual([mid.at(5).status, mid.titles()], ["実装", ["#5 実装", "#5 実装"]], "担当が読み始めたあとに書いた文は、次の担当が読む");

  const dialog = world([{ n: 6, status: "回答", type: config.dialogType, comments: [QUESTION, ANSWER("保留", "来週にする")] }]);
  await dialog.send(ev.comment(6));
  assert.deepEqual([dialog.at(6).status, dialog.titles()], ["実装", []], "対話作業: 文があれば開発機のセッションの番（振り出さない）");
  dialog.at(6).comments.push("来週に回すと読んだ");
  await dialog.send(ev.comment(6, config.claude));
  assert.deepEqual([dialog.at(6).status, head(dialog.at(6))], ["保留", `${APPLIED}（保留）。`], "対話作業: Claude が書いたら読んだとして、答えを当てる");
});

test("回答フォーム（合意したモック）: 回答内容（案と書く欄）と「この issue を」の次遷移のボタンを分けて出し、送った答えでゲートが決め直す", async () => {
  const w = world([{ n: 1, status: "検査", body: CONFIRM, pr: { state: "MERGED", merged: true, mergeChecks: "SUCCESS", sha: "m1" } },
    { n: 2, author: config.claude, type: "要望" }, { n: 3, status: "実装" }, { n: 4, status: "回答", comments: [QUESTION] },
    { n: 5, status: "回答", comments: ["## 問い（判断）\nどうしますか？\n\n### 案\n- 案A\n- 案B\n"] }]);
  connect(w);
  await w.send(ev.merge(1)); // 確かめの問い
  await w.send(ev.issue(2, "opened", config.claude)); // 採否の問い
  const check = await (await open(1)).text();
  for (const text of ["見た目", "回答内容", "Claude に伝えること", "この issue を", "続ける", "保留する", "見送る", "確認", "戻る", "送信", "判断材料"]) assert.ok(check.includes(text), `確かめ: ${text}`);
  assert.ok(w.at(1).body.includes("button.svg") && !check.includes("button.svg"), "本文の頭の回答のボタンは、フォームの本文に出さない");
  assert.match(check, /<textarea name="note" rows="4"/, "書く欄は1つで4行");
  assert.ok(/name="v0" value="NO" checked/.test(check) && !check.includes("完了にする"), "確かめることは YES／NO で、初めの値は本文の約束の値（まだ NO）。完了は次遷移に無い");
  assert.ok(check.includes("見る所と要点: 書かれていません"), "行の属性は、名前を添えて出す（何が書かれていないかが読める）");
  const adopt = await (await open(2)).text();
  assert.ok(!adopt.includes('name="plan"') && !adopt.includes("完了にする"), "案の無い問いは案を出さず、確かめることが無ければ完了にするも出さない");
  const judge = await (await open(4)).text();
  assert.ok(/value="案A">.*推奨.*早い/s.test(judge) && /value="案B">.*安い/s.test(judge), "案ごとに理由を添え、推奨に印を付ける");
  assert.ok(!/<input[^>]*name="(plan|next)"[^>]*checked/.test(judge), "推奨も次遷移も、最初から選んだ状態にしない");
  assert.equal((await open(3)).status, 404, "答えていない問いが無い");
  const loose = await (await open(5)).text();
  assert.ok(/value="案A">/.test(loose) && !loose.includes('class="rec"') && !loose.includes("回答内容を出せません"), "推奨と理由の無い案は、印と理由の無い丸として並べる");
  await answer(5, { next: "保留", plan: "案B" });
  assert.match(w.at(5).comments.at(-1), /次遷移: 保留\n選んだ案: 案B/, "形の決まりに外れた問いにも、いつもどおりフォームで答える");
  assert.match((await answer(1, { question: "前の問い" })).error, /問いが新しくなっています/);
  assert.match((await answer(4, { plan: "案A" })).error, /この issue をどうするか/, "次遷移はいつも要る");
  const [mutations, writes] = [w.mutations ?? 0, w.writes.length];
  await answer(4, { next: "保留", plan: "案B", note: "あとで" });
  assert.deepEqual([(w.mutations ?? 0) - mutations, w.writes.slice(writes).map(([k]) => k), w.at(4).status], [0, ["コメント"], "回答"],
    "tasks#790 送るときは答えのコメントを書く1回だけで応答を返し、ゲートの書き込み（ステータスの移し）を待たない");
  assert.equal(w.at(4).comments.at(-1).split("\n").slice(3).join("\n"), "次遷移: 保留\n選んだ案: 案B\nコメント:\nあとで", "次遷移と選んだ案とコメントを、互いに変えずにそのまま書く");
  await answer(1, { next: "続ける", v0: "YES", note: "崩れる" });
  assert.deepEqual([w.at(1).comments.at(-1).split("\n").slice(3).join("\n"), w.at(1).body.includes("- [x] 見た目")], ["次遷移: 続ける\n選んだ案: なし（問いに案が無い）\nコメント:\n崩れる", true],
    "確かめることの値は、答えと一緒に本文の約束へユーザーの名義で書く（答えには書かない）");
  await w.send(ev.comment(1));
  assert.deepEqual([w.at(1).state, w.at(1).status, w.titles().filter((t) => t.startsWith("#1"))], ["OPEN", "実装", ["#1 実装"]], "決め2 書いた文は実装担当が読む（完成にしない）");
  await answer(2, { next: "見送り", label: ["急ぎ"] });
  await w.send(ev.comment(2));
  assert.deepEqual([w.at(2).state, w.at(2).reason, w.at(2).labels], ["CLOSED", "NOT_PLANNED", ["急ぎ"]], "採否の見送るで閉じる。ラベルの付け外しも送る");
});

// 問いの形はラベルごとのファイルにあり、回答フォームは問いの回答内容の節だけから導く（書く者が埋める問いは test/forms.js: formed で作る）。

test("ラベルごとの形: 書く節・書かない節・案の決まり・決まった文・判断材料の節・出す者を照らす", () => {
  const forms = config.questionForms;
  assert.deepEqual(Object.keys(forms).sort(), ["イレギュラー", "判断", "採否", "操作", "確かめ", "続行"].sort());
  const ok = [[askText("採否", forms), "ゲート"], [askText("確かめ", forms, [{ text: "見た目" }]), "ゲート"], [askText("イレギュラー", forms), "ゲート"], [ASK_DROPPED([7]), "ゲート"],
    [QUESTION, "Claude"], [FORMED("操作", "設定を変えてください", ["画面で設定を変える"]), "Claude"]];
  for (const [text, by] of ok) assert.deepEqual(checkQuestion(forms, text, by), [], text.split("\n")[0]);
  const rows = [
    ["案の無い判断", `## 問い（判断）\nどちらにしますか？\n\n${MATERIAL("判断")}`, /判断は「### 案」を1行1つ以上書く/],
    ["案が1つの判断", FORMED("判断", "どちらにしますか？", [["案A", "推奨", "早い"]]), /案は2つ以上/],
    ["理由の無い案", FORMED("判断", "どちらにしますか？", [["案A", "推奨", "早い"], "案B"]), /どの案にも「- 推奨:」か「- 理由:」を1つ/],
    ["推奨が2つ", FORMED("判断", "どちらにしますか？", [["案A", "推奨", "早い"], ["案B", "推奨", "安い"]]), /推奨はちょうど1つ/],
    ["案を書いた操作", FORMED("操作", "設定を変えてください", ["画面で設定を変える"]).replace("### 済ませること", "### 案"), /操作は「### 済ませること」/],
    ["回答内容の節を書いた採否", askText("採否", forms).replace("\n\n<details>", "\n\n### 済ませること\n- 読む\n\n<details>"), /採否は回答内容の節を書かない/],
    ["確かめの決まった問いの文を変えた", askText("確かめ", forms, [{ text: "見た目" }]).replace("確かめた結果を入れてください", "閉じますか？"), /確かめの問いの文は「確かめた結果を入れてください」/],
    ["前の形の判断材料の節（推奨を判断材料に書く）", QUESTION.replace("\n</details>", "\n\n**推奨**: 案A\n</details>"), /判断材料の節は/],
    ["知らないラベル", QUESTION.replace("## 問い（判断）", "## 問い（相談）"), /ラベルは .*のどれか（「相談」）/],
    ["「- 」で始まらない回答内容の行", QUESTION.replace("- 案B", "案B"), /回答内容の節の行は「- 」で始める（「案B」）/],
    ["ゲートのラベルを Claude が書いた", askText("確かめ", forms, [{ text: "見た目" }]), /確かめの問いはゲートだけが出す/, "Claude"],
  ];
  for (const [name, text, want, by] of rows) assert.match(checkQuestion(forms, text, by).join("・"), want, name);
});

test("続けるの遷移先は Claude: 書いた文が無くても、Claude が答えを読むまでは実装。確かめることの YES は本文の約束に残る", async () => {
  const two = "- [x] 作る\n- [ ] 見た目\n  - 確かめる: ユーザー\n- [ ] 動き\n  - 確かめる: ユーザー\n";
  const asking = askText("確かめ", config.questionForms, [{ text: "見た目" }, { text: "動き" }]);
  const w = world([{ n: 1, status: "回答", body: withButton(two, config, 1), comments: [asking] },
    { n: 2, status: "回答", body: withButton(CONFIRM, config, 2), comments: [ASKED("確かめ").replace("確かめた結果を入れてください", "完成にしてよいですか？")] },
    { n: 3, status: "回答", labels: [config.devLabel], body: CONFIRM, comments: [QUESTION, ANSWER("続ける")] }]);
  connect(w);
  w.at(1).body = withValues(w.at(1).body, latestQuestion(w.at(1).comments, config.questionForms), ["見た目"]); // ユーザーが GitHub で見た目にチェックを付けた
  const page = await (await open(1)).text();
  assert.ok(/name="v0" value="YES" checked/.test(page) && /name="v1" value="NO" checked/.test(page), "YES／NO の初めの値は、本文の約束の今の値");
  await answer(1, { next: "続ける" });
  await w.send(ev.comment(1));
  assert.deepEqual([w.at(1).status, w.titles(), conditions(w.at(1).body).map((c) => c.done)], ["実装", ["#1 実装"], [true, true, false]],
    "書く欄を空のまま続けても実装担当が答えを読み、本文の約束の値はそのまま残る");
  await w.send(ev.comment(2, config.claude));
  assert.deepEqual([w.at(2).status, w.at(2).comments.at(-1).split("\n").slice(0, 2)], ["回答", ["## 問い（確かめ）", "確かめた結果を入れてください"]],
    "前の決まった文で問うた確かめは、今の文で問い直す");
  await w.send(ev.comment(3));
  assert.equal(w.at(3).status, "実装", "開発機で作業中の issue でも、続けるは開発機のセッションが答えを読むまで実装");
  w.at(3).comments.push("答えを読んだ");
  await w.send(ev.comment(3, config.claude));
  assert.deepEqual([w.at(3).status, head(w.at(3))], ["回答", "## 問い（確かめ）"], "開発機のセッションが書いたら読んだとして、表で決める（残りはユーザーの確かめ）");
});

test("ラベル「操作」の問いは、済ませることを並べ、次遷移のボタンで答える。続けたら Claude の番へ戻る", async () => {
  const w = world([{ n: 1, status: "実装", comments: [FORMED("操作", "秘密の値を入れ直してください", ["Cloudflare の画面で秘密の値を入れ直す"])] }]);
  connect(w);
  await w.send(ev.comment(1, config.claude));
  assert.deepEqual([w.at(1).status, w.at(1).assignees, w.at(1).labels], ["回答", [config.user], ["問い: 操作"]]);
  const html = await (await open(1)).text();
  assert.ok(html.includes("Cloudflare の画面で秘密の値を入れ直す") && !html.includes('name="plan"') && !html.includes("完了にする"), "済ませることの一覧を出し、案と完了にするは出さない");
  await answer(1, { next: "続ける" });
  await w.send(ev.comment(1));
  assert.deepEqual([w.at(1).status, w.titles(), w.at(1).labels], ["実装", ["#1 実装"], []], "続けたら実装担当へ渡し、問いのラベルを外す");
});

test("回答フォームはラベルで分けず、問いの回答内容の節だけから導く（ラベルを足しても、フォームは変えずに出せる）", async () => {
  const form = (kind, section = "") => `出す者: ゲート\n\n## 問い（${kind}）\n読みましたか？\n\n${section}<details><summary>判断材料</summary>\n\n**何の話か**: 試しのラベルです。\n</details>\n`;
  const added = loadForms([form("知らせ"), form("点検", "### 確かめること\n- <点検すること>\n\n")]);
  const cfg = { ...config, questionForms: { ...config.questionForms, ...added } };
  const w = world([{ n: 1, status: "回答", comments: [askText("知らせ", added)], by: [config.gateBot] },
    { n: 3, status: "回答", comments: [askText("点検", added, [{ text: "地図の色" }])], by: [config.gateBot] }]);
  connect(w);
  const page = async (n) => (await answerForm(new Request(url(n)), env, cfg)).text();
  const plain = await page(1);
  assert.ok(["続ける", "保留する", "見送る"].every((t) => plain.includes(`value="${Object.keys(NEXT).find((k) => NEXT[k] === t)}"`)) && !plain.includes("完了にする"), "案も確かめることも無い問いは、次遷移の3つだけ");
  const items = await page(3);
  assert.ok(items.includes("地図の色") && /name="v0" value="YES"/.test(items), "確かめることを並べた問いは、行ごとの YES／NO");
  for (const html of [plain, items]) assert.match(html, /<textarea name="note" rows="4"/, "書く欄はいつも出す");
});

test("答えの無い問いがある間だけ、ゲートがラベル「問い: <ラベル>」を付け、答えが当たったら外す。読めない問いも答えを待ち、読めない理由を知らせる", async () => {
  const left = "- [x] 作る\n- [ ] 見た目\n  - 確かめる: ユーザー\n- [ ] 直す\n";
  const w = world([{ n: 2, author: config.claude, type: "要望" }, { n: 3, status: "回答", labels: ["問い: 確かめ"], body: withButton(left, config, 3), comments: [ASKED("確かめ")] },
    { n: 4, status: "回答", labels: ["急ぎ", "問い: 判断"], comments: [END(0), ASKED("イレギュラー")] },
    { n: 5, status: "実装", comments: [`## 問い（判断）\nどちらにしますか？\n\n${MATERIAL("判断")}`] },
    { n: 6, status: "実装", body: "- [ ] 作る\n", comments: [ASKED("確かめ")], by: [config.claude] }], { workflow: "disabled" });
  connect(w);
  await w.send(ev.issue(2, "opened", config.claude));
  assert.deepEqual(w.at(2).labels, ["問い: 採否"], "採否を問うたら付ける");
  const html = await (await open(2)).text();
  assert.ok(html.includes('value="急ぎ"') && !html.includes('value="問い: 採否"'), "ラベルの欄に問いのラベルは出さない");
  await answer(2, { next: "続ける", label: ["急ぎ"] });
  assert.deepEqual(w.at(2).labels, ["問い: 採否", "急ぎ"], "フォームで送っても、問いのラベルは外さない");
  await w.send(ev.comment(2));
  assert.deepEqual(w.at(2).labels, ["急ぎ"], "答えが当たったら外す");
  await w.send(ev.issue(3, "edited", config.claude));
  assert.deepEqual([w.at(3).status, w.at(3).labels], ["実装", []], "問いを出した事実が無くなったら外す");
  await w.send(ev.comment(4, config.claude));
  assert.deepEqual(w.at(4).labels, ["急ぎ", "問い: イレギュラー"], "違うラベルは、今の問いのラベルへ揃える");
  await w.send(ev.comment(5, config.claude));
  assert.deepEqual([w.at(5).status, w.at(5).labels, /判断は「### 案」を1行1つ以上書く/.test(w.at(5).comments.at(-1))], ["回答", ["問い: 判断"], true],
    "読めない問い（案の無い判断）も答えを待ち、読めない理由を知らせる");
  const loose = await (await open(5)).text();
  assert.ok(/回答内容を出せません（判断は「### 案」を1行1つ以上書く）/.test(loose) && !loose.includes('name="plan"') && !loose.includes("完了にする"),
    "回答フォームは読めない理由を出し、回答内容と完了にするを出さずに、書く欄と次遷移で受ける");
  await answer(5, { next: "保留" });
  await w.send(ev.comment(5));
  assert.equal(w.at(5).status, "保留", "読めない問いへの答えも、ゲートが次遷移で決める");
  await w.send(ev.comment(6, config.claude));
  assert.deepEqual([w.at(6).labels, /確かめの問いはゲートだけが出す/.test(w.at(6).comments.at(-1))], [["問い: 確かめ"], true], "ゲートのラベルの問いを Claude が書いたら、読めない理由を知らせる");
});

test("tasks#1149・tasks#1167 回答フォームの送信・開くのが失敗したとき（GitHub への書き込み・読み込みの失敗・番号の無い URL）、ページに失敗の文が出て、ボタンを押し直せる", async () => {
  const w = world([{ n: 1, status: "回答", comments: [QUESTION] }]);
  connect(w);
  const html = await (await open(1)).text();
  // GitHub が答えの書き込み（ユーザーの名義）を 502 で断ったら、失敗を JSON で返して書かない。打ち直せば届く。
  const connected = globalThis.fetch;
  globalThis.fetch = async (u, init = {}) => (init.headers?.authorization === `Bearer ${env.FORM_TOKEN}` ? new Response("Bad Gateway", { status: 502 }) : connected(u, init));
  const silent = test.mock.method(console, "error", () => {});
  const failed = await answer(1, { next: "続ける" });
  globalThis.fetch = async () => new Response("Bad Gateway", { status: 502 });
  const unread = await open(1);
  silent.mock.restore();
  globalThis.fetch = connected;
  assert.deepEqual([unread.status, /少しおいて、開き直して/.test(await unread.text())], [502, true], "tasks#1167 GitHub から読めなければ、開き直すよう案内するページを返す");
  assert.deepEqual([Boolean(failed.error), w.at(1).comments.length], [true, 1], "失敗を返し、答えは書かない");
  assert.ok((await answer(1, { next: "続ける" })).url, "打ち直せば届く");
  const bare = await answerForm(new Request(`${config.urls.form}/answer`, { method: "POST", body: new FormData() }), env, config);
  assert.deepEqual([bare.status, Boolean((await bare.json()).error)], [400, true], "番号の無い URL への送信は断る");
  assert.equal((await answerForm(new Request(`${config.urls.form}/answer?issue=x`), env, config)).status, 400, "番号の無い URL は開かずに断る");
  // ページのスクリプトを、送信の応答だけを差し替えた最小の DOM で動かす（応答が JSON でない・つながらない・JSON の失敗）。
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  for (const [name, reply] of [["JSON でない 500", async () => new Response("Internal Server Error", { status: 500 })],
    ["つながらない", async () => { throw new TypeError("Failed to fetch"); }], ["JSON の失敗", async () => Response.json({ error: "書けませんでした" }, { status: 502 })]]) {
    const node = (more = {}) => ({ disabled: false, textContent: "", on: {}, addEventListener(type, h) { this.on[type] = h; }, ...more });
    const classes = new Set();
    const buttons = [node(), node()];
    const f = node({ classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
      querySelectorAll: (s) => (s === "button" ? buttons : []) });
    const err = node();
    const document = { querySelector: () => f, getElementById: (id) => (id === "err" ? err : null) };
    new Function("document", "location", "fetch", "FormData", script)(document, { href: url(1) }, reply, class {});
    classes.add("lock");
    await f.on.submit({ preventDefault() {} });
    assert.deepEqual([err.textContent !== "", buttons.map((b) => b.disabled), classes.has("lock")], [true, [false, false], false], `${name}: 失敗の文を出し、ボタンを戻す`);
  }
});
