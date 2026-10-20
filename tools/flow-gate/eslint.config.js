// 道具と部品の静的な誤り（構文・存在しない import・無い名前の import）を動かさずに落とす。
// 流れのスキルに同梱したスクリプト（.claude/skills/）も、この設定で照らす（npm run lint がリポジトリの頭から両方を渡す。設定を -c で
// 渡すと範囲の基準は打った場所になり、tools/flow-gate の中から打つと外のファイルは範囲外として飛ばされる）。
// 規則はプラグインの errors（実行すれば必ず落ちるものだけを集めた既定の組）をそのまま使う。
import importPlugin from "eslint-plugin-import";

// cloudflare: で始まる import は Workers の実行環境が持つ組み込みで、手元のファイルには無い。
export default [importPlugin.flatConfigs.errors, { rules: { "import/no-unresolved": ["error", { ignore: ["^cloudflare:"] }] } }];
