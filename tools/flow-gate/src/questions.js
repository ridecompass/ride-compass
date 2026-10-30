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
// 本文の「やること」の節（.claude/skills/file-issue/SKILL.md「issue の形」）の項目。項目は節の中の字下げの無い番号付きの行から、次の項目の
// 前までで、字下げした続きの行のうち「- 行き先: 」で始まる行が行き先。字下げの無い箇条の行（前提の1行等）は項目に数えない。
// name は番号と文の頭（番号を振り直した並びが節に2つあっても見分ける）。
const STEP = /^(\d+)\. (.+)$/;
const TO = /^- 行き先: (.+)$/;
function steps(body) {
  const lines = bodyRest(body).split("\n");
  const from = lines.findIndex((l) => l.trim().startsWith("<details><summary>やること</summary>"));
  if (from < 0) return [];
  const to = lines.findIndex((l, k) => k > from && l.trim() === "</details>");
  const all = [];
  for (const l of lines.slice(from + 1, to < 0 ? undefined : to)) {
    const m = STEP.exec(l);
    const t = TO.exec(l.trim());
    if (m) all.push({ name: `${m[1]}「${m[2].slice(0, 20)}」`, to: [] });
    else if (t && indent(l) && all.length) all.at(-1).to.push(t[1].trim());
  }
  return all;
}
// 行き先を名指していない「やること」の項目の name（ゲートは、これが残る間は完成で閉じない）。行き先は、今の完了の条件の文の頭に当たる
// 「完了の条件「<条件の文の頭>」」か、ほかの issue の「#<番号>」か、理由を添えた「見送り（<理由>）」。
export function unboundSteps(body, number) {
  const texts = conditions(body).map((c) => c.text);
  const named = (to) => {
    const c = /^完了の条件「(.+)」$/.exec(to);
    if (c) return texts.some((t) => t.startsWith(c[1]));
    const n = /^#(\d+)(?!\d)/.exec(to);
    return n ? Number(n[1]) !== number : /^見送り（.+）$/.test(to);
  };
  return steps(body).filter((s) => !s.to.some(named)).map((s) => s.name);
}
// 本文の、index の行のチェックに印を付ける（同じ文の条件が2つあっても、指した行にだけ付ける）。
// 本文の完了の条件の行に値（チェック）を書いた本文。marks は [条件の行, 済んだか] の並び。本文の頭の回答のボタンは残す。
export function markLines(body, marks) {
  const lines = bodyRest(body).split("\n");
  for (const [k, done] of marks) lines[k] = lines[k].replace(/- \[[ x]\] /, done ? "- [x] " : "- [ ] ");
  return (splitBody(body).foreign.length ? "" : (BLOCK.exec(norm(body))?.[0] ?? "")) + lines.join("\n");
}
export const remaining = (body) => conditions(body).filter((c) => !c.done);
export const confirmConditions = (body) => remaining(body).filter((c) => c.verify === "ユーザー");
// Claude が条件の文の頭で指した行に印を付けた本文（.claude/skills/task-work/scripts/check.mjs）。指せるのは残りの条件のうちちょうど1つに
// 当たるものだけで、ユーザーが確かめる行（ユーザーが値を入れる）は指せない。
// 本文の頭の回答のボタンは残す。合わなければ problems を返し、本文は返さない。
export function checkByText(body, heads) {
  const left = remaining(body);
  const problems = [];
  const indexes = [];
  for (const h of heads) {
    const hit = left.filter((c) => c.text.startsWith(h.trim()));
    if (!h.trim()) problems.push("空の頭では指せない");
    else if (hit.length !== 1) problems.push(`「${h}」に当たる残りの条件が ${hit.length} 個（1個に決まる頭で指す）`);
    else if (hit[0].verify === "ユーザー") problems.push(`「${h}」はユーザーが確かめる条件（ユーザーが値を入れる）`);
    else indexes.push(hit[0].index);
  }
  return problems.length ? { problems } : { body: markLines(body, indexes.map((k) => [k, true])) };
}

// 問い: 頭の行「## 問い（<ラベル>）」・問いの文1行・（あれば）回答内容の節（SECTIONS のどれか1つを1行1つ。行の下に字下げした属性の行
// 「- <名前>: <値>」を置ける）・（あれば）<details> の判断材料。読めなければ、読めなかった所を文にした例外を投げる。
const SECTIONS = ["### 案", "### 確かめること", "### 済ませること"];
const ATTRIBUTE = /^\s+- ([^:]+): (.+)$/;
function parseQuestion(text) {
  const all = norm(text).trim();
  const cut = all.indexOf("<details>");
  const [head, question, header, ...lines] = (cut < 0 ? all : all.slice(0, cut)).split("\n").filter((l) => l.trim());
  const kind = /^## 問い（(.+)）\s*$/.exec(head ?? "")?.[1];
  if (!kind) throw new Error("頭の行は「## 問い（<ラベル>）」");
  if (!question || /^\s*(#|- )/.test(question)) throw new Error("頭の行の次に、問いの文を1行で書く");
  if (header !== undefined && !SECTIONS.includes(header.trim())) throw new Error(`回答内容の節は ${SECTIONS.map((x) => `「${x}」`).join("")} のどれか（「${header.trim()}」）`);
  const rows = [];
  for (const line of lines) {
    const a = ATTRIBUTE.exec(line);
    if (a && rows.length) rows.at(-1).attrs.push([a[1].trim(), a[2].trim()]);
    else if (/^- \S/.test(line)) rows.push({ text: line.slice(2).trim(), attrs: [] });
    else throw new Error(`回答内容の節の行は「- 」で始める（「${line.trim()}」）`);
  }
  const material = cut < 0 ? "" : /^<details>\s*<summary>[^<]*<\/summary>([\s\S]*?)<\/details>$/.exec(all.slice(cut))?.[1].trim();
  if (material === undefined) throw new Error("判断材料は「<details><summary>判断材料</summary>」で始めて「</details>」で閉じ、そのあとに行を書かない");
  return { kind, text: question.trim(), header: header?.trim() ?? null, rows, material };
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
    let q;
    try {
      q = parseQuestion(at < 0 ? "" : all.slice(at));
    } catch (e) {
      throw new Error(`問いの形が読めない（${all.split("\n")[0]}）: ${e.message}`);
    }
    forms[q.kind] = { by: /^出す者: (.+)$/m.exec(all.slice(0, at))?.[1].trim() ?? null, header: q.header, text: HOLE.test(q.text) ? null : q.text, sections: sectionsOf(q.material) };
  }
  return forms;
}
// 問いの頭の行と、問いの組み立て（rows は回答内容の節の行と属性、material は判断材料の節の名前と中身の並び）。
export const questionHead = (kind) => `## 問い（${kind}）`;
const render = (kind, text, header, rows, material) => [`${questionHead(kind)}\n${text}`,
  header && [header, ...rows.flatMap((r) => [`- ${r.text}`, ...r.attrs.map(([n, v]) => `  - ${n}: ${v}`)])].join("\n"),
  `<details><summary>判断材料</summary>\n\n${material.map((s) => `**${s.name}**: ${s.value}`).join("\n\n")}\n</details>`].filter(Boolean).join("\n\n");

// 問いの書き手（ゲートか Claude）。ゲートは App の名義で書く（GraphQL は名義を [bot] の付かない形で返す）。
export const askerOf = (config, login) => (login === config.gateBot.replace(/\[bot\]$/, "") ? "ゲート" : "Claude");
// 問いが読めるか。読めない所を返す（空なら読める）。読めるのは、頭の行・問いの文・節の形が取れ、ラベルを知っていて、回答内容の節がラベルの書く節
// だけ（1行1つ以上）で、書き手（by。渡したときだけ）がラベルの出す者のもの。回答内容の節の見出しが、フォームに出すものと答えに書くものを決める。
// ゲートと回答フォームは読める問いを読み、形の決まりに外れた所は無いものとして扱う（推奨の無い案は印を付けない等）。
export function readProblems(forms, text, by = null) {
  let q;
  try {
    q = parseQuestion(text);
  } catch (e) {
    return [e.message];
  }
  const f = forms[q.kind];
  if (!f) return [`ラベルは ${Object.keys(forms).join("・")} のどれか（「${q.kind}」）`];
  return [(q.header !== f.header || (f.header && !q.rows.length)) && (f.header ? `${q.kind}は「${f.header}」を1行1つ以上書く` : `${q.kind}は回答内容の節を書かない`),
    by && f.by !== by && `${q.kind}の問いは${f.by}だけが出す`].filter(Boolean);
}
// 問いがラベルの形に合うか。合わない所を返す（空なら合う）。問いを出す前に照らす（.claude/skills/ask/scripts/ask.mjs）。読めるかに加えて照らすのは、
// 決まった問いの文・判断材料の節の名前と順と、案の決まり（2つ以上。どの案にも「推奨」か「理由」を1つ。推奨はちょうど1つ）。
export function checkQuestion(forms, text, by = null) {
  const unread = readProblems(forms, text, by);
  if (unread.length) return unread;
  const q = parseQuestion(text);
  const f = forms[q.kind];
  const want = f.sections.map((s) => s.name);
  const reasons = q.rows.map((r) => r.attrs.filter(([n]) => n === "推奨" || n === "理由"));
  const plans = q.header === "### 案";
  return [f.text && q.text !== f.text && `${q.kind}の問いの文は「${f.text}」`,
    plans && q.rows.length < 2 && "案は2つ以上",
    plans && reasons.some((r) => r.length !== 1) && "どの案にも「- 推奨:」か「- 理由:」を1つ",
    plans && reasons.flat().filter(([n]) => n === "推奨").length !== 1 && "推奨はちょうど1つ",
    JSON.stringify(sectionsOf(q.material).map((s) => s.name)) !== JSON.stringify(want) && `判断材料の節は ${want.join("・")} をこの順に1つずつ`].filter(Boolean);
}

// 答えのない問いのラベルを見せる印（ゲートだけが付け外しする。回答フォームのラベルの欄には出さない）。
const LABEL = "問い: ";
export const questionLabel = (kind) => `${LABEL}${kind}`;
export const isQuestionLabel = (name) => name.startsWith(LABEL);

// 次遷移（回答フォームの「この issue を」のボタンの言葉）。キーは答えの「次遷移:」の行とゲートの決め方の名前。完了は次遷移に無く、約束が全部
// 果たされたらゲートが事実から決める。
export const NEXT = { 続ける: "続ける", 保留: "保留する", 見送り: "見送る" };
const plansOf = (q) => (q.header === "### 案" ? q.rows.map((r) => r.text) : []);
// YES／NO で答える回答内容の節（既定は NO）。確かめることの値は本文のユーザーが確かめる約束の値で、答えと一緒に本文へ書く（withValues）。
// 済ませることは約束ではないので、値を答えに書く。
const valued = (q) => q.header === "### 確かめること" || q.header === "### 済ませること";
export const withValues = (body, q, yes) => (q.header !== "### 確かめること" ? body
  : markLines(body, conditions(body).filter((c) => c.verify === "ユーザー" && q.rows.some((r) => r.text === c.text)).map((c) => [c.index, yes.includes(c.text)])));
// 答えの入力が問いに足りているか（回答フォームと、答えの記録 .claude/skills/ask/scripts/answer.mjs が同じに照らす）。足りなければ理由。
// 次遷移はいつも要り、案は問いの案のどれかか、選ばない（選ばずに次遷移だけでも受ける）。YES の行は問いの YES／NO で答える行のどれか。
export function answerProblem(q, { next, plan, yes = [] }) {
  if (!Object.hasOwn(NEXT, next ?? "")) return `この issue をどうするか（${Object.values(NEXT).join("・")}）を選んでください。`;
  if (plan && !plansOf(q).includes(plan)) return `案にない答えです（案: ${plansOf(q).join(" / ")}）。`;
  const rows = valued(q) ? q.rows.map((r) => r.text) : [];
  return yes.some((c) => !rows.includes(c)) ? `問いにない行です（${rows.join(" / ") || "YES／NO で答える行はありません"}）。` : null;
}
// 答えのコメント（.claude/skills/ask/SKILL.md「答え」の形）。次遷移・選んだ案・コメントの3つの欄を、空でも省かずに置く。済ませることは、行ごとに値を
// 「- YES: <行>」「- NO: <行>」で並べる。コメントは「コメント:」の行のあとに形を付けずにそのまま置き、ゲートは読まない。
export function answerBody(q, { next, plan, yes = [], labels = "", text = "" }) {
  return ["## 回答", `**${q.text}**`, "", `次遷移: ${next}`, `選んだ案: ${plan || (plansOf(q).length ? "選ばなかった" : "なし（問いに案が無い）")}`,
    ...(q.header === "### 済ませること" ? ["済ませること:", ...q.rows.map((r) => `- ${yes.includes(r.text) ? "YES" : "NO"}: ${r.text}`)] : []), ...(labels ? [`ラベル: ${labels}`] : []), text ? `コメント:\n${text}` : "コメント: なし"].join("\n");
}
export const APPLIED = "答えに書いた文を Claude が読んだので、答えを当てました"; // 書いた文のある答えを当てた印（二度は当てない）
export const isAnswer = (t) => /^## 回答\n/.test(norm(t));
// 答えのコメントを読む: 決定（次遷移）・コメント（回答内容の欄は遷移先が読み、ゲートは読まない）。決まった欄は最初の「コメント:」の行より前にだけあり、そのあとは全部コメント
// （コメントの中に欄に似た行があっても、欄として読まない）。コメントが無いのは「コメント: なし」の1行のときだけ。次遷移が無いか、決まった値で
// ない答えは、決定を続けるとし、頭のあとを全部コメントとして Claude へ渡す（黙って捨てない）。
function parseAnswer(text) {
  const lines = norm(text).split("\n");
  if (!isAnswer(text)) return null;
  const k = lines.findIndex((l) => /^コメント:/.test(l));
  const fixed = k < 0 ? [] : lines.slice(0, k);
  const next = fixed.map((l) => /^次遷移: (.+)$/.exec(l)?.[1].trim()).find(Boolean);
  if (!Object.hasOwn(NEXT, next ?? "")) return { decision: "続ける", text: lines.slice(/^\*\*.+\*\*$/.test(lines[1] ?? "") ? 2 : 1).join("\n").trim() };
  const said = lines[k] === "コメント: なし" && k === lines.length - 1 ? "" : [lines[k].replace(/^コメント:\s*/, ""), ...lines.slice(k + 1)].join("\n").trim();
  return { decision: next, text: said };
}
export const answerText = (text) => parseAnswer(text)?.text ?? "";

// コメントの並びから今の問いと、その答え（無ければ null）。by は今の問いの書き手（渡したときだけ、ラベルの出す者と照らす）。問いは、ラベルの形と、
// 回答内容の節の行（rows）を持つ。読めない問いも答えを待つ問いで、読めない所（problems）を持ち、ラベルの形を持たず、回答内容を無いものとする
// （回答フォームは書く欄と次遷移だけで答えを受け、ゲートはその次遷移で決める）。
export function latestQuestion(comments, forms, by = null) {
  const i = comments.findLastIndex(isQuestion);
  if (i < 0) return null;
  const problems = readProblems(forms, comments[i], by);
  const p = problems.length ? looseQuestion(comments[i]) : parseQuestion(comments[i]);
  return { kind: forms[p.kind] ? p.kind : null, text: p.text, material: p.material, header: p.header, rows: p.rows, form: problems.length ? null : forms[p.kind], problems,
    answer: comments.slice(i + 1).map(parseAnswer).find(Boolean) ?? null };
}

// 読めない問いから読めるだけ読む: 頭の行のラベル・問いの文（頭の次の空でない行）・判断材料。
function looseQuestion(text) {
  const all = norm(text).trim();
  const lines = all.split("\n");
  return { kind: /^## 問い(?:（(.+)）)?/.exec(lines[0])?.[1] ?? null, text: lines.slice(1).find((l) => l.trim())?.trim() ?? "", header: null, rows: [],
    material: /<details>\s*<summary>[^<]*<\/summary>([\s\S]*?)<\/details>/.exec(all)?.[1].trim() ?? "" };
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
