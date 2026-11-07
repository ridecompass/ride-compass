// 出来事の受け箱の置き場（Durable Object。1つだけ）。受け箱をアラームで処理する（アラームは少なくとも1回は動く）。
import { DurableObject } from "cloudflare:workers";
import { config } from "./config.js";
import { handle } from "./flow.js";
import { GitHub } from "./github.js";
import { Inbox, nextAlarm } from "./inbox.js";

export class Dispatcher extends DurableObject {
  inbox = new Inbox(this.ctx.storage, async (name, payload) => handle(await GitHub.app(this.env, config.installation), this, config, name, payload));

  // 前の出来事のやり直しで先の時刻のアラームが置かれていても、新しい出来事はそれを待たずにすぐ処理する。
  async enqueue(name, payload) {
    await this.inbox.push(name, payload);
    const at = nextAlarm(Date.now(), await this.ctx.storage.getAlarm());
    if (at !== null) await this.ctx.storage.setAlarm(at);
  }

  // 出来事は1回の起こしで1件ずつ処理する（無料のプランの、1回の起こしで外へ出せる要求の上限 50 に、1件の決め直しと振り出しを収める）。
  async alarm() {
    const at = nextAlarm(await this.inbox.drain(config.retries, Date.now(), 1), await this.ctx.storage.getAlarm());
    if (at !== null) await this.ctx.storage.setAlarm(at);
  }
}
