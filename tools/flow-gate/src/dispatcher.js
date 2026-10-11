// 見回りの置き場（Durable Object。1つだけ）。担当の記録と出来事の受け箱を置き、受け箱をアラームで処理する（アラームは少なくとも1回は動く）。
import { DurableObject } from "cloudflare:workers";
import { config } from "./config.js";
import { handle } from "./flow.js";
import { GitHub } from "./github.js";
import { Inbox, nextAlarm } from "./inbox.js";
import { Patrol } from "./patrol.js";

export class Dispatcher extends DurableObject {
  patrol = new Patrol(this.ctx.storage);
  inbox = new Inbox(this.ctx.storage, async (name, payload) => handle(await GitHub.app(this.env, config.installation), this, config, name, payload));

  async enqueue(name, payload) {
    await this.inbox.push(name, payload);
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now());
  }

  // 出来事は1回の起こしで1件ずつ処理する（無料のプランの、1回の起こしで外へ出せる要求の上限 50 に、1件の決め直しと振り出しを収める）。
  async alarm() {
    const at = nextAlarm(await this.inbox.drain(config.retries, Date.now(), 1), await this.ctx.storage.getAlarm());
    if (at !== null) await this.ctx.storage.setAlarm(at);
  }
}
