// 問いと答えの形（.claude/skills/ask/SKILL.md「問い」）。問いの頭は「## 問い（種類）」で、種類の無い「## 問い」は判断として読む。
const KINDS = ["採否", "判断", "確かめ", "イレギュラー"];
export const norm = (t) => (t ?? "").replace(/\r\n/g, "\n");
export const isQuestion = (t) => /^## 問い/.test(norm(t));
const sections = (text) => [...text.matchAll(/^\*\*([^*]+)\*\*:/gm)].map((m) => m[1]); // 判断材料の節の名前
const BLOCK = /^<!-- flow-gate -->\n([\s\S]*?)<!-- \/flow-gate -->\n*/;
const BUTTON = /^\[!\[回答する\]\([^)]*\/button\.svg\)\]\([^)]*\/answer\?issue=\d+\)$/;

// 本文の頭の回答のボタン（GitHub の画面にボタンは足せないので、リンク付きの画像。画像とフォームの道は src/index.js が開ける）。
const answerUrl = (config, number) => `${config.urls.form}/answer?issue=${number}`;
// 印の間にゲートの書かない行があれば、黙って消さずに印の外の先頭へ出す。foreign はその行。
export function splitBody(body) {
  const foreign = (BLOCK.exec(norm(body))?.[1] ?? "").split("\n").filter((l) => l.trim() && !BUTTON.test(l.trim()));
  const rest = norm(body).replace(BLOCK, "");
  return { foreign, rest: foreign.length ? `${foreign.join("\n")}\n\n${rest}` : rest };
}
export const bodyRest = (body) => splitBody(body).rest;
export const withButton = (body, config, number) =>
  `<!-- flow-gate -->\n[![回答する](${config.urls.gate}/button.svg)](${answerUrl(config, number)})\n<!-- /flow-gate -->\n\n${bodyRest(body)}`;
// 完了の条件（.claude/skills/file-issue/SKILL.md「issue の形」）。1つの条件はチェックの行から、それより深く字下げした続きの行まで
// （Markdown と同じく、続きの間の空行も同じ条件に数える）。続きの行のうち「- 確かめる: 」「- 子: 」「- 見る所と要点: 」で始まる行だけが属性で、ほかは条件の文の続き。
// 見る所と要点は、ユーザーが確かめる条件の判断に要る中身（見る先へのリンクと、何が作られ・何が分かったか）で、ゲートは読まずに確かめの問いへ写す。
// 属性を行の外に置くのは、文の中の記号と混ざらないため。index はチェックの行が本文（bodyRest）の何行目か（印はこの行に付ける）。
const CHECK = /^(\s*)- \[([ x])\] (.+)$/;
const ATTR = /^- (確かめる|子|見る所と要点): (.+)$/;
const indent = (l) => /^\s*/.exec(l)[0].length;
export function conditions(body) {
  const lines = bodyRest(body).split("\n");
  const all = [];
  for (let i = 0; i < lines.length; i++) {
    const m = CHECK.exec(lines[i]);
    if (!m) continue;
    const c = { index: i, text: [m[3].trim()], done: m[2] === "x", verify: "Claude", child: null, look: null };
    for (;;) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length || CHECK.test(lines[j]) || indent(lines[j]) <= m[1].length) break;
      i = j;
      const t = lines[i].trim();
      const a = ATTR.exec(t);
      if (a?.[1] === "確かめる") c.verify = a[2].trim() === "ユーザー" ? "ユーザー" : "Claude";
      else if (a?.[1] === "見る所と要点") c.look = a[2].trim();
      else if (a) c.child = Number(/^#(\d+)$/.exec(a[2].trim())?.[1]) || null;
      else c.text.push(t);
    }
    all.push({ ...c, text: c.text.join(" ") });
  }
  return all;
}
// 本文の、index の行のチェックに印を付ける（同じ文の条件が2つあっても、指した行にだけ付ける）。
export function checkLines(body, indexes) {
  const lines = bodyRest(body).split("\n");
  for (const k of indexes) lines[k] = lines[k].replace("- [ ] ", "- [x] ");
  return lines.join("\n");
}
export const remaining = (body) => conditions(body).filter((c) => !c.done);
export const confirmConditions = (body) => remaining(body).filter((c) => c.verify === "ユーザー");
export const confirmItems = (body) => confirmConditions(body).map((c) => c.text);
// Claude が条件の文の頭で指した行に印を付けた本文（.claude/skills/task-work/scripts/check.mjs）。指せるのは残りの条件のうちちょうど1つに
// 当たるものだけで、ユーザーが確かめる行（答えでゲートが付ける）と子が受け持つ行（子が閉じたときにゲートが付ける）は指せない。
// 本文の頭の回答のボタンは残す。合わなければ problems を返し、本文は返さない。
export function checkByText(body, heads) {
  const left = remaining(body);
  const problems = [];
  const indexes = [];
  for (const h of heads) {
    const hit = left.filter((c) => c.text.startsWith(h.trim()));
    if (!h.trim()) problems.push("空の頭では指せない");
    else if (hit.length !== 1) problems.push(`「${h}」に当たる残りの条件が ${hit.length} 個（1個に決まる頭で指す）`);
    else if (hit[0].verify === "ユーザー") problems.push(`「${h}」はユーザーが確かめる条件（答えでゲートが付ける）`);
    else if (hit[0].child) problems.push(`「${h}」は子 #${hit[0].child} が受け持つ条件（子が完成で閉じたときにゲートが付ける）`);
    else indexes.push(hit[0].index);
  }
  if (problems.length) return { problems };
  const head = splitBody(body).foreign.length ? "" : (BLOCK.exec(norm(body))?.[0] ?? "");
  return { body: head + checkLines(body, indexes) };
}

// 問い: 頭の行・問いの文1行・（あれば）「### 案」と1行1案・（あれば）<details> の判断材料。ほかの行があれば null。
function parseQuestion(text) {
  const all = norm(text);
  const cut = all.indexOf("<details>");
  const [head, ...lines] = (cut < 0 ? all : all.slice(0, cut)).split("\n");
  const kind = /^## 問い(?:（(.+)）)?\s*$/.exec(head)?.[1] ?? (/^## 問い\s*$/.test(head) ? "判断" : null);
  if (!KINDS.includes(kind)) return null;
  const [question, header, ...plans] = lines.map((l) => l.trim()).filter(Boolean);
  if (!question || /^(#|- )/.test(question)) return null;
  if (header !== undefined && (header !== "### 案" || !plans.length || plans.some((l) => !l.startsWith("- ")))) return null;
  const material = cut < 0 ? "" : /^<details>\s*<summary>[^<]*<\/summary>([\s\S]*?)<\/details>\s*$/.exec(all.slice(cut))?.[1].trim();
  return material === undefined ? null : { kind, text: question, plans: plans.map((l) => l.slice(2).trim()), material };
}

// 判断材料が形（question_template.md）の節を、形の順に1つずつ埋めて持つか。合わない所を返す（空なら合う）。
export function checkQuestion(template, text) {
  const q = parseQuestion(text);
  if (!q) return ["頭の行・問いの文（1行）・「### 案」と1行1案・<details> の判断材料のほかに行がある"];
  const want = sections(template);
  const got = sections(q.material);
  return JSON.stringify(got) === JSON.stringify(want) ? [] : [`判断材料の節は ${want.join("・")} をこの順に1つずつ`];
}

// 答え: 決定（続ける・保留・見送り・完了）・確かめた項目・書いた文。前の形の「次のステータス:」「- 問題なし:」の行も読む。
// 書いた文は、決まった形の行のほかの全部（前の形の「補足:」「- 問題あり:」も入る）。ゲートは文の中身を読まず、Claude が読むまで決定を当てない。
export const DONE = "完了にする";
export const NOT_DONE = "完了にしない"; // 確かめで、完了にせずに書いた文だけで答えたとき
export const NONE = "どれでもない（書く欄に書く）"; // 判断で、どの案でもないとき
export const CHOICES = { 採否: ["着手する", "保留する", "見送る"], イレギュラー: ["やり直す", "保留する", "見送る"] };
// 答えの入力が問いに足りているか（回答フォームと、チャットの答えの記録 .claude/skills/ask/scripts/answer.mjs が同じに照らす）。足りなければ理由。
// 確かめには選択肢が無く、完了にするのは確かめだけ（ゲートは最初の「回答:」行を読むので、2行あると取り違える）。
export function answerProblem(q, { choice, done, text }) {
  if (q.kind === "確かめ") {
    if (choice) return "確かめの問いに選択肢はありません（完了にするか、直してほしいことを書いてください）。";
    return done || text ? null : "完了にするか、直してほしいことを書いてください。";
  }
  if (done) return `「${DONE}」は確かめの問いにだけ使えます。`;
  if (q.kind === "判断") {
    if (choice && !q.plans.length) return "この問いに案はありません（書く欄に書いてください）。";
    if (choice && !choice.trim()) return "選んだ案が空です。";
    if (choice && q.plans.length && ![...q.plans, NONE].includes(choice)) return `案にない答えです（案: ${[...q.plans, NONE].join(" / ")}）。`;
    return (!choice || choice === NONE) && !text ? "どれでもないときは、書く欄に書いてください。" : null;
  }
  return CHOICES[q.kind].includes(choice) ? null : `選べるのは ${CHOICES[q.kind].join("・")} です。`;
}
// 答えのコメント（.claude/skills/ask/SKILL.md「答え」の形）。書いた文は形を付けずに、決まった形の行の塊のあとの空行の後ろにそのまま置く。
// 「回答:」の行はいつも置き（選ばずに書いた文だけで答えたときも）、塊が空にならないようにする（書いた文の頭が塊として読まれない）。
export function answerBody(q, { choice, done, items = [], labels = "", text = "" }) {
  const lines = ["## 回答", `**${q.text}**`, ""];
  if (done) lines.push(`回答: ${DONE}`, ...items.map((item) => `- 確かめた: ${item}`));
  else lines.push(`回答: ${choice || (q.kind === "確かめ" ? NOT_DONE : NONE)}`);
  if (labels) lines.push(`ラベル: ${labels}`);
  if (text) lines.push("", text);
  return lines.join("\n");
}
export const APPLIED = "答えに書いた文を Claude が読んだので、答えを当てました"; // 書いた文のある答えを当てた印（二度は当てない）
export const isAnswer = (t) => /^## 回答\n/.test(norm(t));
// 答えのコメントを、決まった形の行と書いた文に分ける。決まった形の行は、頭（「## 回答」と問いの文の太字の行）のあとの最初の塊（次の空行まで）に
// だけ置かれ（answerBody の形）、そのあとは全部書いた文。塊に決まった形でない行が1つでもあれば、塊は無く全部が書いた文（前の形の答え）。
// 書いた文の中に決まった形に似た行があっても、決まった形の行としては読まない。
const FIELD = /^(?:(?:回答|次のステータス): .+|- (?:確かめた|問題なし): .+|ラベル: .*)$/;
function splitAnswer(text) {
  const lines = norm(text).split("\n");
  let k = /^\*\*.+\*\*$/.test(lines[1] ?? "") ? 2 : 1;
  while (k < lines.length && !lines[k].trim()) k++;
  let end = k;
  while (end < lines.length && lines[end].trim()) end++;
  const block = lines.slice(k, end).map((l) => l.trim());
  const fixed = block.every((l) => FIELD.test(l)) ? block : [];
  return { fixed, text: lines.slice(k + fixed.length).join("\n").trim() };
}
export const answerText = (text) => splitAnswer(text).text;
function parseAnswer(text) {
  const all = norm(text);
  if (!isAnswer(all)) return null;
  const { fixed, text: said } = splitAnswer(all);
  const picked = (fixed.map((l) => /^(?:回答|次のステータス): (.+)$/.exec(l)?.[1]).find(Boolean) ?? "").trim();
  const decision = /見送/.test(picked) ? "見送り" : /保留/.test(picked) ? "保留" : picked === DONE ? "完了" : "続ける";
  const confirmed = fixed.map((l) => /^- (?:確かめた|問題なし): (.+)$/.exec(l)?.[1]?.trim()).filter(Boolean);
  return { decision, confirmed, text: said };
}

// コメントの並びから今の問いと、その答え（無ければ null）。形（template）に合わない問いは問いとして読まない（残す守り: 問いの形の検査）。
export function latestQuestion(comments, template) {
  const i = comments.findLastIndex(isQuestion);
  if (i < 0) return null;
  const q = !template || !checkQuestion(template, comments[i]).length ? parseQuestion(comments[i]) : null;
  const a = comments.slice(i + 1).map(parseAnswer).find(Boolean) ?? null;
  return q && { ...q, answer: a };
}

// ゲートが出す問い（採否・確かめ・イレギュラー）。判断材料は形（question_template.md）の節を埋める。答えの選び方は回答フォームが種類で出す。
const ASKS = {
  採否: ["このタスクに着手しますか？", "Claude が起こした要望です。着手するかはユーザーが決めます。", "決めたことだけを Claude が進める。",
    "決めないまま進めると、要らないものを作る。", "ユーザーの起票・改善・子・分割元のある切り出し（決めずに進める）。", "着手する: 未着手になり担当が振り出される。保留する: 保留へ。見送る: 閉じる。", "着手するかの判断は本文で決まる。"],
  確かめ: ["完成にしてよいですか？", "完了の条件のうち、ユーザーが確かめる条件だけが残っています。全部見て、完了にするかを答えてください。直してほしいことは書く欄に書きます。",
    "完成は、完了の条件が全部満たされたときだけ。", "見ないまま完成にすると、思ったものと違うまま閉じる。", "条件がユーザーの確かめを持たないとき。",
    "完了にする: 印を付けて完成。書いた文があれば、Claude が読んで直してから完成。完了にしない: 書いたことを Claude が読んで直す。", "本文の完了の条件のうち、「- 確かめる: ユーザー」の付いた条件。"],
  イレギュラー: ["担当が、問いも Pull Request も出さず、条件も満たさずに終わりました。どうしますか？", "直前の「担当の終わり」のコメントに、実行へのリンクと担当の最後の発言があります。",
    "落ちた担当を黙って振り出し直さず、ユーザーが次を決める。", "同じ形で何度も落ちる。", "担当が問いか Pull Request を出したとき。",
    "やり直す: 未着手へ戻し振り出す。保留する: 保留へ。見送る: 閉じる。", "直前の「担当の終わり」のコメント。"],
};
const material = (template, facts) => sections(template).map((n, i) => `**${n}**: ${facts[i] ?? "なし"}`).join("\n\n");
// 確かめは、ユーザーが確かめる条件（confirmConditions）ごとに、条件の文と見る所と要点を「何の話か」に並べる。書かれていない条件も隠さずにそう出す。
const NO_LOOK = "書かれていません";
const listed = (items) => items.map((c) => `\n- ${c.text}\n  - 見る所と要点: ${c.look ?? NO_LOOK}`).join("");
export function askText(kind, template, items = []) {
  const [question, about, ...rest] = ASKS[kind];
  const facts = [kind === "確かめ" && items.length ? `${about}\n${listed(items)}` : about, ...rest];
  return `## 問い（${kind}）\n${question}\n\n<details><summary>判断材料</summary>\n\n${material(template, facts)}\n</details>`;
}

// 待つ相手（前提・子）が見送りで閉じたときの判断の問い。問いの文に相手の番号を入れ、同じ文の問いが既にあれば二度は問わない
// （答えで「続ける」を選んだあとも、相手は見送りのまま残るため）。
export const droppedQuestion = (numbers) => `待っていた ${numbers.map((n) => `#${n}`).join("・")} が見送りで閉じました。この issue を続けますか？`;
// 見送りの判断の問いの文から、問うた相手の番号（その問いでなければ null）。
export function droppedOf(text) {
  const numbers = /^待っていた (\S+) が/.exec(text)?.[1].split("・").map((n) => Number(n.slice(1)));
  return numbers && droppedQuestion(numbers) === text ? numbers : null;
}
export const askDropped = (numbers, template) => `## 問い（判断）\n${droppedQuestion(numbers)}\n\n### 案\n- 続ける\n- 保留する\n- 見送る\n\n<details><summary>判断材料</summary>\n\n${material(template, [
  "この issue が待っていた相手（前提か子）が見送りで閉じ、その結果を当てにしていた作業を続けるかを決める必要があります。", "当てにしていた結果が無いまま、黙って作り進めない。",
  "前の結果を使う作業を、前が無いまま作る。", "待っていた相手が完成で閉じたとき。",
  "続ける: 待つ相手を除いて決め直す。保留する: 保留へ。見送る: この issue も閉じる。", "見送りで閉じた相手の issue。"])}\n</details>`;
