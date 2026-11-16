// issue の本文の読み書き（本文の頭の回答のボタンの印・完了の条件・折り畳み・やることと言葉の行き先・チェックの印）。書き方は .claude/skills/file-issue/SKILL.md「issue の形」。
export const norm = (t) => (t ?? "").replace(/\r\n/g, "\n");
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
// 本文の畳んだ節（.claude/skills/file-issue/SKILL.md「issue の形」）。節は字下げの無い <details> の行から、入れ子の <details> を数えて対になる
// </details> の行までで、入れ子は節の中身に数える。name は節の頭の <summary> の中身（<details> と同じ行でも次の行でもよい。無ければ undefined）、
// lines は頭と終わりの間の行。閉じない節は本文の終わりまで。コードの中（`…` と ``` の囲み）の綴りは開き・閉じに数えない（本文はタグを綴りで語る）。
const OPEN = /<details[\s>]/g;
const CLOSE = /<\/details>/g;
const FENCE = /^\s*(```|~~~)/;
export function folds(body) {
  const lines = bodyRest(body).split("\n");
  const all = [];
  let depth = 0;
  let from = -1;
  let fenced = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const l = line.replace(/`[^`]*`/g, "");
    if (!depth && l.startsWith("<details")) {
      from = i;
      all.push({ name: /^<details>\s*<summary>(.+?)<\/summary>/.exec(lines.slice(i, i + 2).join("\n"))?.[1], lines: lines.slice(i + 1) });
    }
    depth = Math.max(0, depth + (l.match(OPEN)?.length ?? 0) - (l.match(CLOSE)?.length ?? 0));
    if (!depth && from >= 0) {
      all.at(-1).lines = lines.slice(from + 1, i);
      from = -1;
    }
  });
  return all;
}
// 行き先を持つ項目（.claude/skills/file-issue/SKILL.md「issue の形」）: 本文の「やること」の節の字下げの無い番号付きの行と、「ユーザーの言葉」の
// 節の字下げの無い箇条の行。項目は次の項目の前までで、字下げした続きの行のうち「- 行き先: 」で始まる行が行き先。「やること」の字下げの無い
// 箇条の行（前提の1行等）は項目に数えない。section は節の名前、name は節と項目の文の頭（番号を振り直した並びが節に2つあっても見分ける。
// 言葉は引用の「」の部分）、text は項目の文。
const STEP = /^(\d+)\. (.+)$/;
const WORD = /^- (.+)$/;
const TO = /^- 行き先: (.+)$/;
const KINDS = [["やること", (l) => STEP.exec(l), (m) => `やることの ${m[1]}「${m[2].slice(0, 20)}」`, (m) => m[2]],
  ["ユーザーの言葉", (l) => !TO.test(l) && WORD.exec(l), (m) => `ユーザーの言葉の ${(/^「[^」]*」/.exec(m[1])?.[0] ?? m[1]).slice(0, 22)}`, (m) => m[1]]];
function items(body) {
  const all = [];
  const fs = folds(body);
  for (const [section, head, name, text] of KINDS) {
    let last = null;
    for (const l of fs.find((f) => f.name === section)?.lines ?? []) {
      const m = head(l);
      const t = TO.exec(l.trim());
      if (m) all.push(last = { section, name: name(m), text: text(m).trim(), to: [] });
      else if (t && indent(l) && last) last.to.push(t[1].trim());
    }
  }
  return all;
}
// 行き先が当たるか: 今の完了の条件の文の頭に当たる「完了の条件「<条件の文の頭>」」か、ほかの issue の「#<番号>」か、理由を添えた「見送り（<理由>）」。
// unboundSteps は行き先を名指していない項目の name（ゲートは、これが残る間は完成で閉じない）。
const conditionHead = (to) => /^完了の条件「(.+)」$/.exec(to)?.[1];
function naming(body, number) {
  const texts = conditions(body).map((c) => c.text);
  return (to) => {
    const c = conditionHead(to);
    if (c) return texts.some((t) => t.startsWith(c));
    const n = /^#(\d+)(?!\d)/.exec(to);
    return n ? Number(n[1]) !== number : /^見送り（.+）$/.test(to);
  };
}
export function unboundSteps(body, number) {
  const named = naming(body, number);
  return items(body).filter((s) => !s.to.some(named)).map((s) => s.name);
}
// 行き先を書いたのに、どれも当たらない項目の name（書いた時点で照らす: 起票の new-issue.mjs と、条件に印を付ける check.mjs）。
// 行き先がまだ無い項目は数えない（起票のときに決まらなければ、着手した実装担当が書く）。
export function misboundSteps(body, number) {
  const named = naming(body, number);
  return items(body).filter((s) => s.to.length && !s.to.some(named)).map((s) => s.name);
}
// 本文の、index の行のチェックに印を付ける（同じ文の条件が2つあっても、指した行にだけ付ける）。
// 本文の完了の条件の行に値（チェック）を書いた本文。marks は [条件の行, 済んだか] の並び。本文の頭の回答のボタンは残す。
export function markLines(body, marks) {
  const lines = bodyRest(body).split("\n");
  for (const [k, done] of marks) lines[k] = lines[k].replace(/- \[[ x]\] /, done ? "- [x] " : "- [ ] ");
  return (splitBody(body).foreign.length ? "" : (BLOCK.exec(norm(body))?.[0] ?? "")) + lines.join("\n");
}
export const remaining = (body) => conditions(body).filter((c) => !c.done);
// ユーザーが確かめる残りの条件と、それぞれを行き先にしたユーザーの言葉の文（words。確かめの問いで見る所と要点の前に並べる）。
export function confirmConditions(body) {
  const words = items(body).filter((s) => s.section === "ユーザーの言葉");
  const names = (c) => (to) => {
    const h = conditionHead(to);
    return Boolean(h) && c.text.startsWith(h);
  };
  return remaining(body).filter((c) => c.verify === "ユーザー").map((c) => ({ ...c, words: words.filter((w) => w.to.some(names(c))).map((w) => w.text) }));
}
// 見る所と要点に、書く者が埋める印（「<…>」・「（…で埋める）」）が残るか。ゲートは、残る条件があれば確かめを問わない。
// 自動のリンク（<https://…>）は印に数えない。
export const unfilled = (c) => /<(?!https?:)[^<>\n]+>|（[^）\n]*で埋める）/.test(c.look ?? "");
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
