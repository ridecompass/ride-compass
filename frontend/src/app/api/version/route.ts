import { NextResponse } from "next/server";

// サーバーのプロセスが起きた時刻（モジュールを読み込んだとき1回だけ決まる）。
const STARTED_AT = new Date().toISOString();

// 応答をビルドの時点で固めず、動いているプロセスの値を返す。
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    // 像にしたコミットのフルSHA。渡さずに作った像と手元では null。
    commit: process.env.GIT_COMMIT || null,
    started_at: STARTED_AT,
  });
}
