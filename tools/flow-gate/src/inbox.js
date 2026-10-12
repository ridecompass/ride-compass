// 届いた出来事の受け箱。受け取ったと返す前に書くので、処理が落ちても出来事を失わない。1件1キーなので、入れるのと処理するのが重なっても
// 互いを消さない。一時の失敗は間をあけてやり直し（後ろの出来事は先に進む）、直らない失敗と retries 回落ちたものは諦めて failed: に残す。
// 次に起こす時刻（置かないなら null）。置かれたアラームが無いか、それより早いときだけ置く（処理の間に入った出来事が置いた早いアラームを、
// 遅いやり直しの時刻で上書きしない）。
export const nextAlarm = (next, set) => (next !== null && (set === null || next < set) ? next : null);

export class Inbox {
  constructor(storage, process) { Object.assign(this, { storage, process }); }
  push(name, payload) { return this.storage.put(`q:${Date.now()}:${crypto.randomUUID()}`, { name, payload, tries: 0 }); }

  // やり直しを待つ出来事が残れば、次に起こす時刻を返す。limit 件を処理したら、まだあっても今の時刻を返して次の起こしに回す
  // （Worker の1回の起こしで外へ出せる要求の数には上限がある）。
  async drain(retries, now = Date.now(), limit = Infinity) {
    for (let done = 0; ; ) {
      const queue = [...(await this.storage.list({ prefix: "q:" }))];
      const ready = queue.filter(([, e]) => !(e.after > now));
      if (!ready.length) {
        const waits = queue.map(([, e]) => e.after).filter((t) => t > now);
        return waits.length ? Math.min(...waits) : null;
      }
      for (const [key, e] of ready) {
        if (done++ >= limit) return now;
        try {
          await this.process(e.name, e.payload);
        } catch (error) {
          if (error.transient && e.tries + 1 < retries) {
            await this.storage.put(key, { ...e, tries: e.tries + 1, after: now + 2 ** e.tries * 60e3 });
            continue;
          }
          await this.storage.put(`failed:${key}`, { name: e.name, error: String(error.message).split("\n")[0] });
        }
        await this.storage.delete(key);
      }
    }
  }

  // まだ処理していない、その名前の出来事の中身。
  async pending(name) { return [...(await this.storage.list({ prefix: "q:" })).values()].filter((e) => e.name === name).map((e) => e.payload); }
  async failed() { return [...(await this.storage.list({ prefix: "failed:" })).values()]; }
  async clear() { await this.storage.delete([...(await this.storage.list({ prefix: "failed:" })).keys()]); }
}
