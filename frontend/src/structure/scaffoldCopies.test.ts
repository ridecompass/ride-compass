// @vitest-environment node
/**
 * テストが共有の足場（`src/testing`の組み立て関数・代役・待ちの道具）と同じ役のものを自分のファイルに写さず、
 * 自前のモジュールを差し替えないことを見る（.claude/rules/testing-frontend.md「確かめる高さ（frontend）」の
 * 「差し替えてよいのは次の境界だけ」・testing-scaffold.md「フェイクの数は、実装の外向き参照の写し」の「共有フェイクへ出すのは3箇所目から」。
 * backend の同じ検査は`backend/tests/structure/test_scaffold_copies.py`）。
 *
 * 母集団は`frontend/src`（この検査のディレクトリを除く）と`frontend/e2e`の全`.ts(x)`で、TypeScriptの構文木で読む。
 * `src/testing`の`*.test.ts(x)`でないファイルを共有の足場、`*.test.ts(x)`と`e2e`のファイルをテストとして読む
 * （`e2e`の`*.spec.ts`でないファイルは e2e の足場だが、`src/testing`を迂回すれば違反に数える）。違反は次の5つ:
 *
 * 1. 最上位の定義の写し: テストと足場の最上位の関数・`const`で、名前を除いた本体が同じものが3つ以上のファイルにある。
 *    値（関数でない`const`）は、葉（名前・リテラル）が5つ以上のものだけ。2つまでは落とさない（3箇所目から足場へ出す決まり）。
 * 2. 組み立て関数の迂回: `src/testing`の公開関数のうち、既定値を埋めて上書きを受ける組み立て関数（返すオブジェクト
 *    リテラルが上書きの展開を持つもの）について、そのリテラルが持つ項目（展開を除く）を全部持つオブジェクトリテラルを、
 *    `src/testing`の外のテストに書く。
 * 3. 足場の代役の迂回: 足場が代役を持つ外部のモジュール（`vi.mock(<名前>, () => import("@/testing/…"))`の形で
 *    差し替えられるもの）を、別の中身で`vi.mock`するか、足場が代役として出す名前の型（`Map`等）へ値を`as`で当てる。
 * 4. 自前のモジュールの差し替え: `@/`か相対のパスで指す`src`のモジュールを`vi.mock`する。差し替えてよい境界のうち、
 *    環境変数の読み取り口（`process.env`を読むモジュール）とファイルを落とす関数（`URL.createObjectURL`を呼ぶ
 *    モジュール）は除く。子の部品の差し替え（差し替えの中身が部品の名前（大文字で始まり、全部が大文字でない名前）
 *    だけを置き換えるもの）も除く——testing-frontend.md は条件（子の中身がテスト環境に無い境界を要し、境界の側で差し替え
 *    られない）を満たす子の差し替えを許し、その条件は構文木から決まらない。
 * 5. 外部の境界の差し替えの写し: `Object.defineProperty(<対象>, "<名前>", …)`・`vi.stubGlobal("<名前>", …)`
 *    （`globalThis`の名前として数える）で置き換える同じ (対象, 名前)（`navigator`の`geolocation`・`globalThis`の`fetch`等）を、
 *    `src/testing`の外の3つ以上のテストのファイルが置き換えるか、`src/testing`の足場が置き換えるのに外のテストが自分で
 *    置き換える。関数の中の差し替えも数える。`msw/node`の`setupServer`を呼ぶファイルは`globalThis`の`fetch`を置き換えると
 *    数える（mswは網の層で要求を横取りし、プロパティの置き換えが構文木に現れない）。
 *
 * **判定しない形**: 関数の中の定義（1の写し）。組み立て関数の項目の一部だけを持つリテラル（関心のある項目だけを書いた入力）と、
 * 上書きを受けない部品の関数（`routeThrough`等、型の一部を組むもの）。代役の無い型（`FilterSpecification`等の値の型）への`as`。
 * 葉が5つ未満の値。`vi.spyOn(globalThis, …)`・代入（`window.<名前> =`）等、
 * 上の3つの形でない置き換え。`e2e-live`・`capture`（別のランナーの道具で、`src/testing`の足場を使わない）。
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { copiedBoundaries } from "./scaffoldBoundaries";
import { bypassedBuilders, copiedDefinitions } from "./scaffoldDefinitions";
import { bypassedStandIns, ownModuleMocks } from "./scaffoldMocks";
import { type Finding, readSources } from "./scaffoldSources";
import { SRC_ROOT, removeTree, writeTree } from "./sourceTree";

function scaffoldViolations(root: string) {
  const sources = readSources(root);
  return {
    copies: copiedDefinitions(sources),
    builders: bypassedBuilders(sources),
    standIns: bypassedStandIns(sources),
    ownMocks: ownModuleMocks(sources),
    boundaries: copiedBoundaries(sources),
  };
}

const lines = (findings: Finding[]) => findings.map(({ file, line, reason }) => `${file}:${line}: ${reason}`).sort();

describe("共有の足場の写し", () => {
  const found = scaffoldViolations(join(SRC_ROOT, ".."));

  it("同じ本体の最上位の定義が3つ以上のファイルに無い（共有の足場`src/testing`へ1つにまとめる）", () => {
    expect(lines(found.copies)).toEqual([]);
  });

  it("`src/testing`の組み立て関数が返す項目を全部、外のテストで手書きしない（組み立て関数へ変えたい項目だけを渡す）", () => {
    expect(lines(found.builders)).toEqual([]);
  });

  it("足場が代役を持つ外部のモジュールを、別の中身で差し替えたり、その型へ自前の値を当てたりしない", () => {
    expect(lines(found.standIns)).toEqual([]);
  });

  it("自前のモジュールを差し替えない（境界の表の読み取り口・ファイルを落とす関数・子の部品を除く）", () => {
    expect(lines(found.ownMocks)).toEqual([]);
  });

  it("同じ外部の境界を3つ以上のファイルで自前に差し替えず、`src/testing`に足場があればそれを使う", () => {
    expect(lines(found.boundaries)).toEqual([]);
  });
});

describe("検査が効いていること", () => {
  const within = (files: Record<string, string>) => {
    const root = writeTree(files);
    try {
      const sources = readSources(root);
      return {
        copies: lines(copiedDefinitions(sources)),
        builders: lines(bypassedBuilders(sources)),
        standIns: lines(bypassedStandIns(sources)),
        ownMocks: lines(ownModuleMocks(sources)),
        boundaries: lines(copiedBoundaries(sources)),
      };
    } finally {
      removeTree(root);
    }
  };

  it("名前の違う同じ関数・葉が5つ以上の同じ値を3ファイルで落とし、2ファイルの写しと葉が5つ未満の値は落とさない", () => {
    const helper = (name: string) => `const ${name} = (text: string) => new Date(\`\${text}+09:00\`);\n`;
    const table = `const TABLE = { a: 1, b: 2, c: 3 };\nconst SMALL = { a: 1 };\nfunction twice(x: number) { return x * 2; }\n`;
    expect(
      within({
        "src/a.test.ts": helper("jst") + table,
        "src/b.test.ts": helper("at") + table,
        "e2e/c.ts": helper("jst") + "const TABLE = { a: 1, b: 2, c: 3 };\n",
      }),
    ).toMatchObject({
      copies: [
        "e2e/c.ts:1: jst（3ファイル）",
        "e2e/c.ts:2: TABLE（3ファイル）",
        "src/a.test.ts:1: jst（3ファイル）",
        "src/a.test.ts:2: TABLE（3ファイル）",
        "src/b.test.ts:1: at（3ファイル）",
        "src/b.test.ts:2: TABLE（3ファイル）",
      ],
    });
  });

  it("組み立て関数の項目を全部持つリテラルを落とし、一部だけのリテラル・上書きを受けない関数・`src/testing`の中は落とさない", () => {
    const builder = `export function makeSegment(o = {}) {\n  return { start: 0, end: 0, ...o };\n}\n`;
    const part = `export function shape() {\n  return { start: 0, end: 0 };\n}\n`;
    expect(
      within({
        "src/testing/segments.ts": builder + part + `export const SEGMENT = { start: 1, end: 2 };\n`,
        "src/a.test.ts": `const full = { start: 1, end: 2, extra: 3 };\nconst part = { start: 1 };\n`,
        "e2e/fixtures.ts": `export const segment = () => ({ start, end });\n`,
      }),
    ).toMatchObject({ builders: ["e2e/fixtures.ts:1: makeSegment", "src/a.test.ts:1: makeSegment"] });
  });

  it("足場が代役を持つモジュールを別の中身で差し替える形と代役の型へ当てる形を落とし、足場を読む差し替えと値の型は落とさない", () => {
    expect(
      within({
        "src/testing/lib.ts": `class StandIn {}\nexport { StandIn as Map };\nexport function addProtocol() {}\n`,
        "src/a.test.ts": `vi.mock("maplibre-gl", () => import("@/testing/lib"));\n`,
        "src/b.test.ts": [
          `import type { Map as LibreMap, FilterSpecification } from "maplibre-gl";`,
          `vi.mock("maplibre-gl", () => ({ addProtocol }));`,
          `const map = {} as unknown as LibreMap;`,
          `const filter = [] as FilterSpecification;`,
        ].join("\n"),
      }),
    ).toMatchObject({ standIns: ['src/b.test.ts:2: vi.mock("maplibre-gl")', "src/b.test.ts:3: as LibreMap"] });
  });

  it("自前のモジュールの差し替えを@/と相対のパスで落とし、環境変数の読み取り口・ファイルを落とす関数・子の部品・パッケージは落とさない", () => {
    expect(
      within({
        "src/hooks/useValue.ts": `export const useValue = () => 1;\n`,
        "src/lib/env.ts": `export const base = () => process.env.BASE;\n`,
        "src/lib/save.ts": `export const save = (blob: Blob) => URL.createObjectURL(blob);\n`,
        "src/hooks/useValue.test.ts": [
          `vi.mock("@/hooks/useValue");`,
          `vi.mock("./useValue");`,
          `vi.mock("@/lib/env");`,
          `vi.mock("../lib/save");`,
          `vi.mock("embla-carousel-react");`,
          `vi.mock("@/hooks/useValue", () => ({ ValueView: () => null }));`,
          `vi.mock("@/hooks/useValue", async () => ({ ...(await vi.importActual("@/hooks/useValue")), ValueView: () => null }));`,
          `vi.mock("@/hooks/useValue", () => ({ ValueView: () => null, useValue: () => 2 }));`,
          `vi.mock("@/hooks/useValue", () => ({ MAX_VALUE: 2 }));`,
        ].join("\n"),
      }),
    ).toMatchObject({
      ownMocks: [
        "src/hooks/useValue.test.ts:1: @/hooks/useValue",
        "src/hooks/useValue.test.ts:2: ./useValue",
        "src/hooks/useValue.test.ts:8: @/hooks/useValue",
        "src/hooks/useValue.test.ts:9: @/hooks/useValue",
      ],
    });
  });

  it("同じ境界の差し替えを3ファイルで落とし、足場があれば1ファイルでも落とす。2ファイルと`src/testing`の中は落とさない", () => {
    const replace = (target: string, name: string) =>
      `function install() {\n  Object.defineProperty(${target}, "${name}", { value: {}, configurable: true });\n}\n`;
    expect(
      within({
        "src/testing/clock.ts": replace("navigator", "clock"),
        "src/a.test.ts": replace("navigator", "geolocation") + replace("document", "hidden"),
        "src/b.test.ts": replace("navigator", "geolocation") + replace("document", "hidden"),
        "e2e/c.spec.ts": replace("navigator", "geolocation") + replace("navigator", "clock"),
      }),
    ).toMatchObject({
      boundaries: [
        "e2e/c.spec.ts:2: navigator.geolocation（3ファイル）",
        "e2e/c.spec.ts:5: navigator.clock（足場がある）",
        "src/a.test.ts:2: navigator.geolocation（3ファイル）",
        "src/b.test.ts:2: navigator.geolocation（3ファイル）",
      ],
    });
  });

  it("`vi.stubGlobal`を`globalThis`の置き換えに数え、`msw/node`の`setupServer`を呼ぶ足場を`fetch`の足場に数える", () => {
    const stub = (name: string) => `vi.stubGlobal("${name}", vi.fn());\n`;
    expect(
      within({
        "src/testing/server.ts": `import { setupServer } from "msw/node";\nexport const server = setupServer();\n`,
        "src/a.test.ts": stub("fetch") + stub("crypto"),
        "src/b.test.ts": stub("crypto"),
        "src/c.test.ts": `Object.defineProperty(globalThis, "crypto", { value: {} });\n`,
      }),
    ).toMatchObject({
      boundaries: [
        "src/a.test.ts:1: globalThis.fetch（足場がある）",
        "src/a.test.ts:2: globalThis.crypto（3ファイル）",
        "src/b.test.ts:1: globalThis.crypto（3ファイル）",
        "src/c.test.ts:1: globalThis.crypto（3ファイル）",
      ],
    });
  });
});
