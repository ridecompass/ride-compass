import { expect, test } from "@playwright/test";
import { INTRO_CLOSED, installApiMocks, seedStoredState } from "./fixtures";
import { installPageHelpers } from "./pageHelpers";
import { WIDTHS, openApp } from "./states";

// アイコンだけの部品に重ねて出た説明（ツールチップ）が、その下にある部品への押し操作を受け止めないこと（パターン4 観点1: 押せる）。
// 説明は押したあともマウスが重なったままなら出るので、出ている間に近くの部品を押すと、受け止めればその押し操作が消える。
// 押す点で何が当たるかはブラウザの当たり判定で決まり、単体テストでは見られない。

test("使い方の説明のツールチップが出ていても、その面の上を押すと下にある物へ届く", async ({ page }) => {
  await page.setViewportSize(WIDTHS.desktop);
  await page.addInitScript(installPageHelpers);
  await installApiMocks(page);
  await seedStoredState(page, INTRO_CLOSED);
  await openApp(page);

  await page.getByRole("button", { name: "走行モード" }).hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  const box = (await tooltip.boundingBox())!;
  const hitInsideTooltip = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-radix-popper-content-wrapper]") != null,
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  expect(hitInsideTooltip).toBe(false);
});
