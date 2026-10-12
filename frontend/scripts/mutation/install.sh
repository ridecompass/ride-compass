#!/usr/bin/env bash
# Stryker を依存に足さずに入れ（測るときだけ）、vitest の口に Vitest 5 のテスト名の区切りの直しを当てる。frontend の下で打つ。
# 版と直しは、変異テストを回す所はどこもここから入れる（.github/workflows/mutation-frontend.yml）。
#
# 直し: Vitest 5 はテスト名の絞り込み（testNamePattern）を、describe からテストまでの名前を ' > ' でつないだものに当てるが、
# 口の 10.0.0 は空白でつなぐので、書き換えごとの実行でテストが1本も選ばれず、全部が生き残りになる（stryker-mutator/stryker-js#6210）。
# 置き換えは stryker-mutator/stryker-js#6214 を Vitest 5 に限ったもの。直しの入った版が出たら、版を上げて置き換えを消し、
# mutation-frontend.yml の compare で、書き換えごとにテスト全体を回す口と判定が合うことを確かめ直す。
set -euo pipefail

STRYKER_VERSION=10.0.0
npm i --no-save --no-audit --no-fund "@stryker-mutator/core@$STRYKER_VERSION" "@stryker-mutator/vitest-runner@$STRYKER_VERSION"
for f in node_modules/@stryker-mutator/vitest-runner/dist/src/{stryker-setup,test-helpers}.js; do
  sed -i "s/nameParts.join(' ')/nameParts.join(' > ')/" "$f"
  # 置き換える所が無くなった（口の版が変わった）なら、ここで止める。
  grep -q "nameParts.join(' > ')" "$f"
done
