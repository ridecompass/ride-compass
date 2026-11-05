import type { CaptureScript } from "../context";

// 脚本の例: モックの費用の軸の一覧を道のストレスの軸3つに、画面の設定を走行モデルの較正値に替えて、ルート設定の負担の倍率と想定速度の
// 説明を撮る（モックの応答）。
//   node frontend/scripts/capture.mjs --script frontend/capture/examples/cost-axes.ts

const script: CaptureScript = async ({ page, fixtures, costAxes, open, shot }) => {
  const catalog = costAxes.costAxisCatalog(
    ...["坂", "路面", "交通"].map((label, index) =>
      costAxes.costAxisEntry(`axis_${index}`, { ledger: "burden", label }),
    ),
  );
  const config = fixtures.clientConfigFixture({
    client_tuning: {
      "speed.mass_kg": 80,
      "speed.cda_m2": 0.32,
      "speed.max_descent_kmh": 50,
      "speed.walking_kmh": 6,
    },
  });
  await open({
    routes: async (p) => {
      await p.route("**/api/cost-axes", (route) => route.fulfill({ json: catalog }));
      await p.route("**/api/client-config*", (route) => route.fulfill({ json: config }));
    },
  });
  const sheet = await fixtures.openMobileSheet(page, "ルート設定");
  await sheet.getByRole("tab", { name: "負担" }).click();
  await shot("ルート設定の負担の倍率", sheet);
  await page.getByRole("button", { name: "ルート設定", exact: true }).click();
  await page.getByRole("button", { name: /^想定速度: / }).click();
  await page.getByRole("button", { name: "想定速度の説明" }).click();
  await shot("想定速度の説明");
};

export default script;
