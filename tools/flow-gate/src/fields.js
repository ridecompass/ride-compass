// issue の欄（issue fields。ステータス・優先度・規模・着手可能日時）の読み書きと、欄の値の形。ゲートと起票のスクリプト
// （.claude/skills/file-issue/scripts/new-issue.mjs）が使う。欄と選択肢の id は設定が持つ（ゲートの App は組織の欄の一覧を読めない）。

// 読み方（GraphQL の issue の中に置く）と、欄の名前ごとの値。
export const FIELDS = `issueFieldValues(first:20){nodes{...on IssueFieldSingleSelectValue{name field{...on IssueFieldSingleSelect{name}}}
 ...on IssueFieldTextValue{value field{...on IssueFieldText{name}}}}}`;
export const valuesOf = (issue) => Object.fromEntries(issue.issueFieldValues.nodes.filter((v) => v.field).map((v) => [v.field.name, v.name ?? v.value]));

// 着手可能日時は「YYYY-MM-DD」か「YYYY-MM-DD HH:MM」（日本時間）だけを受ける。
export const START_FORM = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/;

// 書く値が欄に合わない所（空なら合う）。values は [設定の欄の名前（status 等）, 値] の並び。
export function fieldProblems(config, values) {
  return values.flatMap(([key, value]) => {
    const f = config.fields[key];
    if (f.options) return f.options[value] ? [] : [`${f.name}「${value}」は ${Object.keys(f.options).join("・")} のどれか`];
    return key === "start" && !START_FORM.test(value) ? [`${f.name}「${value}」は YYYY-MM-DD か YYYY-MM-DD HH:MM（日本時間）`] : [];
  });
}

// 書く1回の問い合わせと、その値。合わない値は書かない。
export const SET_FIELDS = "mutation($i:ID!,$v:[IssueFieldCreateOrUpdateInput!]!){setIssueFieldValue(input:{issueId:$i,issueFields:$v}){clientMutationId}}";
export function fieldValues(config, values) {
  const problems = fieldProblems(config, values);
  if (problems.length) throw new Error(problems.join("・"));
  return values.map(([key, value]) => {
    const f = config.fields[key];
    return f.options ? { fieldId: f.id, singleSelectOptionId: f.options[value] } : { fieldId: f.id, textValue: value };
  });
}
