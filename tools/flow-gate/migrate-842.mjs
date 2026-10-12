// 使い捨て（tasks#842 の段階2）: ゲートを公開した直後に1回流し、流したらこのファイルを消す。開いた issue を次の2つの形へ一度で直す。
// - 前の形の問い: 最新の「## 問い」が種類ごとの形（question_forms/）に合わなければ直す。採否・確かめ・イレギュラー（ゲートが出す）は、ゲートと同じ
//   組み立て（src/questions.js: askText）で書き直す。確かめの項目は本文のユーザーが確かめる条件（残りがあれば残り、無ければ全部）。判断は、前の形の節
//   「案ごとに起きること」を「答えごとに起きること」へ名を変えて形の位置へ移す。それでも形に合わないものは直さずに出す（置き換え先は人が決める）。
// - 子の約束（C4）: 親の完了の条件の行のうち「- 子: #<子>」の付いた行を、文とチェックを変えずに子の本文の完了の条件へ移管し、親から消す。
//   子の本文に同じ文の条件があれば足さない（流し直してよい）。
// 読むのは開いた issue の一覧（100件ごとに1回）、書くのはまとめた書き込み（25件ごとに1回）。既定は直す中身を出すだけで、--write のときだけ書く。
// 使い方: node tools/flow-gate/migrate-842.mjs [--write]
import { execFileSync } from "node:child_process";
import { config } from "./src/bot.js";
import { askText, checkQuestion, conditions, isQuestion, norm } from "./src/questions.js";

const write = process.argv.includes("--write");
const { owner, name } = config.repos.tasks;
// 開いた issue の本文とコメントをまとめて読むので、応答は 1MB（execFileSync の既定の上限）を超える。
const gql = (query, variables) => {
  const out = execFileSync("gh", ["api", "graphql", "--input", "-"], { input: JSON.stringify({ query, variables }), encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GH_TOKEN: process.env.FLOW_BOT_TOKEN } });
  const r = JSON.parse(out);
  if (r.errors) throw new Error(JSON.stringify(r.errors));
  return r.data;
};

const GATE = ["採否", "確かめ", "イレギュラー"];
function question(text, body) {
  const head = /^## 問い(?:（(.+)）)?/.exec(text)?.[1] ?? "判断";
  if (GATE.includes(head)) {
    const mine = conditions(body).filter((c) => c.verify === "ユーザー");
    const left = mine.filter((c) => !c.done);
    return askText(head, config.questionForms, left.length ? left : mine);
  }
  const moved = /\n\n\*\*案ごとに起きること\*\*:([\s\S]*?)(?=\n\n\*\*[^*]+\*\*:|\n<\/details>)/.exec(text);
  const rest = (moved ? text.replace(moved[0], "") : text).replace(/^## 問い(?:（判断）)?/, "## 問い（判断）");
  return moved ? rest.replace(/\n<\/details>\s*$/, `\n\n**答えごとに起きること**:${moved[1]}\n</details>`) : rest;
}

// 本文の完了の条件の塊（チェックの行から、それより深く字下げした続きの行まで）のうち、「- 子: #<子>」の行を持つもの。
const CHECK = /^(\s*)- \[([ x])\] (.+)$/;
function childBlocks(body) {
  const lines = norm(body).split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = CHECK.exec(lines[i]);
    if (!m) continue;
    let end = i;
    for (let j = i + 1; j < lines.length && !CHECK.test(lines[j]) && (!lines[j].trim() || /^\s*/.exec(lines[j])[0].length > m[1].length); j++) if (lines[j].trim()) end = j;
    const child = lines.slice(i + 1, end + 1).map((l) => /^\s*- 子: #(\d+)\s*$/.exec(l)?.[1]).find(Boolean);
    if (child) blocks.push({ from: i, to: end, child: Number(child), lines: lines.slice(i, end + 1).filter((l) => !/^\s*- 子: #\d+\s*$/.test(l)) });
    i = end;
  }
  return { lines, blocks };
}
// 子の本文の完了の条件の節へ行を足す（節が無ければ節を作る）。
function withConditions(body, rows) {
  const text = norm(body).trimEnd();
  const head = "<details><summary>完了の条件</summary>";
  const at = text.indexOf(head);
  if (at < 0) return `${text}\n\n${head}\n\n${rows.join("\n")}\n\n</details>\n`;
  const close = text.indexOf("</details>", at);
  return `${text.slice(0, close).trimEnd()}\n${rows.join("\n")}\n\n${text.slice(close)}\n`;
}

// 開いた issue と、その子（閉じた子も）の本文・最新のコメント。
const issues = [];
for (let after = null; ;) {
  const r = gql(`query($o:String!,$n:String!,$a:String){repository(owner:$o,name:$n){issues(states:OPEN,first:100,after:$a){pageInfo{hasNextPage endCursor}
    nodes{id number body comments(last:40){nodes{id body}} subIssues(first:50){nodes{id number body}}}}}}`, { o: owner, n: name, a: after }).repository.issues;
  issues.push(...r.nodes);
  if (!r.pageInfo.hasNextPage) break;
  after = r.pageInfo.endCursor;
}

const ops = []; // [書き込みの名前, 入力の型, 入力, 知らせ]
const bodies = new Map(); // 書き換える本文（issue の id → 本文）。子は複数の親の行を受けうるので、ここで重ねる
const nodeOf = new Map(issues.flatMap((i) => [[i.number, i], ...i.subIssues.nodes.map((k) => [k.number, k])]));
for (const issue of issues) {
  const last = issue.comments.nodes.findLast((c) => isQuestion(c.body));
  const text = last && norm(last.body).trim();
  if (text && checkQuestion(config.questionForms, text).length) {
    const next = question(text, issue.body);
    const problems = checkQuestion(config.questionForms, next);
    if (problems.length) console.log(`#${issue.number} の問いは直せない（人が決める）: ${problems.join("・")}`);
    else ops.push(["updateIssueComment", "UpdateIssueCommentInput", { id: last.id, body: next }, `#${issue.number} の問いを直す: ${text.split("\n")[0]}`]);
  }
  const { lines, blocks } = childBlocks(issue.body);
  if (!blocks.length) continue;
  for (const b of blocks) {
    const child = nodeOf.get(b.child);
    if (!child) {
      console.log(`#${issue.number} の行の子 #${b.child} が見つからない（親子でない）。直さずに残す: ${b.lines[0].trim()}`);
      continue;
    }
    const now = bodies.get(child.id) ?? child.body;
    const rows = b.lines;
    const have = conditions(now).some((c) => c.text === conditions(rows.join("\n"))[0]?.text);
    if (!have) bodies.set(child.id, withConditions(now, rows));
    console.log(`#${issue.number} → #${b.child} へ移管: ${b.lines[0].trim()}${have ? "（子に同じ文があるので足さない）" : ""}`);
  }
  const moved = new Set(blocks.filter((b) => nodeOf.get(b.child)).flatMap((b) => Array.from({ length: b.to - b.from + 1 }, (_, k) => b.from + k)));
  bodies.set(issue.id, lines.filter((_, k) => !moved.has(k)).join("\n"));
}
// tasks#824 の移行で子の本文に書いた「子は完了の条件を持たない。…」の行は、C4 では誤りなので消す。
const OLD = /^子は完了の条件を持たない。.*\n?/m;
for (const node of nodeOf.values()) {
  const now = bodies.get(node.id) ?? node.body;
  if (OLD.test(norm(now))) bodies.set(node.id, norm(now).replace(OLD, ""));
}
for (const [id, body] of bodies) ops.push(["updateIssue", "UpdateIssueInput", { id, body }, `本文を直す: ${id}`]);

console.log(`書き込み ${ops.length} 件${write ? "" : "（--write を付けると書く）"}`);
// 書かないときは、直す中身を標準エラーへ JSON で出す（書く前に目で確かめる）。
if (!write) console.error(JSON.stringify(ops.map(([op, , input, note]) => ({ op, note, body: input.body })), null, 1));
if (write) {
  for (let k = 0; k < ops.length; k += 25) {
    const part = ops.slice(k, k + 25);
    gql(`mutation(${part.map(([, type], j) => `$v${j}:${type}!`).join(",")}){${part.map(([op], j) => `w${j}:${op}(input:$v${j}){clientMutationId}`).join(" ")}}`,
      Object.fromEntries(part.map(([, , input], j) => [`v${j}`, input])));
  }
  console.log("書いた");
}
