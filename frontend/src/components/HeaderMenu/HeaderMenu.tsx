"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover/Popover";
import { Button, buttonVariants } from "@/components/ui/Button/Button";
import { LogIcon } from "@/components/ui/icons/icons";
import { CopyIcon, HelpIcon, IntroIcon, MenuIcon, RedrawMapIcon, RideLogIcon } from "@/components/ui/icons/lucideIcons";
import { textVariants } from "@/components/ui/Text/Text";
import { Toggle } from "@/components/ui/Toggle/Toggle";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { cn } from "@/lib/cn";
import { getQueryClient } from "@/lib/queryClient";
import { readRideMetrics } from "@/lib/rideMetrics";
import { formatRideMetrics } from "@/lib/rideMetricsFormat";
import { APP_NAME } from "@/lib/screenNames";
import { frontendVersionQuery } from "@/services/versionApi";

interface HeaderMenuProps {
  /** デバッグログ項目自体の表示可否（デバッグモードのON/OFFは/adminで切り替える）。 */
  debugEnabled: boolean;
  debugConsoleOpen: boolean;
  onToggleDebugConsole: () => void;
  /** 説明を見る状態に入る（次に押した部品の使い方を出す）。 */
  onStartUsageGuide: () => void;
  /** 初めて開いたときに出す案内を、もう一度出す。 */
  onShowIntro: () => void;
  /** 押した人の地図だけを描き直す（ページを読み込み直すと生成したルートが消える）。 */
  onRedrawMap: () => void;
}

// ヘッダーの狭い幅に個別のボタンを並べず、常時出すのは1個のメニューアイコンにして、項目は押して開く中に置く。
export default function HeaderMenu({
  debugEnabled,
  debugConsoleOpen,
  onToggleDebugConsole,
  onStartUsageGuide,
  onShowIntro,
  onRedrawMap,
}: HeaderMenuProps) {
  const [open, setOpen] = useState(false);
  // メニューが閉じきってから説明を見る状態に入るか。
  const afterClose = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { copied, error: copyError, copy } = useCopyToClipboard();
  // 直近の走行の記録（`lib/rideMetrics.ts`）。メニューを開いたときに読む（走り終えてから開いて写す）。
  const rideMetrics = open ? readRideMetrics() : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild ref={trigger}>
        <Button
          variant="ghost"
          size="sm"
          aria-label="メニュー"
          className="shrink-0"
          usage="使い方の説明・地図の描き直しなどを開きます。"
        >
          <MenuIcon size={15} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        layer="header"
        className="flex min-w-56 max-w-[min(calc(100vw-2*var(--space-3)),var(--radix-popover-content-available-width))] flex-col gap-1 p-1.5"
        side="bottom"
        align="end"
        // メニューが閉じきり、フォーカスを開くボタンへ戻してから入る。先に入ると、閉じる動きの間に部品を押して出た
        // 説明の面が、あとから戻るフォーカスを外への移りと読んで閉じる。
        onCloseAutoFocus={(event) => {
          if (!afterClose.current) return;
          afterClose.current = false;
          event.preventDefault();
          trigger.current?.focus();
          onStartUsageGuide();
        }}
      >
        <AppIdentity />
        {/* メニューを閉じてから入る（開いたままだと、次に押す部品の上にメニューが残る）。 */}
        <Button
          variant="menu"
          size="sm"
          usage="押した所の使い方を表示するモードに切り替えます。"
          onClick={() => {
            afterClose.current = true;
            setOpen(false);
          }}
        >
          <HelpIcon size={15} />
          使い方を見る
        </Button>
        <Button
          variant="menu"
          size="sm"
          usage="初めて開いたときに出る、使い始めの案内をもう一度出します。"
          onClick={() => {
            onShowIntro();
            setOpen(false);
          }}
        >
          <IntroIcon size={15} />
          初回の案内をもう一度見る
        </Button>
        <Link
          href="/ride-log"
          className={buttonVariants({ variant: "menu", size: "sm" })}
          data-usage="Google でログインして残した自分の走りを、一覧と地図で見返して消せるページを開きます。"
        >
          <RideLogIcon size={15} />
          走行ログ
        </Link>
        {rideMetrics !== null && (
          // 写したことはメニューの中の名前で見せるので、押しても閉じない。
          <Button
            variant="menu"
            size="sm"
            usage="直近の走行の記録[電池・位置・地図の描き直しの回数などを1分ごとに集計したもの]を、クリップボードにコピーします。"
            onClick={() => copy(formatRideMetrics(rideMetrics))}
          >
            <CopyIcon size={15} />
            {copied ? "走行の記録をコピーしました" : "走行の記録をコピー"}
          </Button>
        )}
        {copyError !== null && <p className={textVariants({ variant: "error" })}>{copyError}</p>}
        {debugEnabled && (
          <Toggle
            variant="menu"
            onClick={onToggleDebugConsole}
            pressed={debugConsoleOpen}
            usage="開発者向けのログの窓を、表示するか隠すかを切り替えます。"
          >
            <LogIcon size={15} />
            {debugConsoleOpen ? "デバッグログを隠す" : "デバッグログを表示"}
          </Toggle>
        )}
        {/* 描き直しは表示が欠けたときの直しで、ふだんの操作と分けて下に置く。 */}
        <hr className="my-0.5 border-[var(--color-border)]" />
        <Button
          variant="menu"
          size="sm"
          usage="地図の表示が欠けたときに、地図だけを描き直します。作ったルートは消えません。"
          onClick={() => {
            onRedrawMap();
            setOpen(false);
          }}
        >
          <RedrawMapIcon size={15} />
          地図を描き直す
        </Button>
      </PopoverContent>
    </Popover>
  );
}

// 版はコミットの頭8文字で出す（デプロイの記録・Pull Requestの画面と同じ長さ）。
const SHORT_COMMIT_LENGTH = 8;

/** メニューの頭の、アプリの名前と動いている版。版はメニューを開いたときに取る（このメニューは開いている間だけ中身を描く）。 */
function AppIdentity() {
  const { data, error } = useQuery(frontendVersionQuery, getQueryClient());

  return (
    <div className="flex flex-col px-2 pt-1 pb-1.5">
      <p className={cn(textVariants({ variant: "heading" }), "m-0")}>{APP_NAME}</p>
      {error && <p className={cn(textVariants({ variant: "error" }), "m-0")}>{error.message}</p>}
      {!data && !error && <p className={cn(textVariants({ variant: "hint" }), "m-0")}>バージョンを読み込み中…</p>}
      {data &&
        (data.commit === null ? (
          <p className={cn(textVariants({ variant: "hint" }), "m-0")}>
            手元で動いているバージョンです[本番のバージョンではありません]。
          </p>
        ) : (
          <p className={cn(textVariants({ variant: "hint" }), "m-0")}>
            バージョン{" "}
            <span className={textVariants({ variant: "code" })}>{data.commit.slice(0, SHORT_COMMIT_LENGTH)}</span>
          </p>
        ))}
    </div>
  );
}
