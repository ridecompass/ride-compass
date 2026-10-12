// 使い捨て（tasks#892）: 開いた issue の最新の「## 問い」を、種類ごとの形（question_forms/）へ一度で直す。ゲートは形に合わない問いを読まないので、
// ゲートを公開した直後に流す。流したらこのファイルを消す。
// - 採否・確かめ・イレギュラー（ゲートが出す）は、ゲートと同じ組み立て（src/questions.js: askText）で書き直す。確かめの項目は本文のユーザーが確かめる条件
//   （残りがあれば残り、無ければ全部）。
// - 判断は、前の形の節「案ごとに起きること」を「答えごとに起きること」へ名を変えて形の位置へ移す。案の無い判断と、それでも形に合わないものは直さずに出す
//   （置き換え先（操作か、案を立てた判断か）は人が決める）。
// 既定は直した結果を出すだけ。--write を付けたときだけ、置き場のコメントを書き換える（hidakagit-bot の名義）。
// 使い方: node tools/flow-gate/migrate-questions.mjs [--write]
import { bot, config, questionForms } from "./src/bot.js";
import { askText, checkQuestion, conditions, isQuestion, norm } from "./src/questions.js";

const gh = bot();
const write = process.argv.includes("--write");
const GATE = ["採否", "確かめ", "イレギュラー"];

function migrate(text, body) {
  const head = /^## 問い(?:（(.+)）)?/.exec(text)?.[1] ?? "判断";
  if (GATE.includes(head)) {
    const mine = conditions(body).filter((c) => c.verify === "ユーザー");
    const left = mine.filter((c) => !c.done);
    return askText(head, questionForms, left.length ? left : mine);
  }
  const moved = /\n\n\*\*案ごとに起きること\*\*:([\s\S]*?)(?=\n\n\*\*[^*]+\*\*:|\n<\/details>)/.exec(text);
  const rest = (moved ? text.replace(moved[0], "") : text).replace(/^## 問い(?:（判断）)?/, "## 問い（判断）");
  return moved ? rest.replace(/\n<\/details>\s*$/, `\n\n**答えごとに起きること**:${moved[1]}\n</details>`) : rest;
}

const issues = JSON.parse(gh(["issue", "list", "-R", config.tasks, "--state", "open", "--limit", "500", "--json", "number,body"]));
for (const issue of issues) {
  const comments = JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${config.tasks}/issues/${issue.number}/comments?per_page=100`])).flat();
  const last = comments.findLast((c) => isQuestion(c.body));
  if (!last) continue;
  const text = norm(last.body).trim();
  if (!checkQuestion(questionForms, text).length) continue;
  const next = migrate(text, issue.body);
  const problems = checkQuestion(questionForms, next);
  if (problems.length) {
    console.log(`#${issue.number} 直せない（人が決める）: ${problems.join("・")}\n  ${last.html_url}`);
    continue;
  }
  console.log(`#${issue.number} ${write ? "書き換えた" : "書き換える"}: ${text.split("\n")[0]}\n${write ? "" : `${next}\n`}`);
  if (write) gh(["api", "-X", "PATCH", `repos/${config.tasks}/issues/comments/${last.id}`, "--input", "-"], JSON.stringify({ body: next }));
}
