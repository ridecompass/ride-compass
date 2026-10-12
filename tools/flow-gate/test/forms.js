// ラベルの形（config.questionForms）どおりの問いを、ゲートと同じ組み立て（src/questions.js: render）で作る。書く者が埋める問い（判断・操作）は、
// 問いの文と回答内容の節の行を渡す（行は文字か、[文, 属性の名前, 属性の値]）。MATERIAL は判断材料の塊だけ。
import { config } from "../src/bot.js";
import { render } from "../src/questions.js";

const rowOf = (r) => (typeof r === "string" ? { text: r, attrs: [] } : { text: r[0], attrs: [r.slice(1)] });
export const formed = (kind, text, rows = []) => render(kind, text, config.questionForms[kind].header, rows.map(rowOf), config.questionForms[kind].sections);
export const MATERIAL = (kind) => formed(kind, "問い").replace(/^[\s\S]*?(?=<details>)/, "");
