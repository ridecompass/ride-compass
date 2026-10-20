// Stryker の除外（ignorers の "class-names"）。書き換えが要素のクラス名（Tailwind のクラスの並び）の値にしか届かない所を、
// 書き換えの対象から外す。見た目は単体テストの役目ではない（e2e と人が見る）ので、ここの書き換えは、どのテストも落とさない
// 生き残りの雑音になる。外した書き換えは表に Ignored として残る。
//
// 外す所: 名前が className で終わる JSX の属性の値・クラスを組み立てる関数（CLASS_BUILDERS）の引数・名前が Class か ClassName で
// 終わる変数と欄の、文字列だけの値。
// 外さない形（生き残りに出る）: クラスの並びを別の名前の変数・欄・引数で運ぶもの・cva の作った関数へ渡す variant の名前。
// 名前が class だけの欄（地図のタイルの分類）は CSS ではないので外さない。
const CLASS_BUILDERS = new Set(["cn", "clsx", "cva", "twMerge"]);
const REASON = "クラス名の値にしか届かない書き換え（見た目は単体テストの役目ではない）";

function isClassName(name) {
  return name === "className" || /[a-z0-9]Class(Name)?$/.test(name);
}

function isText(node) {
  return node?.type === "StringLiteral" || node?.type === "TemplateLiteral";
}

function keyName(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "StringLiteral") return node.value;
  return undefined;
}

const classNames = {
  shouldIgnore(path) {
    const node = path.node;
    if (node.type === "JSXAttribute" && node.name.type === "JSXIdentifier" && /className$/i.test(node.name.name)) {
      return REASON;
    }
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && CLASS_BUILDERS.has(node.callee.name)) {
      return REASON;
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      isClassName(node.id.name) &&
      isText(node.init)
    ) {
      return REASON;
    }
    if (
      node.type === "ObjectProperty" &&
      !node.computed &&
      isClassName(keyName(node.key) ?? "") &&
      isText(node.value)
    ) {
      return REASON;
    }
    return undefined;
  },
};

export const strykerPlugins = [{ kind: "Ignore", name: "class-names", value: classNames }];
