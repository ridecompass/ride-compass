// 完了の条件の行に印を付ける。条件は文の頭で指し、ゲートと同じ読み方で、残りの条件のうちちょうど1つに当たる行にだけ付ける
// （tools/flow-gate/src/questions.js: checkByText。ユーザーが確かめる行は断る）。合わなければ書かずに理由を出して 1 で終わる。
// 読んでから書くまでに本文が変わっていたら（ゲートや担当が書いた）、上書きせずに打ち直させる。
// 使い方: node .claude/skills/task-work/scripts/check.mjs <issue の番号> <条件の文の頭> [<条件の文の頭> ...]
import { bot, config, isNumber, usage } from "../../../../tools/flow-gate/src/bot.js";
import { checkByText, misboundSteps } from "../../../../tools/flow-gate/src/questions.js";

// 印を付けて、書いたことか書かなかった理由を返す。
function check(gh, number, heads) {
  // gh の -q は本文の後ろに改行を足して出すので、落としてから書き戻す（落とさないと印を付けるたびに末尾へ改行が積もる）。
  const read = () => gh(["issue", "view", number, "-R", config.tasks, "--json", "body", "-q", ".body"]).replace(/\n+$/, "");
  const before = read();
  // 当たらない行き先が残ると、条件が全部済んでもゲートが閉じずに実装担当へ戻すので、印を付ける前に直させる。
  const misbound = misboundSteps(before, Number(number));
  if (misbound.length) return { error: `印を付けない: やることの ${misbound.join("・")} の行き先が、完了の条件の文の頭・#<番号>・見送り（<理由>）のどれにも当たらない（行き先を直してから打ち直す）` };
  const result = checkByText(before, heads);
  if (result.problems) return { error: `印を付けない: ${result.problems.join("・")}` };
  if (read() !== before) return { error: `#${number} の本文が読んだあとに変わったので、上書きしない（打ち直す）` };
  // REST で書けば1回で済む（gh issue edit は issue を引く1回と書く1回を打つ）。
  gh(["api", `repos/${config.tasks}/issues/${number}`, "-X", "PATCH", "-F", "body=@-", "--silent"], result.body);
  return { done: `#${number}: ${heads.length}行に印を付けた` };
}

function main() {
  const [number, ...heads] = process.argv.slice(2);
  if (!isNumber(number) || !heads.length) usage("node .claude/skills/task-work/scripts/check.mjs <issue の番号> <条件の文の頭> [<条件の文の頭> ...]");
  const { error, done } = check(bot(), number, heads);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log(done);
}

main();
