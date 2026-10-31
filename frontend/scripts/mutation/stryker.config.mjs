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
  // 書き換えごとの持ち時間は「倍率 × 通るテストの最初の1回の所要 + timeoutMS + 最初の1回の余分」。画面のテストは書き換えで
  // 落ちるとき待ちの上限（findBy 等）まで待って最初の1回より遅くなり、並んだ口どうしが CPU を取り合うと、既定の倍率では
  // 落ちる前に打ち切られて時間切れに数えられる。止まらない繰り返しは、書き換えを通った回数の上限で持ち時間より先に打ち切られる。
  timeoutFactor: 4,
  reporters: ["json", "clear-text", "progress-append-only"],
  appendPlugins: ["./scripts/mutation/ignore-class-names.mjs"],
  ignorers: ["class-names"],
  // compare で testRunner を command にしたときに打つもの（書き換えごとにテスト全体を回す）。
  commandRunner: { command: "npx vitest run --config scripts/mutation/vitest.config.mts" },
};
