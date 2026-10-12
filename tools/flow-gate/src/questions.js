// 問いと答えの形（.claude/skills/ask/SKILL.md「問い」）。問いの頭は「## 問い（<ラベル>）」で、ラベルごとの形は tools/flow-gate/question_forms/ のファイルが持つ。
export const norm = (t) => (t ?? "").replace(/\r\n/g, "\n");
export const isQuestion = (t) => /^## 問い/.test(norm(t));
// 判断材料の節（行頭の「**<名前>**:」から次の節の前まで）の名前と中身。
const sectionsOf = (text) => {
  const heads = [...text.matchAll(/^\*\*([^*]+)\*\*: ?/gm)];
  return heads.map((m, i) => ({ name: m[1], value: text.slice(m.index + m[0].length, heads[i + 1]?.index ?? text.length).trim() }));
};
const BLOCK = /^<!-- flow-gate -->\n([\s\S]*?)<!-- \/flow-gate -->\n*/;
const BUTTON = /^\[!\[回答する\]\([^)]*\/button\.svg\)\]\([^)]*\/answer\?issue=\d+\)$/;

// 本文の頭の回答のボタン（GitHub の画面にボタンは足せないので、リンク付きの画像。画像とフォームの道は src/index.js が開ける）。
export const answerUrl = (config, number) => `${config.urls.form}/answer?issue=${number}`;
// 印の間にゲートの書かない行があれば、黙って消さずに印の外の先頭へ出す。foreign はその行。
export function splitBody(body) {
  const foreign = (BLOCK.exec(norm(body))?.[1] ?? "").split("\n").filter((l) => l.trim() && !BUTTON.test(l.trim()));
  const rest = norm(body).replace(BLOCK, "");
  return { foreign, rest: foreign.length ? `${foreign.join("\n")}\n\n${rest}` : rest };
}
const bodyRest = (body) => splitBody(body).rest;
export const withButton = (body, config, number) =>
  `<!-- flow-gate -->\n[![回答する](${config.urls.gate}/button.svg)](${answerUrl(config, number)})\n<!-- /flow-gate -->\n\n${bodyRest(body)}`;
// 完了の条件（.claude/skills/file-issue/SKILL.md「issue の形」）。1つの条件はチェックの行から、それより深く字下げした続きの行まで
// （Markdown と同じく、続きの間の空行も同じ条件に数える）。続きの行のうち「- 確かめる: 」「- 見る所と要点: 」で始まる行だけが属性で、ほかは条件の文の続き。
// 見る所と要点は、ユーザーが確かめる条件の判断に要る中身（見る先へのリンクと、何が作られ・何が分かったか）で、ゲートは読まずに確かめの問いへ写す。
// 属性を行の外に置くのは、文の中の記号と混ざらないため。index はチェックの行が本文（bodyRest）の何行目か（印はこの行に付ける）。
const CHECK = /^(\s*)- \[([ x])\] (.+)$/;
const ATTR = /^- (確かめる|見る所と要点): (.+)$/;
const indent = (l) => /^\s*/.exec(l)[0].length;
export function conditions(body) {
  const lines = bodyRest(body).split("\n");
  const all = [];
  for (let i = 0; i < lines.length; i++) {
    const m = CHECK.exec(lines[i]);
    if (!m) continue;
    const c = { index: i, text: [m[3].trim()], done: m[2] === "x", verify: "Claude", look: null };
    for (;;) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length || CHECK.test(lines[j]) || indent(lines[j]) <= m[1].length) break;
      i = j;
      const t = lines[i].trim();
      const a = ATTR.exec(t);
      if (a?.[1] === "確かめる") c.verify = a[2].trim() === "ユーザー" ? "ユーザー" : "Claude";
      else if (a) c.look = a[2].trim();
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
// Claude が条件の文の頭で指した行に印を付けた本文（.claude/skills/task-work/scripts/check.mjs）。指せるのは残りの条件のうちちょうど1つに
// 当たるものだけで、ユーザーが確かめる行（答えでゲートが付ける）は指せない。
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
    else indexes.push(hit[0].index);
  }
  if (problems.length) return { problems };
  const head = splitBody(body).foreign.length ? "" : (BLOCK.exec(norm(body))?.[0] ?? "");
  return { body: head + checkLines(body, indexes) };
}

// 問い: 頭の行「## 問い（<ラベル>）」・問いの文1行・（あれば）回答内容の節（SECTIONS のどれか1つを1行1つ。行の下に字下げした属性の行
// 「- <名前>: <値>」を置ける）・（あれば）<details> の判断材料。ほかの行があれば null。
const SECTIONS = ["### 案", "### 確かめること", "### 済ませること"];
const ATTRIBUTE = /^\s+- ([^:]+): (.+)$/;
function parseQuestion(text) {
  const all = norm(text).trim();
  const cut = all.indexOf("<details>");
  const [head, question, header, ...lines] = (cut < 0 ? all : all.slice(0, cut)).split("\n").filter((l) => l.trim());
  const kind = /^## 問い（(.+)）\s*$/.exec(head ?? "")?.[1];
  if (!kind || !question || /^\s*(#|- )/.test(question) || (header !== undefined && !SECTIONS.includes(header.trim()))) return null;
  const rows = [];
  for (const line of lines) {
    const a = ATTRIBUTE.exec(line);
    if (a && rows.length) rows.at(-1).attrs.push([a[1].trim(), a[2].trim()]);
    else if (/^- \S/.test(line)) rows.push({ text: line.slice(2).trim(), attrs: [] });
    else return null;
  }
  const material = cut < 0 ? "" : /^<details>\s*<summary>[^<]*<\/summary>([\s\S]*?)<\/details>$/.exec(all.slice(cut))?.[1].trim();
  return material === undefined ? null : { kind, text: question.trim(), header: header?.trim() ?? null, rows, material };
}

// ラベルごとの形（tools/flow-gate/question_forms/ のファイルの中身）をラベルで引けるようにする。「## 問い」の行より前は形の決まり（「出す者: <ゲートか Claude>」）、
// そこから下が問いの骨組み。骨組みの回答内容の節が、そのラベルで書く節（無ければ書かない）。判断材料の節が、そのラベルの節とその並び。値の全体が
// 「<…>」の所（問いの文・節の行・判断材料の中身）は書く者が埋め、ほかは決まった値。
const HOLE = /^<[\s\S]*>$/;
export function loadForms(texts) {
  const forms = {};
  for (const t of texts) {
    const all = norm(t);
    const at = all.search(/^## 問い/m);
    const q = parseQuestion(at < 0 ? "" : all.slice(at));
    if (!q) throw new Error(`問いの形が読めない: ${all.split("\n")[0]}`);
    forms[q.kind] = { by: /^出す者: (.+)$/m.exec(all.slice(0, at))?.[1].trim() ?? null, header: q.header, text: HOLE.test(q.text) ? null : q.text, sections: sectionsOf(q.material) };
  }
  return forms;
}
// 問いの頭の行と、問いの組み立て（rows は回答内容の節の行と属性、material は判断材料の節の名前と中身の並び）。
export const questionHead = (kind) => `## 問い（${kind}）`;
export const render = (kind, text, header, rows, material) => [`${questionHead(kind)}\n${text}`,
  header && [header, ...rows.flatMap((r) => [`- ${r.text}`, ...r.attrs.map(([n, v]) => `  - ${n}: ${v}`)])].join("\n"),
  `<details><summary>判断材料</summary>\n\n${material.map((s) => `**${s.name}**: ${s.value}`).join("\n\n")}\n</details>`].filter(Boolean).join("\n\n");

// 問いの書き手（ゲートか Claude）。ゲートは App の名義で書く（GraphQL は名義を [bot] の付かない形で返す）。
export const askerOf = (config, login) => (login === config.gateBot.replace(/\[bot\]$/, "") ? "ゲート" : "Claude");
// 問いがラベルの形に合うか。合わない所を返す（空なら合う）。照らすのは、書き手（by。渡したときだけ）・回答内容の節（ラベルが書く節だけを、1行1つ以上）・
// 決まった問いの文・判断材料の節の名前と順と、案の決まり（2つ以上。どの案にも「推奨」か「理由」を1つ。推奨はちょうど1つ）。
export function checkQuestion(forms, text, by = null) {
  const q = parseQuestion(text);
  if (!q) return ["頭の行「## 問い（<ラベル>）」・問いの文（1行）・回答内容の節（「### 案」「### 確かめること」「### 済ませること」のどれか）と1行1つ・<details> の判断材料のほかに行がある"];
  const f = forms[q.kind];
  if (!f) return [`ラベルは ${Object.keys(forms).join("・")} のどれか`];
  const want = f.sections.map((s) => s.name);
  const reasons = q.rows.map((r) => r.attrs.filter(([n]) => n === "推奨" || n === "理由"));
  const plans = q.header === "### 案";
  return [by && f.by !== by && `${q.kind}の問いは${f.by}だけが出す`,
    (q.header !== f.header || (f.header && !q.rows.length)) && (f.header ? `${q.kind}は「${f.header}」を1行1つ以上書く` : `${q.kind}は回答内容の節を書かない`),
    f.text && q.text !== f.text && `${q.kind}の問いの文は「${f.text}」`,
    plans && q.rows.length < 2 && "案は2つ以上",
    plans && reasons.some((r) => r.length !== 1) && "どの案にも「- 推奨:」か「- 理由:」を1つ",
    plans && reasons.flat().filter(([n]) => n === "推奨").length !== 1 && "推奨はちょうど1つ",
    JSON.stringify(sectionsOf(q.material).map((s) => s.name)) !== JSON.stringify(want) && `判断材料の節は ${want.join("・")} をこの順に1つずつ`].filter(Boolean);
}

// 答えのない問いのラベルを見せる印（ゲートだけが付け外しする。回答フォームのラベルの欄には出さない）。
const LABEL = "問い: ";
export const questionLabel = (kind) => `${LABEL}${kind}`;
export const isQuestionLabel = (name) => name.startsWith(LABEL);

// 次遷移（回答フォームの「この issue を」のボタンの言葉）。キーは答えの「次遷移:」の行とゲートの決め方の名前。完了は、確かめることを並べた問いだけ。
export const NEXT = { 続ける: "続ける", 保留: "保留する", 見送り: "見送る", 完了: "完了にする" };
export const nextsOf = (q) => Object.keys(NEXT).filter((n) => n !== "完了" || q.header === "### 確かめること");
const plansOf = (q) => (q.header === "### 案" ? q.rows.map((r) => r.text) : []);
// 答えの入力が問いに足りているか（回答フォームと、答えの記録 .claude/skills/ask/scripts/answer.mjs が同じに照らす）。足りなければ理由。
// 次遷移はいつも要り、案は問いの案のどれかか、選ばない（選ばずに次遷移だけでも受ける）。
export function answerProblem(q, { next, plan }) {
  if (!nextsOf(q).includes(next)) return `この issue をどうするか（${nextsOf(q).map((n) => NEXT[n]).join("・")}）を選んでください。`;
  return plan && !plansOf(q).includes(plan) ? `案にない答えです（案: ${plansOf(q).join(" / ")}）。` : null;
}
// 答えのコメント（.claude/skills/ask/SKILL.md「答え」の形）。次遷移・選んだ案・コメントの3つの欄を、空でも省かずに置く。完了なら、問いの確かめることを
// 全部「- 確かめた:」で並べる。コメントは「コメント:」の行のあとに形を付けずにそのまま置き、ゲートは読まない。
export function answerBody(q, { next, plan, labels = "", text = "" }) {
  return ["## 回答", `**${q.text}**`, "", `次遷移: ${next}`, `選んだ案: ${plan || (plansOf(q).length ? "選ばなかった" : "なし（問いに案が無い）")}`,
    ...(next === "完了" ? q.rows.map((r) => `- 確かめた: ${r.text}`) : []), ...(labels ? [`ラベル: ${labels}`] : []), text ? `コメント:\n${text}` : "コメント: なし"].join("\n");
}
export const APPLIED = "答えに書いた文を Claude が読んだので、答えを当てました"; // 書いた文のある答えを当てた印（二度は当てない）
export const isAnswer = (t) => /^## 回答\n/.test(norm(t));
// 答えのコメントを読む: 決定（次遷移）・確かめた条件・コメント。決まった欄は最初の「コメント:」の行より前にだけあり、そのあとは全部コメント
// （コメントの中に欄に似た行があっても、欄として読まない）。次遷移の無い答えは、決定を続けるとし、頭のあとを全部コメントとして読む。
function parseAnswer(text) {
  const lines = norm(text).split("\n");
  if (!isAnswer(text)) return null;
  const k = lines.findIndex((l) => /^コメント:/.test(l));
  const fixed = k < 0 ? [] : lines.slice(0, k);
  const next = fixed.map((l) => /^次遷移: (.+)$/.exec(l)?.[1].trim()).find(Boolean);
  if (!next) return { decision: "続ける", confirmed: [], text: lines.slice(/^\*\*.+\*\*$/.test(lines[1] ?? "") ? 2 : 1).join("\n").trim() };
  const said = [lines[k].replace(/^コメント:\s*/, ""), ...lines.slice(k + 1)].join("\n").trim();
  return { decision: next, confirmed: fixed.map((l) => /^- 確かめた: (.+)$/.exec(l)?.[1].trim()).filter(Boolean), text: said === "なし" ? "" : said };
}
export const answerText = (text) => parseAnswer(text)?.text ?? "";

// コメントの並びから今の問いと、その答え（無ければ null）。ラベルの形に合わない問いは問いとして読まない（残す守り: 問いの形の検査）。by は今の問いの
// 書き手（渡したときだけ、ラベルの出す者と照らす）。問いは、ラベルの形と、回答内容の節の行（rows）を持つ。
export function latestQuestion(comments, forms, by = null) {
  const i = comments.findLastIndex(isQuestion);
  if (i < 0 || checkQuestion(forms, comments[i], by).length) return null;
  const p = parseQuestion(comments[i]);
  return { kind: p.kind, text: p.text, material: p.material, header: p.header, rows: p.rows, form: forms[p.kind],
    answer: comments.slice(i + 1).map(parseAnswer).find(Boolean) ?? null };
}

// ゲートが出す問い（形の「出す者」がゲートのもの）。形の決まった値をそのまま使い、問いの文は text（続行の相手の番号）、確かめることはユーザーが
// 確かめる条件（conds。src/questions.js: confirmConditions）の文と見る所と要点（書かれていない条件も隠さずにそう出す）で埋める。
const NO_LOOK = "書かれていません";
export const askText = (kind, forms, conds = [], text = forms[kind].text) =>
  render(kind, text, forms[kind].header, conds.map((c) => ({ text: c.text, attrs: [["見る所と要点", c.look ?? NO_LOOK]] })), forms[kind].sections);

// 待つ相手（前提・子）が見送りで閉じたときの続行の問いの文。相手の番号を入れ、同じ文の問いが既にあれば二度は問わない
// （答えで「続ける」を選んだあとも、相手は見送りのまま残るため）。
export const droppedQuestion = (numbers) => `待っていた ${numbers.map((n) => `#${n}`).join("・")} が見送りで閉じました。この issue を続けますか？`;
// 続行の問いの文から、問うた相手の番号（その問いでなければ null）。
export function droppedOf(text) {
  const numbers = /^待っていた (\S+) が/.exec(text)?.[1].split("・").map((n) => Number(n.slice(1)));
  return numbers && droppedQuestion(numbers) === text ? numbers : null;
}
