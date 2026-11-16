import { Button } from "@/components/ui/Button/Button";
import { cardVariants } from "@/components/ui/Card/Card";
import { LocateIcon } from "@/components/ui/icons/icons";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";

interface LocateButtonProps {
  locating: boolean;
  /** 現在地を取れなかったときの文。ボタンの左に出す。 */
  error: string | null;
  onLocate: () => void;
}

/** 現在地を取り直して地図をそこへ動かすボタン。 */
export default function LocateButton({ locating, error, onLocate }: LocateButtonProps) {
  return (
    <div className="relative flex">
      <Button
        variant="mapCtrl"
        size="mapCtrl"
        onClick={onLocate}
        disabled={locating}
        aria-label="現在地に移動"
        title="現在地に移動"
        usage="現在地を取得し直して、地図をそこへ動かします。出発地は変えません。"
        className={cn(locating && "cursor-wait opacity-60")}
      >
        {locating ? "…" : <LocateIcon />}
      </Button>
      {error && (
        <p
          className={cn(
            cardVariants({ variant: "float" }),
            textVariants({ variant: "error" }),
            "pointer-events-none absolute top-0 right-full mr-2 w-max max-w-55 border-0 px-2.5 py-1.5",
          )}
        >
          {error}
        </p>
      )}
    </div>
  );
}
