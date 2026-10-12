import base from "../flow.config.json" with { type: "json" };
import questionTemplate from "../question_template.md"; // wrangler.toml の rules で文字列として読む
import { settings } from "./settings.js";

export const config = settings(base, questionTemplate);
