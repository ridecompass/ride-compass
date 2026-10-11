// frontend の単体テストの変異テストの設定。frontend の下で `npx stryker run scripts/mutation/stryker.config.mjs --mutate <ファイル,...>`
// と打つ（書き換えるファイルは plan.mjs が分ける）。Stryker と口は install.sh が入れる。
// 結果は Stryker の結果の JSON（reports/mutation/mutation.json）で、書き換えごとに落としたテスト（killedBy）と通ったテスト（coveredBy）を持つ。
export default {
  testRunner: "vitest",
  vitest: { configFile: "scripts/mutation/vitest.config.mts" },
  // 書き換えごとに、その書き換えを通るテストだけを回す（どのテストが通るかは、最初の1回で記録する）。
  coverageAnalysis: "perTest",
  // 最初に落ちたテストで止めず、落ちたテストを全部 killedBy に載せる。
  disableBail: true,
  reporters: ["json", "clear-text", "progress-append-only"],
  appendPlugins: ["./scripts/mutation/ignore-class-names.mjs"],
  ignorers: ["class-names"],
  // compare で testRunner を command にしたときに打つもの（書き換えごとにテスト全体を回す）。
  commandRunner: { command: "npx vitest run" },
};
