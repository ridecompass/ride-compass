// 列挙が当てる語彙を生成物と軸カタログから読む（scripts/structure-population.mjs の (a)(b)(d) が使う）。

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 生成物の文字列の値と、その値を持つ鍵（配列の要素なら外側の鍵）。.ts の生成物は構文木から、.json は値の木から取る。 */
function generatedStrings(generatedRoot, population) {
  const strings = [];
  const visitJson = (value, key) => {
    if (typeof value === "string") strings.push({ value, key });
    else if (Array.isArray(value)) value.forEach((item) => visitJson(item, key));
    else if (value && typeof value === "object") Object.entries(value).forEach(([k, v]) => visitJson(v, k));
  };
  for (const file of walk(generatedRoot)) {
    const name = path.basename(file);
    if (population.generatedWithoutNames.includes(name)) continue;
    const text = readFileSync(file, "utf-8");
    if (name.endsWith(".json")) {
      visitJson(JSON.parse(text), null);
      continue;
    }
    const visit = (node) => {
      if (ts.isStringLiteral(node) && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) {
        let owner = node.parent;
        while (ts.isArrayLiteralExpression(owner)) owner = owner.parent;
        strings.push({
          value: node.text,
          key: ts.isPropertyAssignment(owner) ? owner.name.getText().replaceAll('"', "") : null,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  }
  return strings;
}

/** 生成物の文字列の値（名前として配らない生成物の、型に書かれた字句を含む）。(d) が型を生成物の値と見るのに使う。 */
function generatedLiteralValues(generatedRoot, generated) {
  const values = new Set(generated.map(({ value }) => value));
  for (const file of walk(generatedRoot).filter((name) => /\.d\.ts$/.test(name))) {
    const visit = (node) => {
      if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) values.add(node.literal.text);
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true));
  }
  return values;
}

function axisCatalogWords(axisCatalog) {
  if (!axisCatalog) return [];
  const catalog = JSON.parse(readFileSync(axisCatalog, "utf-8"));
  return catalog.axes.map((axis) => axis.label);
}

/**
 * 語彙: 生成物の識別子の形の値（(a)）・生成物の字句（(d)）・現象の語と軸名（(b)。長い順）。
 * 現象の語は、生成物が名前として配る値。軸名は `axisCatalog`（JSON のファイル）を渡したときだけ入る。
 */
export function readVocabulary({ generatedRoot, population, axisCatalog }) {
  const generated = generatedStrings(generatedRoot, population);
  const japanese = new RegExp(population.japanese);
  const phenomenonWords = generated
    .filter(
      ({ value, key }) =>
        key === population.nameKey && japanese.test(value) && value.length >= population.nameMinLength,
    )
    .map(({ value }) => value);
  return {
    generatedIdentifiers: new Set(generated.map(({ value }) => value).filter((value) => IDENTIFIER.test(value))),
    generatedLiterals: generatedLiteralValues(generatedRoot, generated),
    words: [...new Set([...phenomenonWords, ...axisCatalogWords(axisCatalog)])].sort((a, b) => b.length - a.length),
  };
}
