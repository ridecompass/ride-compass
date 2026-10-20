// @vitest-environment node
/**
 * `lib/apiError.ts`——backendのエラー応答の`detail`と、捕まえた例外を、利用者へ出せる1つの文言にする。
 *
 * ここで見ないもの:
 * - 文言を`Error`にして投げること・`detail`が無いときの文言 → `lib/apiClient.test.ts`
 */
import { describe, expect, it } from "vitest";

import { errorMessage, formatErrorDetail } from "@/lib/apiError";

describe("formatErrorDetail", () => {
  it("無ければ文言を作らない（呼び出し側が自分の文言を使う）", () => {
    expect(formatErrorDetail(undefined)).toBeUndefined();
  });

  it("文字列はそのまま返す", () => {
    expect(formatErrorDetail("経路が見つかりません")).toBe("経路が見つかりません");
  });

  it("入力検証の失敗（`msg`を持つ項目の配列）は、各項目の`msg`を順に「 / 」でつなぐ", () => {
    const detail = [
      { loc: ["body", "distance_km"], msg: "Input should be less than 200", type: "less_than" },
      { loc: ["body", "start"], msg: "Field required", type: "missing" },
    ];

    expect(formatErrorDetail(detail)).toBe("Input should be less than 200 / Field required");
  });

  it("配列のうち`msg`を持たない項目は飛ばし、文字列でない`msg`は文字列にする", () => {
    const detail = [null, "bare", { loc: ["body"] }, { msg: 42 }];

    expect(formatErrorDetail(detail)).toBe("42");
  });

  it.each([
    ["`msg`を持つ項目が無い配列", [{ loc: ["body"] }], '[{"loc":["body"]}]'],
    ["配列でないオブジェクト", { reason: "busy" }, '{"reason":"busy"}'],
  ])("%sは、JSONの文字列にして中身を残す", (_scene, detail, expected) => {
    expect(formatErrorDetail(detail)).toBe(expected);
  });
});

describe("errorMessage", () => {
  it.each([
    ["`Error`は、既定の文言があっても自分の文言", new Error("保存できません"), "既定", "保存できません"],
    ["`Error`でない値は、既定の文言", "busy", "既定", "既定"],
    ["`Error`でない値で既定の文言が無ければ、その値を文字列にする", 42, undefined, "42"],
  ])("%s", (_scene, error, fallback, expected) => {
    expect(errorMessage(error, fallback)).toBe(expected);
  });
});
