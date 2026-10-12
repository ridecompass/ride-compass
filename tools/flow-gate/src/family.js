// 子と切り出しの決まり（.claude/skills/file-issue/SKILL.md「分ける」）と、その文言・本文の行の形。ゲートは張られたあと・決め直すときに、
// 起票のスクリプト（.claude/skills/file-issue/scripts/new-issue.mjs）は作る前に、同じ決まりを当てて同じ文言で知らせる。

// 親子を張ると孫ができるか（親に親がある・子が子を持つ）。
export const makesGrandchild = (parentHasParent, childHasChildren) => Boolean(parentHasParent || childHasChildren);
export const NO_GRANDCHILD = "孫は作れません。同じ親の兄弟に分けてください。";
export const childRule = (parent, child) => `子は完了の条件を持ちません。条件は親 #${parent} に置き、行の下に「- 子: #${child}」を付けてください。`;
export const CHILD_FIELDS = "子は優先度・着手可能日時を持ちません（ゲートが親の値を読みます）。";

// 要望ごとの切り出しの本文の行「分割元: #N」。
const ORIGIN = /^分割元: #(\d+)\s*$/m;
export const originOf = (body) => Number(ORIGIN.exec(body)?.[1]) || null;
export const originLine = (origin) => `分割元: #${origin}`;
