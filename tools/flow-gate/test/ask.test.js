// 問いを出すスクリプト（.claude/skills/ask/scripts/ask.mjs）を、打つのと同じ形で動かす。形に合わない問いは出さずに止まり、形に合う問いは照らしを通る。
// 置き場へ書かないよう、照らしを通った問いは FLOW_BOT_TOKEN を外して出す直前で止める。
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/bot.js";
import { askText, withButton } from "../src/questions.js";
import { formed } from "./forms.js";

const script = fileURLToPath(new URL("../../../.claude/skills/ask/scripts/ask.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "ask-"));
function ask(text) {
  const file = join(dir, `q${Math.random()}.md`);
  writeFileSync(file, text);
  const env = { ...process.env };
  delete env.FLOW_BOT_TOKEN;
  return spawnSync(process.execPath, [script, "823", file], { encoding: "utf8", env });
}

const judge = formed("判断", "どちらにしますか？", [["案A", "推奨", "早い"], ["案B", "理由", "安い"]]);

test("形に合わない問いは出さない（#823: 回答のボタンを先頭に付けた問い）", () => {
  const r = ask(withButton(judge, config, 823));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /問いが形に合わないので出さない/);
});

test("ゲートが出すラベルの問いは、Claude は出さない", () => {
  const r = ask(askText("採否", config.questionForms));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /採否の問いはゲートだけが出す/);
});

test("形に合う問いは照らしを通り、出す段へ進む", () => {
  const r = ask(judge);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FLOW_BOT_TOKEN が無いので書かない/);
});
