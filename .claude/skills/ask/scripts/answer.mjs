// チャットで決めたことを、今の問いへの答えの形で記録する。組み立てと照らしは回答フォームと同じ（tools/flow-gate/src/questions.js:
// answerProblem・answerBody）。合わなければ書かずに理由を出して 1 で終わる。
// 使い方: node .claude/skills/ask/scripts/answer.mjs <issue の番号> [--choice <選んだ案か選択肢>] [--done] [--text <書いた文のファイル>]
//   --done は項目の並ぶ問いのチェック（確かめなら「完了にする」で、問いの項目を全部確かめた）。書いた文のファイルには、ユーザーの言葉の引用を含めて書く。
import { readFileSync } from "node:fs";
import { bot, config, isMain, questionForms } from "../../../../tools/flow-gate/src/bot.js";
import { answerBody, answerProblem, latestQuestion, norm } from "../../../../tools/flow-gate/src/questions.js";

const USAGE = "使い方: node .claude/skills/ask/scripts/answer.mjs <issue の番号> [--choice <選んだ案か選択肢>] [--done] [--text <書いた文のファイル>]";

function main() {
  const [number, ...rest] = process.argv.slice(2);
  const opts = { done: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--done") opts.done = true;
    else if (rest[i] === "--choice" && rest[i + 1] !== undefined) opts.choice = rest[++i];
    else if (rest[i] === "--text" && rest[i + 1] !== undefined) opts.text = norm(readFileSync(rest[++i], "utf8")).trim();
    else opts.bad = rest[i];
  }
  if (!/^\d+$/.test(number ?? "") || opts.bad) {
    console.error(USAGE);
    process.exit(2);
  }
  const gh = bot();
  const issue = JSON.parse(gh(["issue", "view", number, "-R", config.tasks, "--json", "comments"]));
  const q = latestQuestion(issue.comments.map((c) => c.body), questionForms);
  if (!q || q.answer) {
    console.error(`#${number} に、答えていない問いがありません`);
    process.exit(1);
  }
  const problem = answerProblem(q, opts);
  if (problem) {
    console.error(`答えを書かない: ${problem}`);
    process.exit(1);
  }
  gh(["issue", "comment", number, "-R", config.tasks, "--body-file", "-"], answerBody(q, opts));
  console.log(`#${number}: 「${q.text}」への答えを書いた`);
}

if (isMain(import.meta.url)) main();
