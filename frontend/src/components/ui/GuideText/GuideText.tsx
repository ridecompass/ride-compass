import { Fragment, type ReactNode } from "react";
import { Parser, jaModel } from "budoux";
import { cn } from "@/lib/cn";
import { ButtonLabel, buttonVariants } from "../Button/Button";
import { RouteDiffIcon, type MapIconComponent } from "../icons/icons";
import { GenerateRoutesIcon, RulerIcon, SaveConditionsIcon } from "../icons/lucideIcons";

// 案内の文の中で、アイコンだけのパネルの操作を「名前」で指した所を、そのボタンと同じ見た目のアイコンにして描く
// （docs/modules/frontend/frontend-design-system.md 5-1）。名前はボタンの`aria-label`と同じにする——
// 読み上げと吹き出しには、ボタンと同じ名前を残す。ボタンがアイコンに文字を添えるもの（`label`）は、印にも同じ文字をボタンと同じ決まりで添える。
const BUTTON_MARKS = new Map<string, { Icon: MapIconComponent; variant: "primary" | "secondary"; label?: string }>([
  ["ルート生成", { Icon: GenerateRoutesIcon, variant: "primary", label: "生成" }],
  ["差分を見る", { Icon: RouteDiffIcon, variant: "secondary" }],
  ["距離を決める", { Icon: RulerIcon, variant: "secondary" }],
  ["いまの設定を保存", { Icon: SaveConditionsIcon, variant: "secondary" }],
]);

const QUOTED_NAME = /「([^「」]+)」/g;

/** 説明の文の箇条書きの行の頭。 */
const LIST_MARK = "・";

/**
 * 文を言葉のまとまりに分ける。CSS の`word-break: auto-phrase`は iPhone の Safari と Firefox が対応しないので、Chrome がその中で使う
 * BudouX で分け、まとまりの間にだけ折り返してよい印（`wbr`）を置く。
 */
const PHRASES = new Parser(jaModel);

/** 地の文を、言葉のまとまりの間でだけ折り返せる形にする。 */
function phrased(text: string, key: number): ReactNode {
  return PHRASES.parse(text).map((phrase, index) => (
    <Fragment key={`${key}-${index}`}>
      {index > 0 && <wbr />}
      {phrase}
    </Fragment>
  ));
}

/**
 * 1行の文。ここに無い名前（「ルート設定」等）は、かぎ括弧ごと文字のまま残す。字の間では折らず（`break-keep`）、言葉のまとまりの間で
 * 折り返す。まとまりが行より長いときだけ、どこででも折る（`wrap-anywhere`。はみ出さないように）。
 */
function MarkedLine({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let rest = 0;
  for (const match of text.matchAll(QUOTED_NAME)) {
    const name = match[1];
    const mark = BUTTON_MARKS.get(name);
    if (!mark) continue;
    parts.push(phrased(text.slice(rest, match.index), rest));
    parts.push(
      <span
        key={match.index}
        title={name}
        className={cn(
          buttonVariants({ variant: mark.variant, size: "bare" }),
          "mx-0.5 cursor-default px-1 py-0.5 align-middle",
        )}
      >
        <mark.Icon size={14} />
        {mark.label && <ButtonLabel>{mark.label}</ButtonLabel>}
        <span className="sr-only">{name}</span>
      </span>,
    );
    rest = match.index + match[0].length;
  }
  parts.push(phrased(text.slice(rest), rest));
  return <span className="break-keep wrap-anywhere">{parts}</span>;
}

/**
 * 説明・案内の文。改行で段落を分け、「・」で始まる行を箇条書きにする（スマホで長い説明を、1文ずつ拾って読めるように）。
 * 改行の無い文は、囲む文の中にそのまま流す。段落も箇条書きも`span`で組み、`p`の中に置ける（`usage`の属性・backendとDBが配る
 * 文も同じ書き方で描けるように、書式は文字で持つ）。
 */
export function GuideText({ text }: { text: string }) {
  const lines = text.split("\n");
  if (lines.length === 1) return <MarkedLine text={text} />;
  // 続く「・」の行を1つの箇条書きにまとめる。
  const blocks: { start: number; items: string[] | null; line: string }[] = [];
  lines.forEach((line, start) => {
    const list = line.startsWith(LIST_MARK) ? blocks.at(-1)?.items : undefined;
    if (list) list.push(line);
    else blocks.push({ start, line, items: line.startsWith(LIST_MARK) ? [line] : null });
  });
  return (
    <>
      {blocks.map(({ start, line, items }) =>
        items === null ? (
          <span key={start} className="block">
            <MarkedLine text={line} />
          </span>
        ) : (
          <span key={start} role="list" className="block">
            {items.map((item, index) => (
              // 「・」と文を別の箱に並べ、折り返した2行目を文の頭（「・」の次の字）の真下から始める。字下げで寄せると、
              // 「・」の字の幅が1字分とずれたとき2行目が文の頭とそろわない。
              <span key={index} role="listitem" className="flex">
                <span className="shrink-0">{LIST_MARK}</span>
                <span className="min-w-0">
                  <MarkedLine text={item.slice(LIST_MARK.length)} />
                </span>
              </span>
            ))}
          </span>
        ),
      )}
    </>
  );
}
