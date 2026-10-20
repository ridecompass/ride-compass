"""開発機の画面を本番のデータで開くときの、開発機の backend を起こす（docs/architecture/setup.md「開発機の画面を本番のデータで開く」）。

本番のデータで開く画面は、地図の下地だけを開発機の backend から取る。下地のスタイルは中のタイルの住所を
`BASEMAP_PUBLIC_BASE_URL` から組むので、同じ Wi-Fi の端末からも届くよう、開発機の LAN の住所の frontend を指させ、
その住所を許す相手に足して起こす。LAN の住所は `RC_LAN_HOST` で上書きできる（外へ出る口が複数あって違う方を引くとき）。
"""

import os
import socket

import uvicorn

#: 開発機の frontend の番号（`next dev` の既定）。
FRONTEND_PORT = 3000


def lan_host() -> str:
    """外へ出る口の IPv4 の住所。UDP の connect は宛先を決めるだけで何も送らない（宛先は文書用の住所 TEST-NET-1）。"""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        probe.connect(("192.0.2.1", 80))
        return probe.getsockname()[0]


def main() -> None:
    frontend = f"http://{os.environ.get('RC_LAN_HOST') or lan_host()}:{FRONTEND_PORT}"
    os.environ["BASEMAP_PUBLIC_BASE_URL"] = f"{frontend}/api/basemap"
    os.environ["CORS_ALLOWED_ORIGINS"] = f"http://localhost:{FRONTEND_PORT},{frontend}"
    print(f"本番のデータで開く画面: {frontend}（この PC では http://localhost:{FRONTEND_PORT} でも開ける）", flush=True)
    uvicorn.run("app.main:app", app_dir="backend", host="0.0.0.0", port=8000)


if __name__ == "__main__":
    main()
