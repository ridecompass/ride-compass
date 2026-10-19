// @vitest-environment node
/**
 * `lib/backendRewrites.ts`——開発サーバーと本番の像の取り次ぎの組み立てと、開発機の画面を本番のデータで開く切り替えの判断。
 *
 * 判断は環境変数を引数で受ける関数にあり、それを呼ぶ。`next.config.ts` は呼ばない——環境変数を読むだけの薄い層で、
 * テストで `process.env` を立てると並行する別のファイルの期待値が変わる（testing-frontend.md「パターン7」）。
 *
 * ここで見ないもの:
 * - 取り次いだ先が本当に応答すること → 開発機で起こして画面で確かめる（docs/architecture/setup.md「開発機の画面を本番のデータで開く」）
 */
import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";

import { backendRewrites, lanHosts, PROD_DATA_API_PREFIX, prodDataBackend } from "@/lib/backendRewrites";
import { mapDisplay } from "@/types/generated/mapDisplay";

const PROD = "https://prod.example.com";
const LOCAL = "http://localhost:8000";
const readProd = () => PROD;

describe("prodDataBackend", () => {
  it("切り替えが入った開発サーバーでは、本番の backend の住所を返す", () => {
    expect(prodDataBackend({ RC_PROD_DATA: "1", NODE_ENV: "development" }, readProd)).toBe(PROD);
  });

  it.each([
    ["切り替えが無い開発サーバー", { NODE_ENV: "development" }],
    ["切り替えが1でない", { RC_PROD_DATA: "true", NODE_ENV: "development" }],
    ["本番の像のビルド（切り替えが入っていても）", { RC_PROD_DATA: "1", NODE_ENV: "production" }],
  ])("%s では null を返し、本番の宛先を読まない", (_scene, env) => {
    const read = () => {
      throw new Error("本番の宛先を読んだ");
    };
    expect(prodDataBackend(env, read)).toBeNull();
  });
});

describe("backendRewrites", () => {
  it("本番のデータで開かないときは、どの口も開発機の backend へ取り次ぎ、API の口を足さない", () => {
    const rewrites = backendRewrites(LOCAL, null);
    expect(rewrites.map((r) => r.destination.startsWith(`${LOCAL}/api/`))).not.toContain(false);
    expect(rewrites.map((r) => r.source)).not.toContain(`${PROD_DATA_API_PREFIX}/:path*`);
  });

  it("本番のデータで開くときは、地図の下地だけを開発機の backend に残し、タイルと API を本番の backend へ向ける", () => {
    const rewrites = backendRewrites(LOCAL, PROD);
    const target = (source: string) => rewrites.find((r) => r.source === source)?.destination;
    expect(target("/api/basemap/:path*")).toBe(`${LOCAL}/api/basemap/:path*`);
    expect(target("/api/region/road-surface-tiles/:path*")).toBe(`${PROD}/api/region/road-surface-tiles/:path*`);
    expect(target(`${PROD_DATA_API_PREFIX}/:path*`)).toBe(`${PROD}/:path*`);
    const toLocal = rewrites.filter((r) => r.destination.startsWith(LOCAL)).map((r) => r.source);
    expect(toLocal).toEqual(["/api/basemap/:path*"]);
  });

  it("地図の出典表記が同じオリジンの住所でリンクする backend の口は、どれも取り次ぐ（取り次がないと、リンクが画面の 404 になる）", () => {
    const linked = mapDisplay.alwaysShownAttributions.flatMap((html) => [...html.matchAll(/href="(\/api\/[^"]+)"/g)].map((m) => m[1]));
    expect(linked).not.toHaveLength(0);
    const sources = backendRewrites(LOCAL, null).map((r) => r.source);
    expect(linked.filter((path) => !sources.includes(path))).toEqual([]);
  });

  it("どちらでも、取り次ぐ口の並びは同じで、API の口だけが増える", () => {
    const local = backendRewrites(LOCAL, null).map((r) => r.source);
    const prod = backendRewrites(LOCAL, PROD).map((r) => r.source);
    expect(prod).toEqual([...local, `${PROD_DATA_API_PREFIX}/:path*`]);
  });
});

describe("lanHosts", () => {
  const address = (value: string, family: "IPv4" | "IPv6" = "IPv4", internal = false) =>
    ({ address: value, family, internal }) as NetworkInterfaceInfo;

  it("外へ出るプライベートの範囲の IPv4 だけを返す", () => {
    const interfaces = {
      Ethernet: [address("192.168.68.50"), address("fe80::1", "IPv6")],
      "Wi-Fi": [address("10.0.0.7")],
      vEthernet: [address("172.20.1.2")],
      Loopback: [address("127.0.0.1", "IPv4", true)],
      Public: [address("203.0.113.5")],
      Edge: [address("172.32.0.1")],
      Missing: undefined,
    };
    expect(lanHosts(interfaces)).toEqual(["192.168.68.50", "10.0.0.7", "172.20.1.2"]);
  });
});
