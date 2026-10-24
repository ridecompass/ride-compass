import type { Page } from "@playwright/test";

/**
 * 撮った画像（PNG）の上を `shift` だけ切り落とし、下から `keyboard` の高さを板で覆った画像を、同じ寸法で組み直す。iOS の
 * Safari はキーボードが出てもレイアウトの寸法を変えず、見える範囲を欄が見えるだけずらすので、画面の中身は動かない。
 */
export async function composeKeyboard(
  page: Page,
  image: Buffer,
  { width, height }: { width: number; height: number },
  { shift, keyboard }: { shift: number; keyboard: number },
): Promise<Buffer> {
  const sheet = await page.context().newPage();
  try {
    await sheet.setViewportSize({ width, height });
    await sheet.setContent(`<!doctype html>
<body style="margin:0;width:${width}px;height:${height}px;overflow:hidden;position:relative">
  <img src="data:image/png;base64,${image.toString("base64")}"
    style="position:absolute;left:0;top:${-shift}px;width:${width}px;height:${height}px">
  <div style="position:absolute;left:0;right:0;bottom:0;height:${keyboard}px;background:#9ca3af;color:#fff;
    display:flex;align-items:center;justify-content:center;font:20px sans-serif">キーボード（見立て）</div>
</body>`);
    await sheet.locator("img").evaluate((img: HTMLImageElement) => img.decode());
    return await sheet.screenshot();
  } finally {
    await sheet.close();
  }
}
