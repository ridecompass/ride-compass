// @vitest-environment node
/** `usageText.ts`の検査を、frontend/srcの画面と、わざと違反させた木に当てる。 */
import { describe, expect, it } from "vitest";

import { SRC_ROOT, removeTree, writeTree } from "./sourceTree";
import { GUIDE, SHARED_IMPORTS, SHARED_PARTS, missingUsage, typeErrors } from "./usageText";

describe("使い方の文", () => {
  it("共有の部品は、使い方の文を渡さないと型の検査で通らない", () => {
    const rows = Object.entries(SHARED_PARTS).flatMap(([name, part]) => [
      { name, given: true, line: `export const given${name} = ${part.replace("{usage}", ' usage="文"')};` },
      { name, given: false, line: `export const missing${name} = ${part.replace("{usage}", "")};` },
    ]);
    const errors = typeErrors([...SHARED_IMPORTS, ...rows.map(({ line }) => line)].join("\n"));
    const failing = (index: number) =>
      errors.filter(({ line }) => line === SHARED_IMPORTS.length + index + 1).map(({ message }) => message);
    expect(rows.map(({ name, given }, index) => [name, given, failing(index)])).toEqual(
      rows.map(({ name, given }) => [
        name,
        given,
        given ? [] : [expect.stringMatching(/^Property 'usage' is missing/)],
      ]),
    );
  }, 60_000);

  it("説明モードのある画面の押せる部品は、どれも使い方の文を持つ", () => {
    expect(missingUsage(SRC_ROOT)).toEqual([]);
  }, 60_000);

  it("文に覆われない押せる要素と、null を渡す usage を落とす", () => {
    const root = writeTree({
      [GUIDE]: "export default function UsageGuide() { return <button>やめる</button>; }",
      "components/Button.tsx": [
        "export function Button({ usage, ...props }: { usage: string | null; children?: unknown; onClick?: () => void }) {",
        "  return <button data-usage={usage ?? undefined} {...props} />;",
        "}",
      ].join("\n"),
      "components/Field.tsx": [
        'export function Field(props: { "data-usage"?: string }) {',
        "  return <input {...props} />;",
        "}",
      ].join("\n"),
      "app/Panel.tsx": [
        'import { Button } from "@/components/Button";',
        'import { Field } from "@/components/Field";',
        "export function Row() {",
        '  return <a href="/">置き場で覆われる</a>;',
        "}",
        "export function Orphan() {",
        "  return <summary>置き場の無い部品</summary>;",
        "}",
        "export default function Panel() {",
        "  return (",
        "    <div>",
        '      <Button usage="文">文がある</Button>',
        "      <Button usage={null}>null</Button>",
        '      <Field data-usage="文" />',
        "      <Field />",
        '      <div data-usage="囲む文"><button>囲まれる</button><Row /></div>',
        "      <button>文が無い</button>",
        '      <input type="hidden" />',
        '      <div role="tab">役割</div>',
        "    </div>",
        "  );",
        "}",
      ].join("\n"),
      "app/page.tsx": [
        'import UsageGuide from "@/components/UsageGuide/UsageGuide";',
        'import Panel from "@/app/Panel";',
        "export default function Page() { return <><UsageGuide /><Panel /></>; }",
      ].join("\n"),
      "app/admin/page.tsx": [
        'import { Button } from "@/components/Button";',
        "export default function Admin() { return <Button usage={null}>管理</Button>; }",
      ].join("\n"),
    });
    try {
      expect(missingUsage(root)).toEqual([
        "app/Panel.tsx:13 Button usage に null",
        "app/Panel.tsx:17 button 文が無い（置き場: app/page.tsx:3 Panel）",
        "app/Panel.tsx:19 div 文が無い（置き場: app/page.tsx:3 Panel）",
        "app/Panel.tsx:7 summary 文が無い",
        "components/Field.tsx:2 input 文が無い（置き場: app/Panel.tsx:15 Field）",
      ]);
    } finally {
      removeTree(root);
    }
  });
});
