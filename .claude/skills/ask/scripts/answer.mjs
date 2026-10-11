// チャットで決めたことを、今の問いへの答えの形で記録する。組み立てと照らしは回答フォームと同じ（tools/flow-gate/src/questions.js:
// answerProblem・answerBody）。合わなければ書かずに理由を出して 1 で終わる。
// 使い方: node .claude/skills/ask/scripts/answer.mjs <issue の番号> [--choice <選んだ案か選択肢>] [--done] [--text <書いた文のファイル>]
//   --done は確かめの「完了にする」（残りのユーザーが確かめる条件を全部確かめた）。書いた文のファイルには、ユーザーの言葉の引用を含めて書く。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { answerBody, answerProblem, confirmItems, latestQuestion, norm } from "../../../../tools/flow-gate/src/questions.js";

const USAGE = "使い方: node .claude/skills/ask/scripts/answer.mjs <issue の番号> [--choice <選んだ案か選択肢>] [--done] [--text <書いた文のファイル>]";
const [number, ...rest] = process.argv.slice(2);
const opts = { done: false };
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--done") opts.done = true;
  else if (rest[i] === "--choice") opts.choice = rest[++i];
  else if (rest[i] === "--text") opts.text = norm(readFileSync(rest[++i], "utf8")).trim();
  else opts.bad = rest[i];
}
if (!/^\d+$/.test(number ?? "") || opts.bad) {
  console.error(USAGE);
  process.exit(2);
}
if (!process.env.FLOW_BOT_TOKEN) {
  console.error("FLOW_BOT_TOKEN が無いので書かない（置き場へは hidakagit-bot の名義で書く）");
  process.exit(1);
}
const gh = (args, input) => execFileSync("gh", args, { input, encoding: "utf8", env: { ...process.env, GH_TOKEN: process.env.FLOW_BOT_TOKEN } });
const R = "ridecompass/ride-compass-tasks";
const template = norm(readFileSync(new URL("../../../../tools/flow-gate/question_template.md", import.meta.url), "utf8"));
const issue = JSON.parse(gh(["issue", "view", number, "-R", R, "--json", "body,comments"]));
const q = latestQuestion(issue.comments.map((c) => c.body), template);
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
gh(["issue", "comment", number, "-R", R, "--body-file", "-"], answerBody(q, answer));
console.log(`#${number}: 「${q.text}」への答えを書いた`);
