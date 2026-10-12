// 種類の形（config.questionForms）どおりの問いを、ゲートと同じ組み立て（src/questions.js: render）で作る。書く者が埋める問い（判断・操作）は、
// 問いの文と答えの行を渡す。MATERIAL は判断材料の塊だけ。
import { config } from "../src/bot.js";
import { render } from "../src/questions.js";

export const formed = (kind, text, rows) => render(kind, text, config.questionForms[kind].header, rows, config.questionForms[kind].sections);
export const MATERIAL = (kind) => formed(kind, "問い", ["答え"]).replace(/^[\s\S]*?(?=<details>)/, "");
