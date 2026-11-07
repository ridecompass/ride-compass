import { drawSdfIcon } from "@/features/map/layers/sdfIcon";

/** 地図へ登録する名前。**登録側と参照側が同じ1つを使う**（綴りがずれると矢印が出ない）。 */
export const ROUTE_ARROW_ICON_ID = "route-arrow-icon";

const ROUTE_ARROW_SIZE_PX = 20;

/** 周回ルートの進む向きを示す、右（東）を向く矢じり（"❯"の形）。線に沿って置く記号（`symbol-placement: "line"`）は
 * 未回転のアイコンの東を線の進む向きへ回すので、東を向けて描く。 */
export function createRouteArrowIcon(): ImageData {
  const cx = ROUTE_ARROW_SIZE_PX / 2;
  const cy = ROUTE_ARROW_SIZE_PX / 2;
  const tipX = cx + 7;
  const tailX = cx - 7;
  return drawSdfIcon(ROUTE_ARROW_SIZE_PX, (ctx) => {
    ctx.beginPath();
    ctx.moveTo(tipX, cy);
    ctx.lineTo(tailX, cy - 6);
    ctx.lineTo(tailX + 3.5, cy);
    ctx.lineTo(tailX, cy + 6);
    ctx.closePath();
    ctx.fill();
  });
}
