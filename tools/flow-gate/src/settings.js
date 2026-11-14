// ゲートと同梱のスクリプトが使う設定を、設定（flow.config.json）と問いのラベルごとの形（question_forms/ のファイルの中身）から組む。
// 読み込み方だけが使う所ごとに違う（Worker は wrangler の rules で文字列として読み、スクリプトはファイルから読む）。
import { loadForms } from "./questions.js";

const repo = (full) => {
  const [owner, name] = full.split("/");
  return { owner, name };
};

// repos は置き場（tasks）とコードのリポジトリ（code）を、GraphQL が受けるオーナーと名前に分けたもの。
export const settings = (base, forms) => ({ ...base, questionForms: loadForms(forms), repos: { tasks: repo(base.tasks), code: repo(base.code) } });
