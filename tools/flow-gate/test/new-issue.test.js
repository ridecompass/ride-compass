// 起票のスクリプト（.claude/skills/file-issue/scripts/new-issue.mjs: file）が GitHub へ書く所。gh を打つ関数を差し替え、書く要求（作る・前後の
// 関係を張る）の中身と回数と、作れない・作る1回が落ちたときに書かずに返す文を見る。読む要求は応答を差し替えるだけにする。
// 本文の形・子の決まり・欄の値の照らし（issueProblems）と欄の入れ直し（fillFields）は scripts.test.js が見る。
import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../src/bot.js";
import { file } from "../../../.claude/skills/file-issue/scripts/new-issue.mjs";

const BODY = "要約の1行\n\n<details><summary>要望: 困りごと</summary>\n\n- 困る\n\n</details>\n\n<details><summary>完了の条件</summary>\n\n- [ ] 作った\n\n</details>\n";
const CHILD = "子の要約\n\n<details><summary>やること</summary>\n\n1. 作る\n\n</details>\n\n<details><summary>完了の条件</summary>\n\n- [ ] 部品を作った\n\n</details>\n"; // 子も自分の約束を持つ
const TYPES = { nodes: [{ id: "T要望", name: "要望" }, { id: "T対話", name: config.dialogType }] };
const OPEN_PARENT = { id: "P5", state: "OPEN", issueType: { name: "要望" }, parent: null };
const MADE = { id: "I_NEW", number: 900, url: "https://example.invalid/900" };
const f = config.fields;

// 置き場の読み（repo）・作る応答（create）・作られたかの読み（made）を差し替えた gh。書いた要求（mutation）を writes に残す。
// 応答に throw を置くと、gh が 1 で終わったとき（stderr・stdout 付き）と同じに投げる。
function fake({ repo = {}, create = { data: { createIssue: { issue: MADE } } }, made = [] } = {}) {
  const writes = [];
  const reply = (r) => {
    if (r?.throw) throw Object.assign(new Error("gh が落ちた"), r.throw);
    return JSON.stringify(r);
  };
  const gh = (args, input) => {
    const { query, variables } = JSON.parse(input);
    if (query.startsWith("mutation")) {
      writes.push({ query, variables });
      return reply(query.includes("createIssue") ? create : { data: {} });
    }
    if (query.includes("issueTypes")) return reply(repo.throw ? repo : { data: { repository: { id: "R", issueTypes: TYPES, ...repo } } });
    return reply(made.throw ? made : { data: { repository: { issues: { nodes: made } } } });
  };
  return { gh, writes };
}
const run = (opts, body, stub) => {
  const { gh, writes } = fake(stub);
  return { ...file(gh, { title: "題", ...opts }, body, new Date("2026-10-12T13:00:00Z")), writes };
};

test("起票する（new-issue.mjs）: 種類・親・欄は作る1回に入れ、前後の関係は別名を並べた1回で張る", () => {
  const rows = [
    ["子と欄と前後の関係", { parent: "5", size: "S", "blocked-by": "7", blocking: "#8" }, CHILD, { parent: OPEN_PARENT, i7: { id: "B7" }, i8: { id: "K8" } },
      { issueTypeId: "T要望", parentIssueId: "P5", issueFields: [{ fieldId: f.size.id, singleSelectOptionId: f.size.options.S }] }, [{ i0: "I_NEW", b0: "B7", i1: "K8", b1: "I_NEW" }]],
    ["親も欄も関係も無い対話作業", { type: config.dialogType }, BODY, {}, { issueTypeId: "T対話" }, []],
  ];
  for (const [name, opts, body, repo, input, relate] of rows) {
    const r = run(opts, body, { repo });
    assert.equal(r.err, null, name);
    assert.equal(r.out[0], MADE.url, name);
    assert.deepEqual(r.writes[0].variables.in, { repositoryId: "R", title: "題", body, ...input }, `${name}: 作る1回`);
    assert.deepEqual(r.writes.slice(1).map((w) => w.variables), relate, `${name}: 関係を張る1回`);
  }
});

test("起票する（new-issue.mjs）: 作れない理由があれば、作る・張るのどちらも書かずに理由を返す", () => {
  const notFound = (repo) => ({ throw: { stdout: JSON.stringify({ data: { repository: { id: "R", issueTypes: TYPES, ...repo } }, errors: [{ type: "NOT_FOUND", message: "無い" }] }) } });
  const rows = [
    ["本文が形に合わない（読む前に断る）", { type: "要望", size: "S", priority: "中" }, "<details><summary>完了の条件</summary>\n\n- [ ] 作った\n\n</details>", {}, /畳まない要約が無い/],
    ["前後の issue が無い（gh が NOT_FOUND で 1 で終わる）", { type: "要望", size: "S", priority: "中", "blocked-by": "7,99" }, BODY, notFound({ i7: { id: "B7" }, i99: null }), /#99 が無い/],
    ["親が子", { parent: "5" }, CHILD, { parent: { ...OPEN_PARENT, parent: { number: 3 } } }, /#3 の子です/],
    ["親が閉じている", { parent: "5" }, CHILD, { parent: { ...OPEN_PARENT, state: "CLOSED" } }, /閉じている/],
    ["親に種類が無い", { parent: "5" }, CHILD, { parent: { ...OPEN_PARENT, issueType: null } }, /種類が無い/],
    ["分割元が番号でない（読む前に断る）", { type: "要望", size: "S", priority: "中", origin: "#5" }, BODY, {}, /分割元は番号で書く/],
    ["置き場に無い種類", { type: "要旨", size: "S", priority: "中" }, BODY, {}, /種類「要旨」は置き場に無い/],
    ["置き場を読めない（5xx）", { type: "要望", size: "S", priority: "中" }, BODY, { throw: { stderr: "HTTP 502" } }, /置き場を読めなかった（HTTP 502）/],
  ];
  for (const [name, opts, body, repo, want] of rows) {
    const r = run(opts, body, { repo });
    assert.match(r.err, want, name);
    assert.deepEqual([r.out, r.writes], [[], []], `${name}: 書かない`);
  }
});

test("起票する（new-issue.mjs）: 作る1回が答えずに落ちたら、作り直さずに作られたかを読んで返す", () => {
  const down = { throw: { stderr: "HTTP 502" } };
  const opts = { type: "要望", size: "S", priority: "中", "blocked-by": "7" };
  const repo = { i7: { id: "B7" } };
  const rows = [
    ["作られていた", [{ number: 12, url: "u12", title: "別の題" }, { number: 13, url: "u13", title: "題" }], /#13 は作られていた（作り直さない）: u13。前後の関係は次で張る:\n.*gh issue edit 13 .*--add-blocked-by 7$/],
    ["作られていない", [{ number: 12, url: "u12", title: "別の題" }], /作られていない。GitHub が戻ってから打ち直す/],
    ["作られたかも読めない", { throw: { stderr: "HTTP 503" } }, /作られたかも確かめられなかった（HTTP 503）/],
  ];
  for (const [name, made, want] of rows) {
    const r = run(opts, BODY, { repo, create: down, made });
    assert.match(r.err, want, name);
    assert.equal(r.writes.length, 1, `${name}: 作る1回だけを打ち、作り直さず、関係も張らない`);
  }
});

test("起票する（new-issue.mjs）: 作る応答に誤りが付いても、issue が返れば作ったと扱い、返らなければ作らなかったと返す", () => {
  const opts = { type: "要望", size: "S", priority: "中", "blocked-by": "7" };
  const rows = [
    ["issue が返った（関係は張らずに返す）", { data: { createIssue: { issue: MADE } }, errors: [{ message: "欄の誤り" }] }, [MADE.url],
      /^#900 は作った（作り直さない）が、誤りが返った（欄の誤り）/],
    ["issue が返らない", { data: { createIssue: null }, errors: [{ message: "許しが無い" }] }, [], /^作らなかった: 許しが無い$/],
  ];
  for (const [name, create, out, err] of rows) {
    const r = run(opts, BODY, { repo: { i7: { id: "B7" } }, create });
    assert.deepEqual(r.out, out, name);
    assert.match(r.err, err, name);
    assert.equal(r.writes.length, 1, `${name}: 作る1回だけ`);
  }
});
