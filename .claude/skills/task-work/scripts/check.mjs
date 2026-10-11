// 完了の条件の行に印を付ける。条件は文の頭で指し、ゲートと同じ読み方で、残りの条件のうちちょうど1つに当たる行にだけ付ける
// （tools/flow-gate/src/questions.js: checkByText。ユーザーが確かめる行と子が受け持つ行は断る）。合わなければ書かずに理由を出して 1 で終わる。
// 読んでから書くまでに本文が変わっていたら（ゲートや担当が書いた）、上書きせずに打ち直させる。
// 使い方: node .claude/skills/task-work/scripts/check.mjs <issue の番号> <条件の文の頭> [<条件の文の頭> ...]
import { bot, config, isMain } from "../../../../tools/flow-gate/src/bot.js";
import { checkByText } from "../../../../tools/flow-gate/src/questions.js";

function main() {
  const [number, ...heads] = process.argv.slice(2);
  if (!/^\d+$/.test(number ?? "") || !heads.length) {
    console.error("使い方: node .claude/skills/task-work/scripts/check.mjs <issue の番号> <条件の文の頭> [<条件の文の頭> ...]");
    process.exit(2);
  }
  const gh = bot();
  const read = () => gh(["issue", "view", number, "-R", config.tasks, "--json", "body", "-q", ".body"]);
  const before = read();
  const result = checkByText(before, heads);
  if (result.problems) {
    console.error(`印を付けない: ${result.problems.join("・")}`);
    process.exit(1);
  }
  if (read() !== before) {
    console.error(`#${number} の本文が読んだあとに変わったので、上書きしない（打ち直す）`);
    process.exit(1);
  }
  gh(["issue", "edit", number, "-R", config.tasks, "--body-file", "-"], result.body);
  console.log(`#${number}: ${heads.length}行に印を付けた`);
}

if (isMain(import.meta.url)) main();
