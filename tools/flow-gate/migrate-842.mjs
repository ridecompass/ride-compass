// 使い捨て（tasks#842 の段階2）: ゲートを公開した直後に1回流し、流したらこのファイルを消す。流したときに開いている issue を全部読み、決まりに
// 当たるものをその場で導いて、次の形へ一度で直す（番号は持たない）。
// - 前の形の答え: 「次遷移:」の行の無い答えを、次遷移・選んだ案・コメントの3つの欄へ直す。前の形の読み方（選んだ文字に「見送」があれば見送り、
//   「保留」があれば保留、「完了にする」なら完了、ほかは続ける。決まった形の行の塊のあとは書いた文）で読み、直したあとに書いた文が変わらないことを照らす。
// - 前の形の問い: 答えの無い最新の「## 問い」がラベルの形（question_forms/）に合わなければ直す。ゲートが出すラベル（採否・確かめ・イレギュラー・続行）は
//   ゲートと同じ組み立て（src/questions.js: askText）で書き直す（確かめることは本文のユーザーが確かめる条件。残りがあれば残り、無ければ全部。前の形の
//   判断のうち見送りの相手を問うものは続行へ）。操作は回答内容の節の名前を「### 済ませること」へ直す。判断（案ごとの推奨と理由が無い）と、ラベルの
//   出す者でない者が書いた問いは直さずに出す（問い直すのは人か Claude）。答えのある問いは、当てた結果が残っているので直さない。
// - 子の約束（C4）: 親の完了の条件の行のうち「- 子: #<子>」の付いた行を、文とチェックを変えずに子の本文の完了の条件へ移管し、親から消す。
//   子の本文に同じ文の条件があれば足さない（流し直してよい）。
// 読むのは開いた issue の一覧（100件ごとに1回）、書くのはまとめた書き込み（25件ごとに1回）。既定は直す中身を出すだけで、--write のときだけ書く。
// 使い方: node tools/flow-gate/migrate-842.mjs [--write]
import { bot, config, graphqlData, isMain } from "./src/bot.js";
import { batch } from "./src/gate.js";
import { pages } from "./src/github.js";
import { answerText, askText, askerOf, checkQuestion, conditions, droppedOf, isAnswer, isQuestion, norm } from "./src/questions.js";

const write = process.argv.includes("--write");
const { owner, name } = config.repos.tasks;
// 前の形の答えを今の形へ。読み方は前のゲート（tasks#842 段階1）の決まった形の行の塊と同じ。
const OLD_FIELD = /^(?:(?:回答|次のステータス): .+|- (?:確かめた|問題なし): .+|ラベル: .*)$/;
const NOT_PLAN = ["", "着手する", "やり直す", "続ける", "済ませた", "完了にする", "完了にしない", "どれでもない（書く欄に書く）"];
export function answerNow(text) {
  const lines = norm(text).split("\n");
  let k = /^\*\*.+\*\*$/.test(lines[1] ?? "") ? 2 : 1;
  while (k < lines.length && !lines[k].trim()) k++;
  let end = k;
  while (end < lines.length && lines[end].trim()) end++;
  const block = lines.slice(k, end).map((l) => l.trim());
  const fixed = block.every((l) => OLD_FIELD.test(l)) ? block : [];
  const said = lines.slice(k + fixed.length).join("\n").trim();
  const picked = (fixed.map((l) => /^(?:回答|次のステータス): (.+)$/.exec(l)?.[1]).find(Boolean) ?? "").trim();
  const next = /見送/.test(picked) ? "見送り" : /保留/.test(picked) ? "保留" : picked === "完了にする" ? "完了" : "続ける";
  const labels = fixed.map((l) => /^ラベル: (.*)$/.exec(l)?.[1]).find((x) => x !== undefined);
  const body = [lines.slice(0, k).join("\n").trimEnd(), "", `次遷移: ${next}`, `選んだ案: ${next === "続ける" && !NOT_PLAN.includes(picked) ? picked : "なし（前の形の答え）"}`,
    ...fixed.map((l) => /^- (?:確かめた|問題なし): (.+)$/.exec(l)?.[1]).filter(Boolean).map((c) => `- 確かめた: ${c}`), ...(labels ? [`ラベル: ${labels}`] : []),
    said ? `コメント:\n${said}` : "コメント: なし"].join("\n");
  return answerText(body) === said ? body : null;
}

// 答えの無い前の形の問いを、今のラベルの形へ（直せなければ null）。
export function questionNow(text, body) {
  const head = /^## 問い(?:（(.+)）)?/.exec(text)?.[1] ?? "判断";
  const line = text.split("\n")[1]?.trim() ?? "";
  if (droppedOf(line)) return askText("続行", config.questionForms, [], line);
  if (config.questionForms[head]?.by === "ゲート") {
    const mine = conditions(body).filter((c) => c.verify === "ユーザー");
    const left = mine.filter((c) => !c.done);
    return askText(head, config.questionForms, left.length ? left : mine);
  }
  if (head !== "操作") return null;
  // 前の形の節のうち、今の形に無いもの（頼む理由・答えごとに起きること）は消し、頼む理由の中身は「何の話か」へ移す（中身を落とさない）。
  const section = /\n\n\*\*([^*]+)\*\*: ([\s\S]*?)(?=\n\n\*\*[^*]+\*\*:|\n<\/details>)/g;
  const reason = [...text.matchAll(section)].find((m) => m[1] === "頼む理由")?.[2];
  const kept = new Set(config.questionForms.操作.sections.map((s) => s.name));
  return text.replace(/^### 項目$/m, "### 済ませること").replace(section, (m, n) => (!kept.has(n) ? "" : n === "何の話か" && reason ? `${m} 頼む理由: ${reason}` : m));
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

// 打たれたときだけ動く（読み込んだだけでは GitHub を読まない）。
async function main() {
  const gh = bot();
  // 開いた issue と、その子（閉じた子も）の本文・最新のコメント。
  const issues = await Array.fromAsync(pages({ gql: async (q, v) => graphqlData(gh, q, v) }, `query($o:String!,$n:String!,$a:String){repository(owner:$o,name:$n){
    issues(states:OPEN,first:100,after:$a){pageInfo{hasNextPage endCursor} nodes{id number body comments(last:40){nodes{id body author{login}}} subIssues(first:50){nodes{id number body}}}}}}`,
  { o: owner, n: name }, (d) => d.repository.issues));

  const ops = []; // [書き込みの名前, 入力の型, 入力, 知らせ]
  const bodies = new Map(); // 書き換える本文（issue の id → 本文）。子は複数の親の行を受けうるので、ここで重ねる
  const nodeOf = new Map(issues.flatMap((i) => [[i.number, i], ...i.subIssues.nodes.map((k) => [k.number, k])]));
  for (const issue of issues) {
    const nodes = issue.comments.nodes;
    for (const c of nodes.filter((n) => isAnswer(n.body) && !/^次遷移: /m.test(norm(n.body)))) {
      const now = answerNow(c.body);
      if (now) ops.push(["updateIssueComment", "UpdateIssueCommentInput", { id: c.id, body: now }, `#${issue.number} の答えを直す: ${norm(c.body).split("\n")[1]}`]);
      else console.log(`#${issue.number} の答えは直せない（書いた文が変わる）: ${norm(c.body).split("\n")[1]}`);
    }
    const k = nodes.findLastIndex((n) => isQuestion(n.body));
    const last = k < 0 ? null : nodes[k];
    const by = last && askerOf(config, last.author?.login);
    const text = last && norm(last.body).trim();
    if (text && !nodes.slice(k + 1).some((n) => isAnswer(n.body)) && checkQuestion(config.questionForms, text, by).length) {
      const now = questionNow(text, issue.body);
      const problems = now ? checkQuestion(config.questionForms, now, by) : ["前の形の判断（案ごとの推奨と理由が無い）"];
      if (problems.length) console.log(`#${issue.number} の問いは直せない（問い直す）: ${problems.join("・")}`);
      else ops.push(["updateIssueComment", "UpdateIssueCommentInput", { id: last.id, body: now }, `#${issue.number} の問いを直す: ${text.split("\n")[0]}`]);
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
      graphqlData(gh, ...batch(ops.slice(k, k + 25)));
    }
    console.log("書いた");
  }
}

if (isMain(import.meta.url)) await main();
