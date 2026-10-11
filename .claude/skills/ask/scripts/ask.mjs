// 問いを形（tools/flow-gate/question_template.md）で照らし、合えば置き場の issue へコメントで出す。合わなければ出さず、合わない所を出して終わる。
// ゲートが問いとして読むのと同じ照らし方（tools/flow-gate/src/questions.js: checkQuestion）を、出す前に当てる。
// 使い方: node .claude/skills/ask/scripts/ask.mjs <issue の番号> <問いのファイル>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { checkQuestion, norm } from "../../../../tools/flow-gate/src/questions.js";

const [number, file] = process.argv.slice(2);
if (!/^\d+$/.test(number ?? "") || !file) {
  console.error("使い方: node .claude/skills/ask/scripts/ask.mjs <issue の番号> <問いのファイル>");
  process.exit(2);
}
const template = norm(readFileSync(new URL("../../../../tools/flow-gate/question_template.md", import.meta.url), "utf8"));
const question = norm(readFileSync(file, "utf8")).trim();
const problems = checkQuestion(template, question);
if (problems.length) {
  console.error(`問いが形に合わないので出さない: ${problems.join("・")}`);
  process.exit(1);
}
if (!process.env.FLOW_BOT_TOKEN) {
  console.error("FLOW_BOT_TOKEN が無いので出さない（置き場へは hidakagit-bot の名義で書く）");
  process.exit(1);
}
execFileSync("gh", ["issue", "comment", number, "-R", "ridecompass/ride-compass-tasks", "--body-file", "-"],
  { input: question, stdio: ["pipe", "inherit", "inherit"], env: { ...process.env, GH_TOKEN: process.env.FLOW_BOT_TOKEN } });
