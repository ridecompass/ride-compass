// 読み上げ（Web Speech API の`speechSynthesis`と`SpeechSynthesisUtterance`。テスト環境に無いブラウザの機能）の代役。
// 読ませた言葉と言語と音量を順に記録し、読み上げを捨てた（`cancel`）回数を数える。音は出さない。
import { vi } from "vitest";

/** 読み上げを置く。外すのは`vi.unstubAllGlobals()`。 */
export function installSpeechSynthesis() {
  const spoken: { text: string; lang: string; volume: number }[] = [];
  let cancels = 0;
  class Utterance {
    lang = "";
    volume = 1;
    constructor(readonly text: string) {}
  }
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  vi.stubGlobal("speechSynthesis", {
    speak: (utterance: Utterance) =>
      spoken.push({ text: utterance.text, lang: utterance.lang, volume: utterance.volume }),
    cancel: () => {
      cancels += 1;
    },
  });
  return {
    /** 聞こえる音量で読ませた言葉（読ませた順）。 */
    texts: () => spoken.filter((utterance) => utterance.volume > 0).map((utterance) => utterance.text),
    /** 読ませた全部の音量（読ませた順。無音の前置きも含む）。 */
    volumes: () => spoken.map((utterance) => utterance.volume),
    /** 読ませた言語（読ませた順）。 */
    langs: () => spoken.map((utterance) => utterance.lang),
    /** 読み上げを捨てた回数。 */
    cancels: () => cancels,
  };
}
