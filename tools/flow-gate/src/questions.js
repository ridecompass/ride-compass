// 問いと答えの形（.claude/skills/ask/SKILL.md「問い」）。問いの頭は「## 問い（種類）」で、種類ごとの形は tools/flow-gate/question_forms/ のファイルが持つ。
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
const answerUrl = (config, number) => `${config.urls.form}/answer?issue=${number}`;
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

// 問い: 頭の行「## 問い（<種類>）」・問いの文1行・（あれば）答えの節（「### 案」か「### 項目」と1行1つ）・（あれば）<details> の判断材料。ほかの行があれば null。
const HEADERS = ["### 案", "### 項目"];
function parseQuestion(text) {
  const all = norm(text).trim();
  const cut = all.indexOf("<details>");
  const [head, ...lines] = (cut < 0 ? all : all.slice(0, cut)).split("\n");
  const kind = /^## 問い（(.+)）\s*$/.exec(head)?.[1];
  if (!kind) return null;
  const [question, header, ...rows] = lines.map((l) => l.trim()).filter(Boolean);
  if (!question || /^(#|- )/.test(question)) return null;
  if (header !== undefined && (!HEADERS.includes(header) || !rows.length || rows.some((l) => !l.startsWith("- ")))) return null;
  const material = cut < 0 ? "" : /^<details>\s*<summary>[^<]*<\/summary>([\s\S]*?)<\/details>$/.exec(all.slice(cut))?.[1].trim();
  return material === undefined ? null : { kind, text: question, header: header ?? null, rows: rows.map((l) => l.slice(2).trim()), material };
}

// 種類ごとの形（tools/flow-gate/question_forms/ のファイルの中身）を種類で引けるようにする。「## 問い」の行より前は形の決まり（「<名前>: <値>」の行）で、
// そこから下が問いの骨組み。骨組みの中で値の全体が「<…>」のもの（問いの文・答えの行・判断材料の節）は書く者が埋め、ほかは決まった値。
// 決まり「答えの意味」は、答えの文ごとの決定（続ける・保留・見送り・完了）で、ここに無い答えは「続ける」（Claude が読んで進める）。
// 答えの節が「### 項目」の形は、答えの意味をちょうど1つ持ち、その文がチェックの文になる。
const HOLE = /^<[\s\S]*>$/;
export function loadForms(texts) {
  const forms = {};
  for (const t of texts) {
    const all = norm(t);
    const at = all.search(/^## 問い/m);
    const meta = Object.fromEntries([...all.slice(0, Math.max(at, 0)).matchAll(/^(\S+): (.+)$/gm)].map((m) => [m[1], m[2].trim()]));
    const q = parseQuestion(at < 0 ? "" : all.slice(at));
    if (!q?.header) throw new Error(`問いの形が読めない（骨組みと答えの節が要る）: ${all.split("\n")[0]}`);
    const meaning = Object.fromEntries((meta["答えの意味"] ?? "").split("・").filter(Boolean).map((x) => x.split(": ").map((v) => v.trim())));
    const check = q.header === "### 項目" ? Object.keys(meaning)[0] : null;
    if (q.header === "### 項目" && Object.keys(meaning).length !== 1) throw new Error(`「### 項目」の形は、答えの意味をちょうど1つ持つ: ${q.kind}`);
    forms[q.kind] = { by: meta["出す者"] ?? null, check, meaning, text: HOLE.test(q.text) ? null : q.text, header: q.header, rows: q.rows.some((r) => HOLE.test(r)) ? null : q.rows, sections: sectionsOf(q.material) };
  }
  return forms;
}
// 問いの頭の行と、問いの組み立て（判断材料は節の名前と中身の並び）。
export const questionHead = (kind) => `## 問い（${kind}）`;
export const render = (kind, text, header, rows, material) => `${questionHead(kind)}\n${text}\n\n${header}\n${rows.map((r) => `- ${r}`).join("\n")}\n\n` +
  `<details><summary>判断材料</summary>\n\n${material.map((s) => `**${s.name}**: ${s.value}`).join("\n\n")}\n</details>`;

// 問いが種類の形に合うか。合わない所を返す（空なら合う）。答えの節（案の無い判断も含む）・決まった問いの文と答えの行・判断材料の節の名前と順を照らす。
export function checkQuestion(forms, text) {
  const q = parseQuestion(text);
  if (!q) return ["頭の行「## 問い（<種類>）」・問いの文（1行）・答えの節（「### 案」か「### 項目」）と1行1つ・<details> の判断材料のほかに行がある"];
  const f = forms[q.kind];
  if (!f) return [`種類は ${Object.keys(forms).join("・")} のどれか`];
  const want = f.sections.map((s) => s.name);
  return [q.header !== f.header && `${q.kind}の答えの節は「${f.header}」と1行1つ`,
    f.text && q.text !== f.text && `${q.kind}の問いの文は「${f.text}」`,
    f.rows && q.header === f.header && JSON.stringify(q.rows) !== JSON.stringify(f.rows) && `${q.kind}の「${f.header}」は ${f.rows.join("・")}`,
    JSON.stringify(sectionsOf(q.material).map((s) => s.name)) !== JSON.stringify(want) && `判断材料の節は ${want.join("・")} をこの順に1つずつ`].filter(Boolean);
}

// 答えのない問いの種類を見せるラベル（ゲートだけが付け外しする。回答フォームのラベルの欄には出さない）。
const LABEL = "問い: ";
export const questionLabel = (kind) => `${LABEL}${kind}`;
export const isQuestionLabel = (name) => name.startsWith(LABEL);

// 答え: 決定（続ける・保留・見送り・完了）・確かめた項目・書いた文。前の形の「次のステータス:」「- 問題なし:」の行も読む。
// 書いた文は、決まった形の行のほかの全部（前の形の「補足:」「- 問題あり:」も入る）。ゲートは文の中身を読まず、Claude が読むまで決定を当てない。
export const NONE = "どれでもない（書く欄に書く）"; // 書く者が立てた案の問いで、どの案でもないとき
// 答えの入力が問いに足りているか（回答フォームと、チャットの答えの記録 .claude/skills/ask/scripts/answer.mjs が同じに照らす）。足りなければ理由。
// 項目の問いはチェックか書いた文で答え、案の問いは案から選ぶ（書く者が立てた案なら、選ばずに書いた文だけでもよい）。ゲートは最初の「回答:」行を
// 読むので、選ぶこととチェックは同じ答えに並べない。
export function answerProblem(q, { choice, done, text }) {
  const { check, rows } = q.form;
  if (check) {
    if (choice) return `この問いに選ぶ案はありません（「${check}」のチェックを付けるか、書く欄に書いてください）。`;
    return done || text ? null : `「${check}」のチェックを付けるか、書く欄に書いてください。`;
  }
  if (done) return "チェックは、項目の並ぶ問いにだけ使えます。";
  if (rows) return q.rows.includes(choice) ? null : `選べるのは ${q.rows.join("・")} です。`;
  if (choice && ![...q.rows, NONE].includes(choice)) return `案にない答えです（案: ${[...q.rows, NONE].join(" / ")}）。`;
  return (!choice || choice === NONE) && !text ? "どれでもないときは、書く欄に書いてください。" : null;
}
// 答えのコメント（.claude/skills/ask/SKILL.md「答え」の形）。書いた文は形を付けずに、決まった形の行の塊のあとの空行の後ろにそのまま置く。
// 「回答:」の行はいつも置き（選ばずに書いた文だけで答えたときも）、塊が空にならないようにする（書いた文の頭が塊として読まれない）。
// チェックを付けたら、問いの項目を全部「- 確かめた:」で並べる。
export function answerBody(q, { choice, done, labels = "", text = "" }) {
  const { check } = q.form;
  const lines = ["## 回答", `**${q.text}**`, ""];
  if (done) lines.push(`回答: ${check}`, ...q.rows.map((item) => `- 確かめた: ${item}`));
  else lines.push(`回答: ${choice || NONE}`);
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
// 答えの決定は、形の「答えの意味」で引く（無ければ「続ける」）。
function parseAnswer(text, q) {
  const all = norm(text);
  if (!isAnswer(all)) return null;
  const { fixed, text: said } = splitAnswer(all);
  const picked = (fixed.map((l) => /^(?:回答|次のステータス): (.+)$/.exec(l)?.[1]).find(Boolean) ?? "").trim();
  const decision = q.form.meaning[picked] ?? "続ける";
  const confirmed = fixed.map((l) => /^- (?:確かめた|問題なし): (.+)$/.exec(l)?.[1]?.trim()).filter(Boolean);
  return { decision, confirmed, text: said };
}

// コメントの並びから今の問いと、その答え（無ければ null）。種類の形（forms）に合わない問いは問いとして読まない（残す守り: 問いの形の検査）。
// 問いは、形と答えの節の行（rows。形の check があれば項目、無ければ案）を持つ。
export function latestQuestion(comments, forms) {
  const i = comments.findLastIndex(isQuestion);
  if (i < 0 || checkQuestion(forms, comments[i]).length) return null;
  const p = parseQuestion(comments[i]);
  const form = forms[p.kind];
  const q = { kind: p.kind, text: p.text, material: p.material, form, rows: p.rows };
  return { ...q, answer: comments.slice(i + 1).map((c) => parseAnswer(c, q)).find(Boolean) ?? null };
}

// ゲートが出す問い（採否・確かめ・イレギュラー）。形の決まった値をそのまま使い、書く者が埋める所は、ユーザーが確かめる条件（conds。
// src/questions.js: confirmConditions）で埋める: 答えの行は条件の文、判断材料の節は条件ごとの文と見る所と要点（書かれていない条件も隠さずにそう出す）。
const NO_LOOK = "書かれていません";
const listed = (conds) => conds.map((c) => `\n- ${c.text}\n  - 見る所と要点: ${c.look ?? NO_LOOK}`).join("");
export function askText(kind, forms, conds = []) {
  const f = forms[kind];
  return render(kind, f.text, f.header, f.rows ?? conds.map((c) => c.text), f.sections.map((s) => (HOLE.test(s.value) ? { ...s, value: listed(conds) } : s)));
}

// 待つ相手（前提・子）が見送りで閉じたときの判断の問い。問いの文に相手の番号を入れ、同じ文の問いが既にあれば二度は問わない
// （答えで「続ける」を選んだあとも、相手は見送りのまま残るため）。
export const droppedQuestion = (numbers) => `待っていた ${numbers.map((n) => `#${n}`).join("・")} が見送りで閉じました。この issue を続けますか？`;
// 見送りの判断の問いの文から、問うた相手の番号（その問いでなければ null）。
export function droppedOf(text) {
  const numbers = /^待っていた (\S+) が/.exec(text)?.[1].split("・").map((n) => Number(n.slice(1)));
  return numbers && droppedQuestion(numbers) === text ? numbers : null;
}
const DROPPED = {
  何の話か: "この issue が待っていた相手（前提か子）が見送りで閉じ、その結果を当てにしていた作業を続けるかを決める必要があります。",
  利用者への約束: "当てにしていた結果が無いまま、黙って作り進めない。", 問題が起きる場面: "前の結果を使う作業を、前が無いまま作る。", 起きない場面: "待っていた相手が完成で閉じたとき。",
  進行中の作業との関係: "見送りで閉じた相手の issue。", 答えごとに起きること: "続ける: 待つ相手を除いて決め直す。保留する: 保留へ。見送る: この issue も閉じる。",
};
export const askDropped = (numbers, forms) => render("判断", droppedQuestion(numbers), forms.判断.header, ["続ける", "保留する", "見送る"],
  forms.判断.sections.map((s) => ({ name: s.name, value: DROPPED[s.name] ?? "なし" })));
