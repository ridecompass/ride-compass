// ゲート: GitHub の出来事から決め直すタスクを決め、事実を全部読み（src/facts.js）、あるべき姿を決め（src/decide.js）、今と違う所だけを書く。
// ステータスと、変わってはいけない値（種類・担当者・本文のボタンと条件）を書くのはゲートだけ。
import { decide } from "./decide.js";
import { readFacts } from "./facts.js";
import { askDropped, askText, bodyRest, norm } from "./questions.js";

// issue の欄（issue fields）へ値を書く1回の問い合わせ（起票のスクリプト .claude/skills/file-issue/scripts/new-issue.mjs も使う）。欄と選択肢の id は
// 設定が持つ（ゲートの App は組織の欄の一覧を読めない）。values は [設定の欄の名前（status 等）, 値] の並び。
export const SET_FIELDS = "mutation($i:ID!,$v:[IssueFieldCreateOrUpdateInput!]!){setIssueFieldValue(input:{issueId:$i,issueFields:$v}){clientMutationId}}";
export function fieldValues(config, values) {
  return values.map(([key, value]) => {
    const f = config.fields[key];
    if (!f.options) return { fieldId: f.id, textValue: value };
    if (!f.options[value]) throw new Error(`欄「${f.name}」に「${value}」が無い（${Object.keys(f.options).join("・")}）`);
    return { fieldId: f.id, singleSelectOptionId: f.options[value] };
  });
}

// 決めた問い（種類の名前か、見送りの相手を持つもの）の文。
const askBody = (ask, config) => (ask.dropped ? askDropped(ask.dropped, config.questionTemplate) : askText(ask, config.questionTemplate));

// 1つのタスクを決め直して、今と違う所だけを書く。本文（ボタン）は問いのコメントより先に書く（問いの通知から開いたときにボタンがあるように）。閉じるのは最後。
// runs は出来事1件につき1回読んだ担当の実行の一覧（src/facts.js: recentRuns）。moved は、ユーザーがステータスの欄を変えた出来事で
// 決め直すとき（戻したら知らせる）。
export async function settle(gh, config, number, runs, moved = false) {
  const f = { ...(await readFacts(gh, config, number, runs)), moved };
  const d = decide(f, config);
  const issue = `/repos/${config.tasks}/issues/${number}`;
  const patch = { ...(d.open && !f.open ? { state: "open" } : {}), ...(d.type !== f.type ? { type: d.type } : {}), ...(d.body !== norm(f.body) ? { body: d.body } : {}),
    ...(String(d.assignees) !== String(f.assignees) ? { assignees: d.assignees } : {}) };
  if (Object.keys(patch).length) await gh.rest("PATCH", issue, patch);
  if (d.ask) await gh.rest("POST", `${issue}/comments`, { body: askBody(d.ask, config) });
  if (d.notice) await gh.rest("POST", `${issue}/comments`, { body: d.notice });
  if (d.closePr) await gh.gql(`mutation($id:ID!){closePullRequest(input:{pullRequestId:$id}){clientMutationId}}`, { id: d.closePr });
  if (d.ready) await gh.gql(`mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){clientMutationId}}`, { id: f.pr.id });
  if (d.status !== f.status) await gh.gql(SET_FIELDS, { i: f.id, v: fieldValues(config, [["status", d.status]]) });
  if (!d.open && f.open) await gh.rest("PATCH", issue, { state: "closed", state_reason: d.closeAs.toLowerCase() });
  // 取り消しは、もう終わった・取り消し中の実行なら済んでいる（GitHub は 409 を返す）。
  await Promise.all(d.cancel.map((id) => gh.rest("POST", `/repos/${config.code}/actions/runs/${id}/cancel`).catch((e) => {
    if (!/: 409 /.test(e.message)) throw e;
  })));
  return { ...f, ...d, closedNow: f.open && !d.open };
}

// 閉じた・開き直した issue から、矢印1本でつながる開いた issue（後・親・子）。
export async function near(gh, config, number) {
  const [o, r] = config.tasks.split("/");
  const x = (await gh.gql(`query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){blocking(first:20){nodes{number state}}
    parent{number state} subIssues(first:50){nodes{number state}}}}}`, { o, r, n: number })).repository.issue;
  return [...x.blocking.nodes, ...(x.parent ? [x.parent] : []), ...x.subIssues.nodes].filter((i) => i.state === "OPEN").map((i) => i.number);
}

// 事実を変える出来事だけを、決まった置き場から受ける。ゲート自身の書き込みのこだまは受けない（ゲートが閉じた issue の先は、閉じたその場で決め直す。src/flow.js: handle）。
const ACTIONS = { issues: ["opened", "closed", "reopened", "typed", "untyped", "labeled", "unlabeled", "edited", "assigned", "unassigned", "field_added", "field_removed"],
  issue_comment: ["created"], pull_request: ["opened", "closed", "reopened", "synchronize", "converted_to_draft", "ready_for_review"], workflow_run: ["requested", "completed"],
  sub_issues: ["sub_issue_added", "sub_issue_removed"] }; // 親子1本につき親の側と子の側の2つが届くので、親の側だけを受ける
const REPO = { issues: "tasks", issue_comment: "tasks", pull_request: "code", workflow_run: "code", sub_issues: "tasks" };
const OWN = ["workflow_run"]; // ゲート自身の出来事でも受けるもの（起こした担当の実行）
export const ignored = (config, name, p) => !ACTIONS[name]?.includes(p.action) || (REPO[name] && p.repository?.full_name !== config[REPO[name]])
  || (p.sender?.login === config.gateBot && !OWN.includes(name) && !OWN.includes(`${name} ${p.action}`));
const branch = (config, ref) => (ref?.startsWith(config.branchPrefix) ? [Number(ref.slice(config.branchPrefix.length))] : []);

const ROUTES = {
  async issues(gh, config, p) {
    // 回答のボタンだけを書き足した本文の書き換えは受けない（問う者はボタンを書いてから問いを書くので、ここで決め直すとボタンを消す）。
    const buttonOnly = p.action === "edited" && p.changes?.body && bodyRest(p.changes.body.from) === bodyRest(p.issue.body);
    // ユーザーが欄（ステータス等）を変えた。ゲートが事実へ戻したら知らせる。
    if (p.action === "field_added" || p.action === "field_removed") return { numbers: [p.issue.number], moved: p.sender?.login === config.user };
    if (p.action !== "closed" && p.action !== "reopened") return buttonOnly ? [] : [p.issue.number];
    // 閉じた・開き直したら、矢印1本でつながる開いた issue（後・親・子）も決め直す。
    return [p.issue.number, ...(await near(gh, config, p.issue.number))];
  },
  // 親子が張られた・外された。孫になる張り方（親に親がある・子が子を持つ）は、張られた直後に外して子に知らせる（作る前に止める口は GitHub に無い）。
  async sub_issues(gh, config, p) {
    const [parent, child] = [p.parent_issue, p.sub_issue];
    if (p.action === "sub_issue_added") {
      const [o, r] = config.tasks.split("/");
      const x = (await gh.gql(`query($o:String!,$r:String!,$p:Int!,$c:Int!){repository(owner:$o,name:$r){p:issue(number:$p){parent{number}}
        c:issue(number:$c){subIssues(first:1){nodes{number}}}}}`, { o, r, p: parent.number, c: child.number })).repository;
      if (x.p.parent || x.c.subIssues.nodes.length) {
        await gh.gql(`mutation($p:ID!,$c:ID!){removeSubIssue(input:{issueId:$p,subIssueId:$c}){clientMutationId}}`, { p: parent.node_id, c: child.node_id });
        await gh.rest("POST", `/repos/${config.tasks}/issues/${child.number}/comments`,
          { body: `孫は作れないので、#${parent.number} との親子の関係を外しました。同じ親の兄弟に分けてください。` });
      }
    }
    return [parent.number, child.number];
  },
  issue_comment: (gh, config, p) => [p.issue.number],
  pull_request: (gh, config, p) => branch(config, p.pull_request.head.ref),
  // CI の終わり。マージのコミットの CI は、そのコミットの PR の作業ブランチのタスク。
  async workflow_run(gh, config, p) {
    const w = p.workflow_run;
    if (p.action !== "completed") return [];
    const pulls = w.head_branch === config.base ? await gh.rest("GET", `/repos/${config.code}/commits/${w.head_sha}/pulls`) : [];
    return [w.head_branch, ...pulls.map((pr) => pr.head.ref)].flatMap((ref) => branch(config, ref));
  },
};
export async function route(gh, config, name, p) {
  const r = await ROUTES[name](gh, config, p);
  return Array.isArray(r) ? { numbers: r } : r;
}
