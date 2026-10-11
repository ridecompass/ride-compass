import { mergeConfig } from "vitest/config";

import base from "../../vitest.config.mts";

// 変異テストで回すときだけの設定。Stryker が書き換えを数えるために差し込む処理と、並び1本（Stryker の口が強いる）の分だけ
// テストが遅くなり、計算の重いテストが既定の持ち時間を超えて、最初の1回（全部通らないと測れない）で落ちる。
// 書き換えで止まらなくなったものは、Stryker が最初の1回の所要から決める持ち時間で別に打ち切る。
export default mergeConfig(base, { test: { testTimeout: 120_000 } });
