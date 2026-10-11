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
// （Markdown と同じく、続きの間の空行も同じ条件に数える）。続きの行のうち「- 確かめる: 」「- 子: 」で始まる行だけが属性で、ほかは条件の文の続き。
// 属性を行の外に置くのは、文の中の記号と混ざらないため。index はチェックの行が本文（bodyRest）の何行目か（印はこの行に付ける）。
const CHECK = /^(\s*)- \[([ x])\] (.+)$/;
const ATTR = /^- (確かめる|子): (.+)$/;
const indent = (l) => /^\s*/.exec(l)[0].length;
export function conditions(body) {
  const lines = bodyRest(body).split("\n");
  const all = [];
  for (let i = 0; i < lines.length; i++) {
    const m = CHECK.exec(lines[i]);
    if (!m) continue;
    const c = { index: i, text: [m[3].trim()], done: m[2] === "x", verify: "Claude", child: null };
    for (;;) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length || CHECK.test(lines[j]) || indent(lines[j]) <= m[1].length) break;
      i = j;
      const t = lines[i].trim();
      const a = ATTR.exec(t);
      if (a?.[1] === "確かめる") c.verify = a[2].trim() === "ユーザー" ? "ユーザー" : "Claude";
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
export const confirmItems = (body) => remaining(body).filter((c) => c.verify === "ユーザー").map((c) => c.text);

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

// 答え: 決定（続ける・保留・見送り）と、確かめなら項目ごとの「問題なし・問題あり」。前の形の「次のステータス:」の行も読む。
function parseAnswer(text) {
  const all = norm(text);
  if (!/^## 回答\n/.test(all)) return null;
  const picked = /^(?:回答|次のステータス): (.+)$/m.exec(all)?.[1] ?? "";
  const decision = /見送/.test(picked) ? "見送り" : /保留/.test(picked) ? "保留" : "続ける";
  const items = [...all.matchAll(/^- (問題なし|問題あり): (.+?)(?: — (.+))?$/gm)].map((m) => ({ ok: m[1] === "問題なし", text: m[2], note: m[3] ?? "" }));
  return { decision, items };
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
    "決めないまま進めると、要らないものを作る。", "ユーザーの起票・改善・段階（決めずに進める）。", "着手する: 未着手になり担当が振り出される。保留する: 保留へ。見送る: 閉じる。", "着手するかの判断は本文で決まる。"],
  確かめ: ["完成にしてよいですか？", "完了の条件のうち、ユーザーが確かめる条件だけが残っています。項目ごとに見て、問題の有無を答えてください。",
    "完成は、完了の条件が全部満たされたときだけ。", "見ないまま完成にすると、思ったものと違うまま閉じる。", "条件がユーザーの確かめを持たないとき。",
    "全部問題なし: 印を付けて完成。問題ありの項目がある: 直す行を条件に足して未着手。", "本文の完了の条件のうち、「- 確かめる: ユーザー」の付いた条件。"],
  イレギュラー: ["担当が、問いも Pull Request も出さず、条件も満たさずに終わりました。どうしますか？", "直前の「担当の終わり」のコメントに、実行へのリンクと担当の最後の発言があります。",
    "落ちた担当を黙って振り出し直さず、ユーザーが次を決める。", "同じ形で何度も落ちる。", "担当が問いか Pull Request を出したとき。",
    "やり直す: 未着手へ戻し振り出す。保留する: 保留へ。見送る: 閉じる。", "直前の「担当の終わり」のコメント。"],
};
const material = (template, facts) => sections(template).map((n, i) => `**${n}**: ${facts[i] ?? "なし"}`).join("\n\n");
export function askText(kind, template) {
  const [question, ...facts] = ASKS[kind];
  return `## 問い（${kind}）\n${question}\n\n<details><summary>判断材料</summary>\n\n${material(template, facts)}\n</details>`;
}

// 待つ相手（前提・子）が見送りで閉じたときの判断の問い。問いの文に相手の番号を入れ、同じ文の問いが既にあれば二度は問わない
// （答えで「続ける」を選んだあとも、相手は見送りのまま残るため）。
export const droppedQuestion = (numbers) => `待っていた ${numbers.map((n) => `#${n}`).join("・")} が見送りで閉じました。この issue を続けますか？`;
export const askDropped = (numbers, template) => `## 問い（判断）\n${droppedQuestion(numbers)}\n\n### 案\n- 続ける\n- 保留する\n- 見送る\n\n<details><summary>判断材料</summary>\n\n${material(template, [
  "この issue が待っていた相手（前提か子）が見送りで閉じ、その結果を当てにしていた作業を続けるかを決める必要があります。", "当てにしていた結果が無いまま、黙って作り進めない。",
  "前の結果を使う作業を、前が無いまま作る。", "待っていた相手が完成で閉じたとき。",
  "続ける: 待つ相手を除いて決め直す。保留する: 保留へ。見送る: この issue も閉じる。", "見送りで閉じた相手の issue。"])}\n</details>`;
