// 問いを種類の形（tools/flow-gate/question_forms/）で照らし、合えば置き場の issue へコメントで出す。合わなければ出さず、合わない所を出して終わる。
// ゲートが問いとして読むのと同じ照らし方（tools/flow-gate/src/questions.js: checkQuestion）を、出す前に当てる。
// 使い方: node .claude/skills/ask/scripts/ask.mjs <issue の番号> <問いのファイル>
import { readFileSync } from "node:fs";
import { bot, config, isMain, questionForms } from "../../../../tools/flow-gate/src/bot.js";
import { checkQuestion, norm } from "../../../../tools/flow-gate/src/questions.js";

function main() {
  const [number, file] = process.argv.slice(2);
  if (!/^\d+$/.test(number ?? "") || !file) {
    console.error("使い方: node .claude/skills/ask/scripts/ask.mjs <issue の番号> <問いのファイル>");
    process.exit(2);
  }
  const question = norm(readFileSync(file, "utf8")).trim();
  const problems = checkQuestion(questionForms, question);
  if (problems.length) {
    console.error(`問いが形に合わないので出さない: ${problems.join("・")}`);
    process.exit(1);
  }
  bot()(["issue", "comment", number, "-R", config.tasks, "--body-file", "-"], question);
  console.log(`#${number}: 問いを出した`);
}

if (isMain(import.meta.url)) main();
