"use client";

// ルートのレイアウトごと置き換わり`globals.css`を読まないので、トークンもTailwindのクラスも効かない。見た目は直値で書く。
export default function GlobalError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="ja">
      <body>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            gap: "1rem",
            padding: "1rem",
            textAlign: "center",
          }}
        >
          <h2>アプリの読み込み中にエラーが発生しました</h2>
          <p style={{ color: "#666" }}>ページを再読み込みしてください。</p>
          <button onClick={() => retry()} style={{ padding: "0.5rem 1rem" }}>
            再試行
          </button>
        </div>
      </body>
    </html>
  );
}
