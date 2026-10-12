// チャットで決めたことを、今の問いへの答えの形で記録する。組み立てと照らしは回答フォームと同じ（tools/flow-gate/src/questions.js:
// answerProblem・answerBody）。合わなければ書かずに理由を出して 1 で終わる。
// 使い方: node .claude/skills/ask/scripts/answer.mjs <issue の番号> [--choice <選んだ案か選択肢>] [--done] [--text <書いた文のファイル>]
//   --done は確かめの「完了にする」（残りのユーザーが確かめる条件を全部確かめた）。書いた文のファイルには、ユーザーの言葉の引用を含めて書く。
import { readFileSync } from "node:fs";
import { bot, comment, config, graphqlData, isMain, isNumber, usage } from "../../../../tools/flow-gate/src/bot.js";
import { answerBody, answerProblem, confirmItems, isQuestion, latestQuestion, norm } from "../../../../tools/flow-gate/src/questions.js";

// 本文とコメントを新しい方から1ページ読む。今の問いは末尾にあるので、読んだ中に問いが無いときだけ前のページを足す（本文は最初だけ読む）。
const READ = "query($owner:String!,$name:String!,$number:Int!,$before:String,$first:Boolean!){repository(owner:$owner,name:$name){issue(number:$number){" +
  "body @include(if:$first) comments(last:100,before:$before){pageInfo{hasPreviousPage startCursor} nodes{body}}}}}";
function read(gh, number) {
  const { owner, name } = config.repos.tasks;
  const page = (before) => graphqlData(gh, READ, { owner, name, number: Number(number), before, first: !before }).repository.issue;
  const issue = page(null);
  let { nodes, pageInfo } = issue.comments;
  while (!nodes.some((c) => isQuestion(c.body)) && pageInfo.hasPreviousPage) {
    const earlier = page(pageInfo.startCursor).comments;
    nodes = [...earlier.nodes, ...nodes];
    pageInfo = earlier.pageInfo;
  }
  return { body: issue.body, comments: nodes.map((c) => c.body) };
}

const USAGE = "node .claude/skills/ask/scripts/answer.mjs <issue の番号> [--choice <選んだ案か選択肢>] [--done] [--text <書いた文のファイル>]";

function main() {
  const [number, ...rest] = process.argv.slice(2);
  const opts = { done: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--done") opts.done = true;
    else if (rest[i] === "--choice" && rest[i + 1] !== undefined) opts.choice = rest[++i];
    else if (rest[i] === "--text" && rest[i + 1] !== undefined) opts.text = norm(readFileSync(rest[++i], "utf8")).trim();
    else opts.bad = rest[i];
  }
  if (!isNumber(number) || opts.bad) usage(USAGE);
  const gh = bot();
  const issue = read(gh, number);
  const q = latestQuestion(issue.comments, config.questionTemplate);
  if (!q || q.answer) {
    console.error(`#${number} に、答えていない問いがありません`);
    process.exit(1);
  }
  const answer = { ...opts, items: opts.done ? confirmItems(issue.body) : [] };
  const problem = answerProblem(q, answer);
  if (problem) {
    console.error(`答えを書かない: ${problem}`);
    process.exit(1);
  }
  comment(gh, number, answerBody(q, answer));
  console.log(`#${number}: 「${q.text}」への答えを書いた`);
}

if (isMain(import.meta.url)) main();
