#!/usr/bin/env python3
"""Marp の原稿から、発表用のHTMLを1コマンドで書き出す。

  python3 present.py example/deck.md --minutes 20 --open

- 原稿の隣に <名前>.present.html を作る。画像は原稿からの相対パスで読むので、置き場所は原稿の隣になる
- 操作画面：書き出したHTMLを ?view=presenter 付きで開いたもの（--open はこれを開く）。普通の窓のまま、
  残り時間・進み具合のバー・いまと前後のページを出す。中身は presenter-view.js で、HTMLの末尾へ埋め込む
- 投影画面：操作画面の「投影」ボタンで別の窓に出す。全画面にするのはこちら
- URL をそのまま開くと、最初は全ページの一覧になる
- テーマは --theme で CSS を渡すか、原稿の theme: に書いた名前の CSS を原稿の隣か themes/ から探す。
  見つからなければ Marp の組み込みテーマとして扱う
- 原稿の隣に present-parts.txt（「パート名: そのパートの先頭スライドの見出し」を3〜4行）を置くと、
  操作画面の進み具合のバーがそのパートで区切られる。無ければバーは1本
"""
import argparse
import hashlib
import html as html_mod
import json
import mimetypes
import re
import shutil
import subprocess
import sys
import webbrowser
from pathlib import Path
from urllib.parse import unquote

HERE = Path(__file__).resolve().parent
BUILTIN_THEMES = {"default", "gaia", "uncover"}
ASSETS_DIR = "present-assets"

# 投影画面と一覧を、操作画面と同じ白ベースにする（Marp 標準は黒）。淡いグレーの地・白い面に柔らかい影・水色の差し色。
# 下のツールバーのボタンの絵は Marp が白で描いているので、反転して濃い色にする
LIGHT = (
    "<style>"
    'body[data-bespoke-view=""],body[data-bespoke-view=overview]{background:#f1f4f6}'
    # 全画面の投影では、16:9 と画面の比の差で出る上下（左右）の余りを黒にする。淡いグレーのままだとスライドの縁が白く浮く
    'html:fullscreen,html:fullscreen body[data-bespoke-view=""]{background:#000}'
    ':is(body[data-bespoke-view=""],body[data-bespoke-view=next]) .bespoke-marp-parent>.bespoke-marp-osc{'
    "background:#fff;color:#14262f;border-radius:14px;padding:10px 14px;"
    "box-shadow:0 1px 2px rgba(20,50,70,.08),0 10px 28px rgba(20,50,70,.14);"
    'font-family:"Inter","Hiragino Sans",sans-serif;font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}'
    ':is(body[data-bespoke-view=""],body[data-bespoke-view=next]) .bespoke-marp-parent>.bespoke-marp-osc>button{filter:invert(1);opacity:.62}'
    ':is(body[data-bespoke-view=""],body[data-bespoke-view=next]) .bespoke-marp-parent>.bespoke-marp-osc>button:hover{opacity:.9}'
    ':is(body[data-bespoke-view=""],body[data-bespoke-view=next]) .bespoke-marp-parent>.bespoke-marp-osc>span{opacity:1;color:#6d808b}'
    'body[data-bespoke-view=""] .bespoke-progress-parent{background:rgba(20,50,70,.10)}'
    'body[data-bespoke-view=""] .bespoke-progress-parent .bespoke-progress-bar{background:linear-gradient(90deg,#0aa5c9,#35d0ea)}'
    "body[data-bespoke-view=overview] .bespoke-marp-overview-header{background:rgba(255,255,255,.82);backdrop-filter:blur(10px);"
    "box-shadow:0 1px 2px rgba(20,50,70,.06),0 6px 20px rgba(20,50,70,.08)}"
    "body[data-bespoke-view=overview] button.bespoke-marp-overview-close{filter:invert(1);opacity:.55}"
    # 影は filter ではなく box-shadow で付け、ポインタを乗せたときに浮かせる動きも付けない。filter の影と transform の動きは、
    # スクロール中にポインタの下を通るページごとに描き直しが走り、大きな画面の一覧がもたつく
    "body[data-bespoke-view=overview] .bespoke-marp-parent svg.bespoke-marp-slide{scroll-margin-top:100px;background-image:none;margin:0;padding:0;"
    "filter:none!important;box-shadow:0 1px 2px rgba(20,50,70,.10),0 8px 20px rgba(20,50,70,.12);"
    "outline:0 solid transparent}"
    "body[data-bespoke-view=overview] .bespoke-marp-parent svg.bespoke-marp-slide:hover{outline:2px solid rgba(10,165,201,.45);outline-offset:3px}"
    "body[data-bespoke-view=overview] .bespoke-marp-parent svg.bespoke-marp-slide.bespoke-marp-active{outline:3px solid #0aa5c9;outline-offset:4px}"
    ".bespoke-marp-overview{background:rgba(241,244,246,.75)}"
    ".bespoke-marp-overview iframe{background:#f1f4f6}"
    "</style>"
    # 一覧を開いた直後、選んでいるページを画面の中央へ寄せる。寄せるのは、まだスクロールしていないときだけ
    # （画像の読み込みを待ってから寄せると、読み込み中に探し始めた位置から引き戻してしまう）
    "<script>if(new URLSearchParams(location.search).get('view')==='overview'){let moved=false;"
    "for(const t of ['wheel','touchmove','keydown','mousedown'])addEventListener(t,()=>{moved=true},{once:true,passive:true});"
    "const go=()=>{if(!moved)document.querySelector('svg.bespoke-marp-active')?.scrollIntoView({block:'center'})};"
    "addEventListener('DOMContentLoaded',()=>setTimeout(go,60))}</script>"
)


def externalize(html: str, base: Path) -> tuple[str, list[str]]:
    """フォルダを丸ごと静的ホスティングへ置けるように、運びにくい画像を present-assets/ へ写して参照を付け替える。

    対象は、原稿のフォルダの外（../ で始まる参照）を指す画像、英数字以外を含むファイル名の画像、CSS の url() で読む画像。
    写しの名前は中身のハッシュなので、画像を差し替えれば名前も変わり、古い写しをキャッシュから読まない。
    画像を base64 でHTMLへ埋め込まないのは、デッキが数十MBに膨らみ、一覧と操作画面が同じ文書を読み直すたびに重くなるため。
    CSS の url() で読む画像には head に preload の link を足す（先読みと、src・href だけを拾って運ぶビューアへの手当てを兼ねる）。
    返り値は（書き換えたHTML, preload する写しのパス一覧）。"""
    out = base / ASSETS_DIR
    if out.is_dir():
        for old in out.iterdir():
            if old.is_file():
                old.unlink()
    cache: dict[str, str | None] = {}
    css_refs: list[str] = []

    def copy(ref: str) -> str | None:
        if ref not in cache:
            f = (base / unquote(ref.split("#")[0].split("?")[0])).resolve()
            if f.is_file() and mimetypes.guess_type(f.name)[0]:
                name = hashlib.sha256(f.read_bytes()).hexdigest()[:16] + f.suffix.lower()
                out.mkdir(exist_ok=True)
                shutil.copyfile(f, out / name)
                cache[ref] = f"{ASSETS_DIR}/{name}"
            else:
                cache[ref] = None
        return cache[ref]

    def local(ref: str) -> bool:
        return not re.match(r"(?i)(https?:|data:|blob:|#|//|/)", ref)

    def attr(m: re.Match) -> str:
        ref = html_mod.unescape(m.group(2))
        if local(ref) and (".." in ref.split("/") or not re.fullmatch(r"[A-Za-z0-9._/-]+", ref)):
            new = copy(ref)
            if new:
                return f'{m.group(1)}"{new}"'
        return m.group(0)

    def css(m: re.Match) -> str:
        ref = html_mod.unescape(m.group(2)).strip("\"'")
        if local(ref):
            new = copy(ref)
            if new:
                if new not in css_refs:
                    css_refs.append(new)
                return f"url({m.group(1)}{new}{m.group(1)})"
        return m.group(0)

    html = re.sub(r'(\bsrc=)"([^"]+)"', attr, html)
    return re.sub(r"url\((&quot;|[\"']?)(.+?)\1\)", css, html), css_refs


def read_parts(md: Path) -> list[dict] | None:
    """原稿の隣の present-parts.txt（「パート名: 先頭スライドの見出し」を3〜4行）を読む。無ければ空。

    見出しが原稿に見つからない行があれば None を返して止める（気づかないままバーの区切りが減るのを防ぐ）。"""
    f = md.with_name("present-parts.txt")
    if not f.is_file():
        return []
    squash = lambda t: re.sub(r"<[^>]+>|\s+", "", t)
    heads = [squash(m) for m in re.findall(r"^#{1,2}\s+(.+)$", md.read_text(encoding="utf-8"), re.M)]
    parts, bad = [], []
    for line in f.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, sep, head = line.partition(":")
        if not sep:
            name, sep, head = line.partition("：")
        name, head = name.strip(), head.strip()
        if not name or not head or not any(h.startswith(squash(head)) for h in heads):
            bad.append(line)
        parts.append({"name": name, "head": head})
    if bad:
        print("NG present-parts.txt の次の行は、先頭スライドの見出しが原稿に見つかりません:", file=sys.stderr)
        for b in bad:
            print(f"   {b}", file=sys.stderr)
        return None
    return parts


def find_theme(md: Path, given: str | None) -> tuple[Path | None, str]:
    """使うテーマの CSS を決める。返り値は（CSS のパス, 説明）。組み込みテーマなら CSS は None。"""
    if given:
        p = Path(given).expanduser().resolve()
        return (p, str(p)) if p.is_file() else (None, "")
    m = re.search(r"^theme:\s*([\w-]+)", md.read_text(encoding="utf-8"), re.M)
    name = m.group(1) if m else "default"
    for d in (md.parent, md.parent / "themes", HERE / "themes"):
        p = d / f"{name}.css"
        if p.is_file():
            return p, str(p)
    return None, f"{name}（Marp の組み込みテーマ）" if name in BUILTIN_THEMES else ""


def marp_command() -> list[str] | None:
    if shutil.which("marp"):
        return ["marp"]
    if shutil.which("npx"):
        return ["npx", "--yes", "@marp-team/marp-cli@4"]
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Marp の原稿から発表用HTMLを書き出す")
    ap.add_argument("deck", help="原稿（.md）")
    ap.add_argument("--minutes", type=int, default=30, help="持ち時間の初期値（分）。操作画面でも変えられる")
    ap.add_argument("--theme", help="テーマの CSS ファイル。省くと原稿の theme: から探す")
    ap.add_argument("--chapter-class", default="lead top crosshead",
                    help="章の切れ目として扱うスライドのクラス（空白区切りで複数可）。既定は lead top crosshead")
    ap.add_argument("--open", action="store_true", help="書き出したあと既定のブラウザで操作画面を開く")
    a = ap.parse_args()

    md = Path(a.deck).resolve()
    if not md.is_file():
        print(f"NG 原稿が見つかりません: {md}", file=sys.stderr)
        return 1
    theme, theme_label = find_theme(md, a.theme)
    if not theme_label:
        print("NG テーマの CSS が見つかりません。--theme で渡すか、原稿の隣か themes/ に <名前>.css を置いてください",
              file=sys.stderr)
        return 1
    marp = marp_command()
    if not marp:
        print("NG Marp CLI が見つかりません。npm install -g @marp-team/marp-cli で入れてください", file=sys.stderr)
        return 1

    out = md.with_suffix(".present.html")
    cmd = [*marp, "--no-stdin", "--html", "--allow-local-files", str(md), "-o", str(out)]
    if theme:
        cmd[len(marp):len(marp)] = ["--theme", str(theme)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not out.is_file():
        print(r.stdout + r.stderr, file=sys.stderr)
        print("NG marp の書き出しに失敗しました", file=sys.stderr)
        return 1

    html, preload = externalize(out.read_text(encoding="utf-8"), md.parent)
    parts = read_parts(md)
    if parts is None:
        return 1
    js = (HERE / "presenter-view.js").read_text(encoding="utf-8").replace("</script", "<\\/script")
    parts_json = json.dumps(parts, ensure_ascii=False).replace("</", "<\\/")
    tag = (
        f'<script id="presenter-view">document.body.dataset.pvMinutes="{a.minutes}";'
        f"document.body.dataset.pvParts={json.dumps(parts_json, ensure_ascii=False)};"
        f"document.body.dataset.pvChapterClass={json.dumps(a.chapter_class)};\n{js}</script>"
    )
    boot = (
        # URL をそのまま開いたら、最初は一覧（縦スクロールの3列）にする。1枚表示（Marp 標準）は投影画面の窓だけで使う。
        # 投影画面の窓は、操作画面と一覧の「投影」ボタンが pv-audience という名前で開く
        '<script>(function(){var q=new URLSearchParams(location.search);'
        'if(!q.has("view")&&!/^pv-audience/.test(window.name)){q.set("view","overview");'
        'location.replace(location.pathname+"?"+q+location.hash)}})()</script>'
        # 操作画面は、部品がそろうまで隠す（読み込み直後に標準の黒い画面や組み替えが見えないようにする）。
        # 解くのは presenter-view.js（html に pv-ready を付ける）
        '<script>if(new URLSearchParams(location.search).get("view")==="presenter")'
        'document.documentElement.classList.add("pv-boot")</script>'
        "<style>html.pv-boot{background:#f1f4f6}html.pv-boot body{opacity:0}"
        "html.pv-boot.pv-ready body{opacity:1;transition:opacity .18s ease}"
        # どの画面も、Marp の部品（bespoke）が body に data-bespoke-view を付けるまでは隠す。
        # 付ける前は全ページが縦に積まれた素の並びで描かれ、開いた瞬間にそれが一瞬見える
        "html{background:#f1f4f6}body:not([data-bespoke-view]){visibility:hidden}"
        # 一覧：Marp 標準は幅240pxの小さな升を詰めるだけで中身が読めないので、横3列で窓の幅いっぱいに並べる。
        # 細い窓では2列・1列に落とす
        "body[data-bespoke-view=overview] .bespoke-marp-parent{grid-template-columns:repeat(3,minmax(0,1fr));"
        "gap:36px 32px;justify-content:stretch;max-width:1800px;margin:0 auto;padding-left:40px;padding-right:40px}"
        "@media (max-width:900px){body[data-bespoke-view=overview] .bespoke-marp-parent{grid-template-columns:repeat(2,minmax(0,1fr));gap:24px 20px;padding-left:20px;padding-right:20px}}"
        "@media (max-width:560px){body[data-bespoke-view=overview] .bespoke-marp-parent{grid-template-columns:minmax(0,1fr);padding-left:16px;padding-right:16px}}"
        "</style>"
        + LIGHT
        + "".join(f'<link rel="preload" as="image" href="{p}">' for p in preload)
    )
    h = html.index("</head>")
    html = html[:h] + boot + html[h:]
    i = html.rindex("</body>")
    out.write_text(html[:i] + tag + html[i:], encoding="utf-8")

    pages = len(re.findall(r"<svg[^>]*data-marpit-svg", html))
    url = f"{out.as_uri()}?view=presenter"
    print(f"OK {out}（{pages}ページ、持ち時間 {a.minutes}分、テーマ {theme_label}）")
    print(f"   操作画面：{url} を Chrome で開く。投影画面は操作画面の「投影」ボタンから")
    if a.open:
        webbrowser.open(url)
    return 0


if __name__ == "__main__":
    sys.exit(main())
