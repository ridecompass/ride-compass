import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { translate } from "@/i18n/config";
import { vocabulary } from "@/types/generated/vocabulary";

import WarningBadgeList, { type WarningBadgeItem } from "./WarningBadge";

const display = (source: WarningBadgeItem["source"], level: WarningBadgeItem["level"]) =>
  vocabulary.warningBadge[source].find((entry) => entry.level === level)!;

const summaryLabel = (summary: string) => translate("conditions.warning.summaryLabel", { summary });
const count = (label: string, n: number) => translate("conditions.warning.count", { label, count: String(n) });
const retry = { name: translate("conditions.warning.retry") };

const item = (id: string, source: WarningBadgeItem["source"], level: WarningBadgeItem["level"], title?: string) => ({
  id,
  label: `${id}の名前`,
  source,
  level,
  title,
});

describe("WarningBadgeList", () => {
  it("警告も失敗も無ければ何も出さない", () => {
    const { container } = render(<WarningBadgeList items={[]} failures={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ["1件なら、その段階の出所の呼び名", [item("a", "wbgt", "warning")], display("wbgt", "warning").label, "wbgt"],
    [
      "複数なら、最も重い段階の呼び名に件数を添える（同じ重さなら先の方）",
      [item("a", "jma", "advisory"), item("b", "flood", "warning"), item("c", "jma", "warning")],
      count(display("flood", "warning").label, 3),
      "flood",
    ],
  ] as const)("文字を出さず最も重い段階の色のアイコン1つにし、名前に出す: %s", (_, items, summary, topSource) => {
    render(<WarningBadgeList items={[...items]} failures={[]} />);
    const button = screen.getByRole("button", { name: summaryLabel(summary) });
    expect(button).toHaveTextContent(/^$/);
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button).toHaveStyle({ color: display(topSource, "warning").color });
  });

  it("押すと全件を、補足と一緒に出す", async () => {
    render(
      <WarningBadgeList
        items={[item("a", "jma", "warning", "付随事項: 土砂災害"), item("b", "wbgt", "advisory")]}
        failures={[]}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: summaryLabel(count(display("jma", "warning").label, 2)) }),
    );
    const list = await screen.findByRole("list", { name: translate("conditions.warning.details") });
    const entries = within(list).getAllByRole("listitem");
    expect(entries.map((entry) => entry.textContent)).toEqual(["aの名前付随事項: 土砂災害", "bの名前"]);
  });

  it("取得に失敗した出所があれば、文字の無い「未取得」の印を出し、押すと出所ごとの理由を出す（警告なしと読ませない）", async () => {
    render(
      <WarningBadgeList
        items={[]}
        failures={[
          { id: "jma", label: "警報・注意報", detail: "[通信エラー]", effect: "警報のバッジは出ません。" },
          { id: "flood", label: "河川氾濫予報", detail: "混雑しています", effect: "予報のバッジは出ません。" },
        ]}
      />,
    );
    const labels = ["警報・注意報", "河川氾濫予報"].join(translate("common.listSeparator"));
    const mark = screen.getByRole("button", { name: translate("conditions.warning.notFetchedLabel", { labels }) });
    expect(mark).toHaveTextContent(/^$/);
    expect(mark.querySelector("svg")).not.toBeNull();
    await userEvent.click(mark);
    expect(await screen.findByText(translate("conditions.warning.notFetched", { labels }))).toBeInTheDocument();
    expect(screen.getByText("警報・注意報: [通信エラー]")).toBeInTheDocument();
    expect(screen.getByText("警報のバッジは出ません。")).toBeInTheDocument();
    expect(screen.getByText("河川氾濫予報: 混雑しています")).toBeInTheDocument();
    expect(screen.queryByRole("button", retry)).not.toBeInTheDocument();
  });

  it("取り直せる出所には、何が起きているかと再試行を出す", async () => {
    const retries: string[] = [];
    render(
      <WarningBadgeList
        items={[]}
        failures={[
          { id: "catalog", label: "軸一覧", effect: "地図の道路は出ません。", onRetry: () => retries.push("catalog") },
        ]}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: translate("conditions.warning.notFetchedLabel", { labels: "軸一覧" }) }),
    );
    expect(await screen.findByText("地図の道路は出ません。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", retry));
    expect(retries).toEqual(["catalog"]);
  });
});
