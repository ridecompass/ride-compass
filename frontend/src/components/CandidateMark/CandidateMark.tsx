import palette from "@/types/generated/palette.json";

// 地点の検索で探した候補の番号の印。**地図の点と、欄の下の一覧の行・下の札の番号は同じ図形**——どの行・札がどの点かを番号と色で
// 読めるようにする。地点のピン（白い台に記号）と見分けるよう、塗りの丸に白い番号を書く。

interface CandidateMarkProps {
  /** 候補の番号（1から）。 */
  number: number;
  /** 選んでいる候補か（大きくし、色を変える）。 */
  picked: boolean;
}

export function CandidateMark({ number, picked }: CandidateMarkProps) {
  const size = picked ? 30 : 22;
  return (
    <span
      aria-hidden="true"
      className="inline-flex flex-none items-center justify-center rounded-full border-2 leading-none font-bold tabular-nums shadow-[0_1px_3px_rgba(0,0,0,0.45)]"
      style={{
        width: size,
        height: size,
        fontSize: picked ? 15 : 12,
        color: palette.semantic.pin_face,
        borderColor: palette.semantic.pin_face,
        background: picked ? palette.semantic.place_candidate_picked : palette.semantic.place_candidate,
      }}
    >
      {number}
    </span>
  );
}
