import base from "../flow.config.json" with { type: "json" };
// 問いの種類ごとの形（wrangler.toml の rules で文字列として読む）。形を足したら、ここにも並べる（手元の道具は src/bot.js: questionForms が置き場ごと読む）。
import adopt from "../question_forms/adopt.md";
import confirm from "../question_forms/confirm.md";
import irregular from "../question_forms/irregular.md";
import judge from "../question_forms/judge.md";
import operate from "../question_forms/operate.md";
import { loadForms } from "./questions.js";

export const config = { ...base, questionForms: loadForms([adopt, judge, operate, confirm, irregular]) };
