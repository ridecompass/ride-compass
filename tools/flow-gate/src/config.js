import base from "../flow.config.json" with { type: "json" };
// 問いのラベルごとの形（wrangler.toml の rules で文字列として読む）。形を足したら、ここにも並べる（スクリプトとテストは src/bot.js が置き場ごと読む）。
import adopt from "../question_forms/adopt.md";
import confirm from "../question_forms/confirm.md";
import cont from "../question_forms/continue.md";
import promise from "../question_forms/promise.md";
import irregular from "../question_forms/irregular.md";
import judge from "../question_forms/judge.md";
import operate from "../question_forms/operate.md";
import { settings } from "./settings.js";

export const config = settings(base, [adopt, judge, operate, confirm, irregular, cont, promise]);
