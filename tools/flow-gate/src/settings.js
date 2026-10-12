// ゲートと同梱のスクリプトとテストが使う設定を、設定（flow.config.json）と問いの形（question_template.md）から組む。読み込み方だけが
// 使う所ごとに違う（Worker は wrangler の rules で文字列として読み、スクリプトとテストはファイルから読む）。
import { norm } from "./questions.js";

const repo = (full) => {
  const [owner, name] = full.split("/");
  return { owner, name };
};

// repos は置き場（tasks）とコードのリポジトリ（code）を、GraphQL が受けるオーナーと名前に分けたもの。
export const settings = (base, questionTemplate) => ({ ...base, questionTemplate: norm(questionTemplate), repos: { tasks: repo(base.tasks), code: repo(base.code) } });
