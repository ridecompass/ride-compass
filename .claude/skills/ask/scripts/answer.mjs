// チャットで決めたことを、今の問いへの答えの形で記録する。組み立てと照らしは回答フォームと同じ（tools/flow-gate/src/questions.js:
// answerProblem・answerBody）。合わなければ書かずに理由を出して 1 で終わる。
// 使い方: node .claude/skills/ask/scripts/answer.mjs <issue の番号> --next <続ける|保留|見送り|完了> [--plan <選んだ案>] [--text <書いた文のファイル>]
//   --next は回答フォームの「この issue を」（完了は、確かめることを並べた問いだけ）。書いた文のファイルには、ユーザーの言葉の引用を含めて書く。
import { readFileSync } from "node:fs";
import { bot, comment, config, graphqlData, isMain, isNumber, usage } from "../../../../tools/flow-gate/src/bot.js";
import { answerBody, answerProblem, askerOf, isQuestion, latestQuestion, norm } from "../../../../tools/flow-gate/src/questions.js";

// コメントと書いた者を新しい方から1ページ読む。今の問いは末尾にあるので、読んだ中に問いが無いときだけ前のページを足す。
const READ = "query($owner:String!,$name:String!,$number:Int!,$before:String){repository(owner:$owner,name:$name){issue(number:$number){" +
  "comments(last:100,before:$before){pageInfo{hasPreviousPage startCursor} nodes{body author{login}}}}}}";
function read(gh, number) {
  const { owner, name } = config.repos.tasks;
  const page = (before) => graphqlData(gh, READ, { owner, name, number: Number(number), before }).repository.issue.comments;
  let { nodes, pageInfo } = page(null);
  while (!nodes.some((c) => isQuestion(c.body)) && pageInfo.hasPreviousPage) {
    const earlier = page(pageInfo.startCursor);
    nodes = [...earlier.nodes, ...nodes];
    pageInfo = earlier.pageInfo;
  }
  return nodes;
}

const USAGE = "node .claude/skills/ask/scripts/answer.mjs <issue の番号> --next <続ける|保留|見送り|完了> [--plan <選んだ案>] [--text <書いた文のファイル>]";

function main() {
  const [number, ...rest] = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--next" && rest[i + 1] !== undefined) opts.next = rest[++i];
    else if (rest[i] === "--plan" && rest[i + 1] !== undefined) opts.plan = rest[++i];
    else if (rest[i] === "--text" && rest[i + 1] !== undefined) opts.text = norm(readFileSync(rest[++i], "utf8")).trim();
    else opts.bad = rest[i];
  }
  if (!isNumber(number) || opts.bad) usage(USAGE);
  const gh = bot();
  // ゲートと同じく、形に合わない問いと、ラベルの出す者でない者が書いた問いは読まない。
  const nodes = read(gh, number);
  const asked = nodes.findLast((c) => isQuestion(c.body));
  const q = latestQuestion(nodes.map((c) => c.body), config.questionForms, asked && askerOf(config, asked.author?.login));
  if (!q || q.answer) {
    console.error(`#${number} に、答えていない問いがありません`);
    process.exit(1);
  }
  const problem = answerProblem(q, opts);
  if (problem) {
    console.error(`答えを書かない: ${problem}`);
    process.exit(1);
  }
  comment(gh, number, answerBody(q, opts));
  console.log(`#${number}: 「${q.text}」への答えを書いた`);
}

if (isMain(import.meta.url)) main();
