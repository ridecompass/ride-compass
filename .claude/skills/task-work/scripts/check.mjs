// 完了の条件の行に印を付ける。条件は文の頭で指し、ゲートと同じ読み方で、残りの条件のうちちょうど1つに当たる行にだけ付ける
// （tools/flow-gate/src/questions.js: checkByText。ユーザーが確かめる行と子が受け持つ行は断る）。合わなければ書かずに理由を出して 1 で終わる。
// 使い方: node .claude/skills/task-work/scripts/check.mjs <issue の番号> <条件の文の頭> [<条件の文の頭> ...]
import { execFileSync } from "node:child_process";
import { checkByText } from "../../../../tools/flow-gate/src/questions.js";

const [number, ...heads] = process.argv.slice(2);
if (!/^\d+$/.test(number ?? "") || !heads.length) {
  console.error("使い方: node .claude/skills/task-work/scripts/check.mjs <issue の番号> <条件の文の頭> [<条件の文の頭> ...]");
  process.exit(2);
}
if (!process.env.FLOW_BOT_TOKEN) {
  console.error("FLOW_BOT_TOKEN が無いので書かない（置き場へは hidakagit-bot の名義で書く）");
  process.exit(1);
}
const gh = (args, input) => execFileSync("gh", args, { input, encoding: "utf8", env: { ...process.env, GH_TOKEN: process.env.FLOW_BOT_TOKEN } });
const R = "ridecompass/ride-compass-tasks";
const result = checkByText(gh(["issue", "view", number, "-R", R, "--json", "body", "-q", ".body"]), heads);
if (result.problems) {
  console.error(`印を付けない: ${result.problems.join("・")}`);
  process.exit(1);
}
gh(["issue", "edit", number, "-R", R, "--body-file", "-"], result.body);
console.log(`#${number}: ${heads.length}行に印を付けた`);
