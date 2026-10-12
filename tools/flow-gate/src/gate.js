// ゲート: GitHub の出来事から決め直すタスクを決め、事実を全部読み（src/facts.js）、あるべき姿を決め（src/decide.js）、今と違う所だけを書く。
// ステータスと、変わってはいけない値（種類・担当者・本文のボタンと条件）を書くのはゲートだけ。GitHub への要求は、1件につき読む1回と書く1回
// （と、取り消す実行ごとに1回。Actions の取り消しは1回にまとめる口が無い）。
import { decide } from "./decide.js";
import { readFacts } from "./facts.js";
import { askDropped, askText, bodyRest, confirmConditions, norm } from "./questions.js";

// 決めた問い（種類の名前か、見送りの相手を持つもの）の文。確かめに並べる条件は、書く本文（決めた本文）から取る。
const askBody = (ask, config, body) => (ask.dropped ? askDropped(ask.dropped, config.questionTemplate) : askText(ask, config.questionTemplate, confirmConditions(body)));

// 今と違う所だけの書き込み（[GraphQL の書き込みの名前, 入力の型, 入力]）。GitHub は1回の要求に並べた書き込みを、並べた順に1つずつ行う。
// 本文（ボタン）は問いのコメントより先に書く（問いの通知から開いたときにボタンがあるように）。閉じるのは最後。
export function writesOf(f, d, config) {
  const ops = [];
  const issue = {};
  if (d.open && !f.open) issue.stateInput = { value: "OPEN" };
  if (d.type !== f.type) issue.issueTypeId = d.type ? f.ids.types[d.type] : null;
  if (d.body !== norm(f.body)) issue.body = d.body;
  if (String(d.assignees) !== String(f.assignees)) issue.assigneeIds = d.assignees.map((login) => config.ids[login]);
  const fields = [["status", d.status, f.status], ["run", d.run, f.run]].filter(([, want, now]) => (want ?? null) !== (now ?? null));
  if (fields.length) issue.issueFieldUpdates = fields.map(([key, value]) =>
    (value ? { fieldName: config.fields[key].name, operation: "SET", value } : { fieldName: config.fields[key].name, operation: "CLEAR" }));
  if (Object.keys(issue).length) ops.push(["updateIssue", "UpdateIssueInput", { id: f.id, ...issue }]);
  for (const body of [d.ask && askBody(d.ask, config, d.body), d.notice]) if (body) ops.push(["addComment", "AddCommentInput", { subjectId: f.id, body }]);
  if (d.closePr) ops.push(["closePullRequest", "ClosePullRequestInput", { pullRequestId: d.closePr }]);
  if (d.ready) ops.push(["markPullRequestReadyForReview", "MarkPullRequestReadyForReviewInput", { pullRequestId: f.pr.id }]);
  if (!d.open && f.open) ops.push(["closeIssue", "CloseIssueInput", { issueId: f.id, stateReason: d.closeAs }]);
  return ops;
}
const mutation = (ops) => `mutation(${ops.map(([, type], k) => `$v${k}:${type}!`).join(",")}){${ops.map(([name], k) => `w${k}:${name}(input:$v${k}){clientMutationId}`).join(" ")}}`;

// 1つのタスクを決め直して、今と違う所だけを書く。runs は出来事1件につき1回読んだ担当の実行の一覧（src/facts.js: recentRuns）。
// moved は、ユーザーがステータスの欄を変えた出来事で決め直すとき（戻したら知らせる）。
export async function settle(gh, config, number, runs, moved = false) {
  const f = { ...(await readFacts(gh, config, number, runs)), moved };
  const d = decide(f, config);
  const ops = writesOf(f, d, config);
  if (ops.length) await gh.gql(mutation(ops), Object.fromEntries(ops.map(([, , input], k) => [`v${k}`, input])));
  // 取り消しは、もう終わった・取り消し中の実行なら済んでいる（GitHub は 409 を返す）。
  await Promise.all(d.cancel.map((id) => gh.rest("POST", `/repos/${config.code}/actions/runs/${id}/cancel`).catch((e) => {
    if (!/: 409 /.test(e.message)) throw e;
  })));
  return { ...f, ...d, closedNow: f.open && !d.open };
}

// 事実を変える出来事だけを、決まった置き場から受ける。ゲート自身の書き込みのこだまは受けない（ゲートが閉じた issue の先は、閉じたその場で決め直す。src/flow.js: handle）。
const ACTIONS = { issues: ["opened", "closed", "reopened", "typed", "untyped", "labeled", "unlabeled", "edited", "assigned", "unassigned", "field_added", "field_removed"],
  issue_comment: ["created"], pull_request: ["opened", "closed", "reopened", "synchronize", "converted_to_draft", "ready_for_review"],
  workflow_run: ["requested", "in_progress", "completed"],
  sub_issues: ["sub_issue_added", "sub_issue_removed"] }; // 親子1本につき親の側と子の側の2つが届くので、親の側だけを受ける
const REPO = { issues: "tasks", issue_comment: "tasks", pull_request: "code", workflow_run: "code", sub_issues: "tasks" };
const OWN = ["workflow_run"]; // ゲート自身の出来事でも受けるもの（起こした担当の実行）
export const ignored = (config, name, p) => !ACTIONS[name]?.includes(p.action) || (REPO[name] && p.repository?.full_name !== config[REPO[name]])
  || (p.sender?.login === config.gateBot && !OWN.includes(name) && !OWN.includes(`${name} ${p.action}`));
const branch = (config, ref) => (ref?.startsWith(config.branchPrefix) ? [Number(ref.slice(config.branchPrefix.length))] : []);

// 出来事が指す issue。around は、閉じた・開き直したので矢印1本でつながる開いた issue（後・親・子）も決め直すとき。
const ROUTES = {
  issues(gh, config, p) {
    // 回答のボタンだけを書き足した本文の書き換えは受けない（問う者はボタンを書いてから問いを書くので、ここで決め直すとボタンを消す）。
    const buttonOnly = p.action === "edited" && p.changes?.body && bodyRest(p.changes.body.from) === bodyRest(p.issue.body);
    // ユーザーが欄（ステータス等）を変えた。ゲートが事実へ戻したら知らせる。
    if (p.action === "field_added" || p.action === "field_removed") return { numbers: [p.issue.number], moved: p.sender?.login === config.user };
    return { numbers: buttonOnly ? [] : [p.issue.number], around: p.action === "closed" || p.action === "reopened" };
  },
  // 親子が張られた・外された。孫になる張り方（親に親がある・子が子を持つ）は、張られた直後に外して子に知らせる（作る前に止める口は GitHub に無い）。
  async sub_issues(gh, config, p) {
    const [parent, child] = [p.parent_issue, p.sub_issue];
    if (p.action === "sub_issue_added") {
      const [o, r] = config.tasks.split("/");
      const x = (await gh.gql(`query($o:String!,$r:String!,$p:Int!,$c:Int!){repository(owner:$o,name:$r){p:issue(number:$p){parent{number}}
        c:issue(number:$c){subIssues(first:1){nodes{number}}}}}`, { o, r, p: parent.number, c: child.number })).repository;
      if (x.p.parent || x.c.subIssues.nodes.length) {
        await gh.gql(`mutation($p:ID!,$c:ID!,$b:String!){removeSubIssue(input:{issueId:$p,subIssueId:$c}){clientMutationId}
          addComment(input:{subjectId:$c,body:$b}){clientMutationId}}`,
        { p: parent.node_id, c: child.node_id, b: `孫は作れないので、#${parent.number} との親子の関係を外しました。同じ親の兄弟に分けてください。` });
      }
    }
    return { numbers: [parent.number, child.number] };
  },
  issue_comment: (gh, config, p) => ({ numbers: [p.issue.number] }),
  pull_request: (gh, config, p) => ({ numbers: branch(config, p.pull_request.head.ref) }),
  // 検査の実行の出来事（申し込み・始まり・終わり）。マージのコミットの検査は、そのコミットの PR の作業ブランチのタスク。
  async workflow_run(gh, config, p) {
    const w = p.workflow_run;
    const pulls = w.head_branch === config.base ? await gh.rest("GET", `/repos/${config.code}/commits/${w.head_sha}/pulls`) : [];
    return { numbers: [w.head_branch, ...pulls.map((pr) => pr.head.ref)].flatMap((ref) => branch(config, ref)) };
  },
};
export const route = (gh, config, name, p) => ROUTES[name](gh, config, p);
