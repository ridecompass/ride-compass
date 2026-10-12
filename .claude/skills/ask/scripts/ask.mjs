// 問いを種類の形（tools/flow-gate/question_forms/）で照らし、合えば置き場の issue へコメントで出す。合わなければ出さず、合わない所を出して終わる。
// ゲートが問いとして読むのと同じ照らし方（tools/flow-gate/src/questions.js: checkQuestion。書き手は Claude）を、出す前に当てる。
// 使い方: node .claude/skills/ask/scripts/ask.mjs <issue の番号> <問いのファイル>
import { readFileSync } from "node:fs";
import { bot, comment, config, isMain, isNumber, usage } from "../../../../tools/flow-gate/src/bot.js";
import { checkQuestion, norm } from "../../../../tools/flow-gate/src/questions.js";

function main() {
  const [number, file] = process.argv.slice(2);
  if (!isNumber(number) || !file) usage("node .claude/skills/ask/scripts/ask.mjs <issue の番号> <問いのファイル>");
  const question = norm(readFileSync(file, "utf8")).trim();
  const problems = checkQuestion(config.questionForms, question, "Claude");
  if (problems.length) {
    console.error(`問いが形に合わないので出さない: ${problems.join("・")}`);
    process.exit(1);
  }
  comment(bot(), number, question);
  console.log(`#${number}: 問いを出した`);
}

if (isMain(import.meta.url)) main();
