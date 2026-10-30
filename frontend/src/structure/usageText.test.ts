// @vitest-environment node
/**
 * 説明モード（`components/UsageGuide/UsageGuide.tsx`）のある画面の押せる部品が、使い方の文を持つこと。
 *
 * 説明モードは押された部品か、それを囲む要素のうち最も近いものの`data-usage`を出し、無ければ「説明はまだありません」と
 * 名前だけを出す。共有の部品（`Button`等）は引数`usage`を型で必須にしてあり、ここでは型で守れない2つを見る。
 *
 * - **押せる要素が文に覆われている**: 押せる要素は、素の要素（`button`・`a[href]`・`input`（`type="hidden"`を除く）・
 *   `select`・`textarea`・`summary`・押せる役割（`role`）を持つ要素）と、外のライブラリの部品のうち引数の`type`が
 *   `"button"`を取るもの（ボタンか入力を描く。Radix の`Trigger`・`Checkbox.Root`等）。要素が覆われているのは、自分か
 *   同じファイルの中で囲む素の要素が`data-usage`を書いているときか、要素を描く部品（ファイルの最上位の宣言）の、説明モードの
 *   ある画面の中のどの置き場も覆われているとき（置き場が`data-usage`を渡すか、置き場を囲む素の要素が書いているか、置き場を描く部品が
 *   同じく覆われている）。JSX で置かれない部品（関数として呼ぶ・`createRoot`で描く）は、置き場が無いので覆われない。
 * - **`usage`に`null`を渡さない**: `null`は説明モードの無い画面の部品のための値で、説明モードのある画面では渡さない。
 *
 * 母集団は、`app`の`page.tsx`のうち import をたどって説明モードに届くものから、import でたどれるファイル（テスト・足場・
 * この検査のディレクトリ・型の宣言を除く）。説明モード自身のファイルは除く（案内と説明の面を押しても説明は出ない）。
 *
 * **判定しない形**: 文の値が空でないか（型が文字列なら通す）。`label`（押すと中の入力が動き、文はその入力から引く）。
 */
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { SRC_ROOT, removeTree, walkTree, writeTree } from "./sourceTree";

const GUIDE = "components/UsageGuide/UsageGuide.tsx";
const PRESSABLE_TAGS = new Set(["button", "input", "select", "textarea", "summary"]);
const PRESSABLE_ROLES = new Set(["button", "tab", "radio", "checkbox", "switch", "slider", "menuitem", "option"]);

const isProduction = (path: string) =>
  /\.tsx?$/.test(path) &&
  !/\.test\.tsx?$/.test(path) &&
  !path.endsWith(".d.ts") &&
  !path.startsWith("testing/") &&
  !path.startsWith("structure/");

type JsxTag = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function attributeOf(tag: JsxTag, name: string): ts.JsxAttribute | undefined {
  return tag.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && ts.isIdentifier(property.name) && property.name.text === name,
  );
}

function literalOf(attribute: ts.JsxAttribute | undefined): string | undefined {
  const value = attribute?.initializer;
  if (value === undefined) return undefined;
  if (ts.isStringLiteral(value)) return value.text;
  if (ts.isJsxExpression(value) && value.expression && ts.isStringLiteralLike(value.expression))
    return value.expression.text;
  return undefined;
}

const isIntrinsic = (tag: JsxTag) => ts.isIdentifier(tag.tagName) && /^[a-z]/.test(tag.tagName.text);

/** 説明モードのある画面のファイル（`SRC_ROOT`からの相対パス）。 */
function screenFiles(program: ts.Program, root: string, files: string[]): Set<string> {
  const options = program.getCompilerOptions();
  const importsOf = (file: string) =>
    program
      .getSourceFile(file)!
      .statements.flatMap((statement) =>
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
          ? [statement.moduleSpecifier.text]
          : [],
      )
      .flatMap(
        (specifier) => ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule?.resolvedFileName ?? [],
      )
      .filter((resolved) => files.includes(resolved));
  const closure = (start: string) => {
    const found = new Set<string>();
    const pending = [start];
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (found.has(file)) continue;
      found.add(file);
      pending.push(...importsOf(file));
    }
    return found;
  };
  const screens = new Set<string>();
  for (const page of files.filter((file) => /(^|\/)page\.tsx$/.test(relative(join(root, "app"), file)))) {
    if (relative(root, page).startsWith("..")) continue;
    const reached = closure(page);
    if (reached.has(join(root, GUIDE))) for (const file of reached) screens.add(file);
  }
  screens.delete(join(root, GUIDE));
  return screens;
}

/** 共有の部品を置く1行ずつ（`{usage}`の所へ`usage`の引数を入れる）。 */
const SHARED_PARTS = {
  Button: "<Button{usage}>押す</Button>",
  Toggle: "<Toggle pressed{usage}>切り替える</Toggle>",
  TabsTrigger: '<TabsTrigger value="a"{usage}>タブ</TabsTrigger>',
  ToggleGroup: '<ToggleGroup value="a" onValueChange={() => {}} aria-label="選ぶ"{usage}>{null}</ToggleGroup>',
  Ruler: '<Ruler frames={[]} index={0} onIndexChange={() => {}} ariaLabel="目盛り"{usage} />',
  Disclosure: '<Disclosure summary="見出し"{usage}>本文</Disclosure>',
};
const SHARED_IMPORTS = [
  'import { Button } from "@/components/ui/Button/Button";',
  'import { Toggle } from "@/components/ui/Toggle/Toggle";',
  'import { TabsTrigger } from "@/components/ui/Tabs/Tabs";',
  'import { ToggleGroup } from "@/components/ui/ToggleGroup/ToggleGroup";',
  'import Ruler from "@/components/ui/Ruler/Ruler";',
  'import Disclosure from "@/components/Disclosure/Disclosure";',
];

/** `frontend/src`の中に置いたとみなした1ファイルを型検査し、誤りのある行（1始まり）と誤りの文を返す。 */
function typeErrors(source: string): { line: number; message: string }[] {
  const probe = join(SRC_ROOT, "structure/usageProbe.tsx");
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2017,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    resolveJsonModule: true,
    paths: { "@/*": [join(SRC_ROOT, "*")] },
  };
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (name, version, ...rest) =>
    name === probe ? ts.createSourceFile(name, source, version) : getSourceFile(name, version, ...rest);
  host.fileExists = (name) => name === probe || fileExists(name);
  host.readFile = (name) => (name === probe ? source : readFile(name));
  const program = ts.createProgram([probe], options, host);
  return ts.getPreEmitDiagnostics(program, program.getSourceFile(probe)).map((diagnostic) => ({
    line: diagnostic.file!.getLineAndCharacterOfPosition(diagnostic.start!).line + 1,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  }));
}

/** 文の無い押せる要素と、`null`を渡す`usage`（`<ファイル>:<行> <タグ>`）。 */
export function missingUsage(root: string): string[] {
  const files = walkTree(root)
    .filter(({ path, isDirectory }) => !isDirectory && isProduction(path))
    .map(({ path }) => join(root, path));
  const program = ts.createProgram(files, {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2017,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    resolveJsonModule: true,
    paths: { "@/*": [join(root, "*")] },
  });
  const checker = program.getTypeChecker();
  const screens = screenFiles(program, root, files);
  const inSrc = (node: ts.Node) => !relative(root, node.getSourceFile().fileName).startsWith("..");

  // 部品（ファイルの最上位の宣言）ごとの、画面の中の JSX の置き場。
  const tags: JsxTag[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) tags.push(node);
    ts.forEachChild(node, visit);
  };
  for (const file of screens) visit(program.getSourceFile(file)!);
  const declarationOf = (tag: JsxTag) => {
    let symbol = checker.getSymbolAtLocation(tag.tagName);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  };
  const topLevelOf = (node: ts.Node): ts.Node | undefined => {
    let current = node;
    while (current.parent && !ts.isSourceFile(current.parent)) current = current.parent;
    return ts.isSourceFile(current.parent) ? current : undefined;
  };
  /** ファイルの最上位で宣言した部品なら、その文（`function X`・`const X = forwardRef(...)`）。引数で受けた部品等は除く。 */
  const componentOf = (tag: JsxTag) => {
    const declaration = declarationOf(tag);
    if (declaration === undefined || !inSrc(declaration)) return undefined;
    if (ts.isFunctionDeclaration(declaration) && ts.isSourceFile(declaration.parent)) return declaration;
    if (ts.isVariableDeclaration(declaration) && ts.isSourceFile(declaration.parent.parent.parent))
      return declaration.parent.parent;
    return undefined;
  };
  const sites = new Map<ts.Node, JsxTag[]>();
  for (const tag of tags) {
    const component = componentOf(tag);
    if (component) sites.set(component, [...(sites.get(component) ?? []), tag]);
  }

  /**
   * 同じファイルの中で、自分か囲む素の要素が`data-usage`を書いているか。`asChild`を渡す要素は子を描き、押されるのは子なので、
   * 子の側で見る。
   */
  const writesUsage = (tag: JsxTag) => {
    if (attributeOf(tag, "asChild")) return true;
    for (let node: ts.Node = tag; !ts.isSourceFile(node); node = node.parent) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      if (!(ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening))) continue;
      if ((opening === tag || isIntrinsic(opening)) && attributeOf(opening, "data-usage")) return true;
    }
    return false;
  };
  const covering = new Map<ts.Node, boolean>();
  const covered = (tag: JsxTag): boolean => {
    if (writesUsage(tag)) return true;
    const top = topLevelOf(tag);
    if (top === undefined) return false;
    if (!covering.has(top)) {
      covering.set(top, false);
      const placed = sites.get(top) ?? [];
      covering.set(top, placed.length > 0 && placed.every(covered));
    }
    return covering.get(top)!;
  };
  const pressable = (tag: JsxTag) => {
    if (PRESSABLE_ROLES.has(literalOf(attributeOf(tag, "role")) ?? "")) return true;
    if (isIntrinsic(tag)) {
      const name = (tag.tagName as ts.Identifier).text;
      if (name === "a") return attributeOf(tag, "href") !== undefined;
      if (name === "input") return literalOf(attributeOf(tag, "type")) !== "hidden";
      return PRESSABLE_TAGS.has(name);
    }
    const declaration = declarationOf(tag);
    if (declaration === undefined || inSrc(declaration)) return false;
    const props = checker.getContextualType(tag.attributes);
    const type = props && checker.getPropertyOfType(props, "type");
    if (type === undefined) return false;
    const values = checker.getTypeOfSymbolAtLocation(type, tag);
    return (values.isUnion() ? values.types : [values]).some(
      (value) => value.isStringLiteral() && value.value === "button",
    );
  };

  const out = new Set<string>();
  const where = (tag: JsxTag) => {
    const file = tag.getSourceFile();
    return `${relative(root, file.fileName)}:${file.getLineAndCharacterOfPosition(tag.getStart()).line + 1} ${tag.tagName.getText()}`;
  };
  for (const tag of tags) {
    const usage = attributeOf(tag, "usage")?.initializer;
    if (usage && ts.isJsxExpression(usage) && usage.expression) {
      const type = checker.getTypeAtLocation(usage.expression);
      if ((type.isUnion() ? type.types : [type]).some((t) => t.flags & ts.TypeFlags.Null))
        out.add(`${where(tag)} usage に null`);
    }
    if (pressable(tag) && !covered(tag)) {
      // 直す所が分かるよう、覆われていない置き場を添える。
      const top = topLevelOf(tag);
      const placed = ((top && sites.get(top)) ?? []).filter((site) => !covered(site)).map(where);
      out.add(`${where(tag)} 文が無い${placed.length > 0 ? `（置き場: ${placed.join("、")}）` : ""}`);
    }
  }
  return [...out].sort();
}

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
