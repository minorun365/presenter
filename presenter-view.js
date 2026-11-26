/* 発表者の操作画面。marp --html が出すHTMLの発表者ビュー（?view=presenter）を、目的から組み直す。
   present.py がこのファイルを書き出したHTMLの末尾へ埋め込む。

   ねらい（PowerPoint の発表者ツールの形を引き継がない）：
   - 全画面にしない普通の窓。横長でも正方形でも、細くしてオンライン会議の画面の横へ置いても、同じ並びで読める
   - 縦に3段：上のパネル（必ず2段。1段目＝残り時間と操作、2段目＝進み具合のバー）→ 今のページ（左右に送りボタン）→ 前後のページの帯
   - すき間を埋め切らず、余白を残す。送りボタンも大きくしすぎない
   - 今のページを主役の大きさにする。前後のページは下の帯に、左から まえ … いま … つぎ の順で複数枚（矢印キーと同じ向き）
   - 入口はこの操作画面。投影画面（全画面にする側）は、ここの「投影」ボタンから別の窓で出す
   - 持ち時間は残り時間の数字そのものに打ち込む。開始前は「30:00」の分が入力欄で、開始すると同じ数字が減り始める。
     開始・リセットは数字のすぐ右にまとめ、出たり消えたりする物を右端に寄せる（ほかのボタンを動かさない）
   - 時間とページを別々のバーにせず、1本のバーに重ねる。バーの塗りがページの進み、針が時間の進み。
     針が塗りより先にいれば遅れ、後ろにいれば先行。区切るのは、原稿の隣の present-parts.txt に書いた3〜4つのパートだけで、
     下に薄い文字でパート名を出す（中扉ごとには区切らない）。バーの上には、いまいる章の中扉の文言を出す
   - 表示は足さない。キーの案内・重複した数字・終了時刻のような、無くても困らないものは置かない
   状態は localStorage に持つので、窓を読み込み直しても続きから数える。 */
(() => {
  /* 画面の行き来：一覧（?view=overview。URL を開いた最初の画面）⇄ 操作画面（?view=presenter。1枚ずつ手元で送る）、
     どちらからも「投影」で投影画面（view なし）を別の窓に出す。同期キー（sync）を引き継ぐので、どの窓も同じページを指す */
  const pageUrl = (view, page) => {
    const q = new URLSearchParams(location.search);
    q.delete('closeOnSelect');
    if (view) q.set('view', view); else q.delete('view');
    const k = q.get('sync') || history.state?.marpBespokeSyncKey;
    if (k) q.set('sync', k);
    return location.pathname + '?' + q.toString() + (page ? '#' + page : location.hash);
  };
  /* 投影：PowerPoint と同じく、ボタン1回で投影画面をもう1枚のディスプレイへ出す。押した窓（タブ）はそのまま
     手元の操作画面として残す（押した窓ごと全画面にすると、タブごと見えないディスプレイへ移ってしまう）。
     - ディスプレイが2枚：Window Management API（初回だけ Chrome が「ウィンドウの管理」の許可を聞く）で、投影画面の窓を
       もう1枚のディスプレイいっぱいに開く。開いた直後は投影画面の窓にキー入力が向くので、そこで Enter（どのキーでも）を
       押すと全画面になり、キー入力は操作画面へ戻る。ページから「最初から全画面の窓」を開く手段は Chrome に無い
       （fullscreen popups は開発中止）ため、全画面にはその窓での1回のキー操作が要る。Chrome の設定で「自動全画面」を
       許可したサイトなら、キーを待たずに全画面になる
     - ディスプレイが1枚（screen.isExtended が false）：窓を増やさず、押した窓そのものを全画面のスライドにする（下の present）
     - ディスプレイが2枚あるのに許可しなかった・全画面にできない枠の中：投影画面を普通の別窓で開く
     投影画面の窓と操作画面は BroadcastChannel で互いの有無を伝え合い、操作画面のボタンを「投影を終える」に切り替える */
  const chan = 'BroadcastChannel' in window ? new BroadcastChannel('pv:' + location.pathname) : null;
  let screensInfo = null;
  if ('getScreenDetails' in window) {
    navigator.permissions?.query({ name: 'window-management' })
      .then((p) => (p.state === 'granted' ? window.getScreenDetails() : null))
      .then((d) => { if (d) screensInfo = d; }).catch(() => {});
  }
  const toast = (text, ms = 7000) => {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = 'position:fixed;left:50%;bottom:40px;transform:translateX(-50%);z-index:2147483647;max-width:min(560px,calc(100vw - 32px));padding:14px 22px;border-radius:14px;background:#14262f;color:#fff;font:600 15px/1.5 -apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;box-shadow:0 10px 30px rgba(20,50,70,.3)';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  };
  // 操作画面へ移ったあとに出す案内（一覧から押したときは、移った先の操作画面で出す）
  try { const m = sessionStorage.getItem('pv-toast'); if (m) { sessionStorage.removeItem('pv-toast'); addEventListener('load', () => toast(m)); } } catch {}
  const openAudience = (page, scr) => {
    const geo = scr ? `,left=${scr.availLeft},top=${scr.availTop},width=${scr.availWidth},height=${scr.availHeight}` : ',width=1280,height=760';
    const w = window.open('', 'pv-audience', 'popup' + geo);
    if (!w) return null;
    /* 開いたままの投影窓が残っていても、押すたびに今の版・今のページ・今の同期キーで開き直す。
       使い回すと、発表中に資料を差し替えたとき投影窓だけ古い版のまま残り、同じページ番号でも違うスライドが映る */
    w.location.href = pageUrl('', page);
    if (scr) { try { w.moveTo(scr.availLeft, scr.availTop); w.resizeTo(scr.availWidth, scr.availHeight); } catch {} }
    // 開いた直後は Chrome が押した側の窓を前面に戻すので、クリックの効力が残っているうちに何度か投影画面の窓を前へ出す
    // （出さないと、次の Enter が操作画面に届いて全画面にならない）
    w.focus();
    for (const ms of [150, 500, 1000]) setTimeout(() => { try { if (!w.closed) w.focus(); } catch {} }, ms);
    return w;
  };
  /* 1画面の発表：PowerPoint のスライドショーと同じく、「投影」を押した窓そのものを全画面のスライドにする。
     始めるのは「投影」の1回、送るのは ← →、終えるのは Esc。別の窓も、Enter の押し直しも、手元の小窓も作らない。
     オンライン会議では、画面全体でもこの窓でも、共有を始めてから「投影」を押せばそのまま映る。
     1画面で投影画面を別の窓に分けると、全画面の窓は別のスペースへ移るので、会議アプリへ戻るたびに裏へ回って描き直しが止まり、
     どの窓で何を押すのかも分かりにくくなる。
     全画面にするのはスライドの入れ物（.bespoke-marp-parent）で、いまのページだけを画面いっぱいに出す。ページ送りは
     同じ文書の Marp がそのまま行うので、窓どうしの同期が要らない。一覧でも操作画面でも同じ動きにする */
  const singleScreen = () => window.screen.isExtended === false;
  const stage = () => document.querySelector('.bespoke-marp-parent');
  const present = () => {
    const el = stage();
    if (!el?.requestFullscreen || !document.fullscreenEnabled) return null;
    if (!document.getElementById('pv-stage-css')) {
      /* 全画面にはスライド以外を何も出さない（残り時間も出さない）。
         マウスの矢印も、2秒動かさなければ消す。動かせばまた出る */
      const st = document.createElement('style');
      st.id = 'pv-stage-css';
      st.textContent = `
.bespoke-marp-parent:fullscreen{display:block!important;padding:0!important;background:#000!important;overflow:hidden!important;outline:0!important}
.bespoke-marp-parent:fullscreen>svg.bespoke-marp-slide{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;margin:0!important;padding:0!important;filter:none!important;box-shadow:none!important;outline:0!important}
.bespoke-marp-parent:fullscreen>svg.bespoke-marp-slide:not(.bespoke-marp-active){display:none!important}
.bespoke-marp-parent:fullscreen>:not(svg.bespoke-marp-slide){display:none!important}
.bespoke-marp-parent:fullscreen.pv-still,.bespoke-marp-parent:fullscreen.pv-still *{cursor:none!important}`;
      document.head.appendChild(st);
      let still = 0;
      const wake = () => {
        el.classList.remove('pv-still');
        clearTimeout(still);
        if (document.fullscreenElement === el) still = setTimeout(() => el.classList.add('pv-still'), 2000);
      };
      el.addEventListener('mousemove', wake);
      document.addEventListener('fullscreenchange', wake);
    }
    return el.requestFullscreen();
  };
  // 一覧では ↑↓ が段の移動になる。全画面の間は、PowerPoint と同じく ↑↓・PageUp/Down・スペースも1枚ずつの送りにする
  addEventListener('keydown', (e) => {
    if (document.fullscreenElement !== stage() || document.body.dataset.bespokeView !== 'overview') return;
    const k = { ArrowDown: 'ArrowRight', PageDown: 'ArrowRight', ' ': 'ArrowRight', ArrowUp: 'ArrowLeft', PageUp: 'ArrowLeft' }[e.key];
    if (!k || !e.isTrusted) return;
    e.preventDefault(); e.stopImmediatePropagation();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, keyCode: k === 'ArrowRight' ? 39 : 37, which: k === 'ArrowRight' ? 39 : 37, bubbles: true }));
  }, true);
  // 全画面を終えたら（Esc）、一覧ではいまのページの位置へ戻す
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && document.body.dataset.bespokeView === 'overview') {
      const a = document.querySelector('.bespoke-marp-parent > svg.bespoke-marp-active');
      if (a) Element.prototype.scrollIntoView.call(a, { block: 'center' });
    }
  });
  const project = async (page, becomePresenter) => {
    // 1画面：押した窓そのものを全画面にする。全画面はクリックの直後にしか許されないので、何も待たずに最初に呼ぶ
    if (singleScreen()) {
      const req = present();
      if (req) { try { await req; return; } catch {} }
    }
    const asked = !singleScreen() && !screensInfo && 'getScreenDetails' in window;
    if (asked) { try { screensInfo = await window.getScreenDetails(); } catch { screensInfo = null; } }
    const other = screensInfo?.screens.find((s) => s !== screensInfo.currentScreen);
    // 許可のダイアログに答えている間にクリックの効力が切れたら、もう一度押してもらう
    if (other && asked && navigator.userActivation && !navigator.userActivation.isActive) {
      toast('ディスプレイの配置を許可しました。もう一度「投影」を押すと、もう1枚のディスプレイに投影画面が出ます');
      return;
    }
    const w = openAudience(page, other);
    const msg = other ? 'もう1枚のディスプレイに投影画面を出しました。どこもクリックせずに Enter を押すと全画面になります' : '';
    if (becomePresenter) {
      // もう1枚に出したときは、投影画面が全画面になってから操作画面へ移る。先に移ると、読み込み直しでキー入力が
      // この窓へ戻り、Enter が投影画面に届かない。20秒たったら全画面を待たずに移る
      if (!(w && other)) { location.href = pageUrl('presenter', page); return; }
      toast(msg, 20000);
      let moved = false;
      const go = () => { if (!moved) { moved = true; location.href = pageUrl('presenter', page); } };
      chan?.addEventListener('message', (e) => { if (e.data?.fs || e.data?.t === 'bye') go(); });
      setTimeout(go, 20000);
    } else if (w && msg) toast(msg);
  };
  const activePage = () => {
    const all = [...document.querySelectorAll('.bespoke-marp-parent > svg.bespoke-marp-slide')];
    return Math.max(0, all.findIndex((s) => s.classList.contains('bespoke-marp-active'))) + 1;
  };

  /* 一覧（窓に直接開いたもの）：上の帯に「1枚ずつ見る」と「投影」を置く。Marp 標準では、一覧は1枚表示の上に重ねる
     前提なので、直接開くと閉じるボタンが出ず、どこへも戻れない。
     ページは1回押すと選び、2回押すとそのページから1枚ずつ見る */
  if (document.body.dataset.bespokeView === 'overview') {
    if (window.frameElement?.closest('.bespoke-marp-overview')) return; // 1枚表示の上に重ねた Marp 標準の一覧
    const st = document.createElement('style');
    st.textContent = `
body[data-bespoke-view=overview] #pv-ov{height:auto;min-height:64px;justify-content:space-between;align-items:center;gap:16px;padding:10px 40px;font:500 15px/1.3 -apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;color:#14262f}
body[data-bespoke-view=overview]:has(#pv-ov) .bespoke-marp-parent{padding-top:100px}
#pv-ov .pv-ov-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700}
#pv-ov .pv-ov-btns{display:flex;gap:12px;flex:none}
#pv-ov button{all:unset;box-sizing:border-box;cursor:pointer;white-space:nowrap;text-align:center;border-radius:12px;padding:11px 20px;font-size:15px;font-weight:700;color:#fff;background:linear-gradient(90deg,#0aa5c9,#35d0ea)}
#pv-ov button.ghost{background:#fff;color:#14262f;font-weight:600;box-shadow:inset 0 0 0 1.5px rgba(20,50,70,.16)}
#pv-ov button:active{transform:scale(.97)}
#pv-ov button:focus-visible{outline:2px solid #0aa5c9;outline-offset:2px}
#pv-ov a.pv-ov-dl{all:unset;box-sizing:border-box;cursor:pointer;white-space:nowrap;text-align:center;border-radius:12px;padding:11px 16px;font-size:15px;font-weight:600;color:#14262f;background:#fff;box-shadow:inset 0 0 0 1.5px rgba(20,50,70,.16)}
#pv-ov a.pv-ov-dl:focus-visible{outline:2px solid #0aa5c9;outline-offset:2px}
@media (max-width:900px){body[data-bespoke-view=overview] #pv-ov{padding:10px 20px}}
body[data-bespoke-view=overview] #pv-ov.pv-framed{min-height:58px;padding:8px 76px 9px}
body[data-bespoke-view=overview]:has(#pv-ov.pv-framed) .bespoke-marp-parent{padding-top:94px}
@media (max-width:560px){body[data-bespoke-view=overview] #pv-ov{padding:10px 16px}body[data-bespoke-view=overview] #pv-ov.pv-framed{padding-left:64px;padding-right:64px}#pv-ov .pv-ov-title{display:none}#pv-ov .pv-ov-btns{flex:1}#pv-ov button,#pv-ov a.pv-ov-dl{flex:1;min-width:0;padding-left:8px;padding-right:8px}#pv-ov .pv-dl-pre{display:none}}`;
    document.head.appendChild(st);
    const bar = document.createElement('header');
    bar.id = 'pv-ov';
    bar.className = 'bespoke-marp-overview-header';
    bar.innerHTML = '<div class="pv-ov-title"></div><div class="pv-ov-btns"><button class="pv-ov-one">1枚ずつ見る</button><button class="ghost pv-ov-aud">投影</button></div>';
    bar.querySelector('.pv-ov-title').textContent = document.title.replace(/^\[Overview\]\s*-?\s*/, '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    // iframe の中で開くと、Marp は「1枚表示の上に重ねた一覧」と取り違えて、閉じるボタンだけの帯をこちらの帯の上へ
    // もう1枚重ねる（押しても戻れない）。それを外し、埋め込み側が左右上に置くボタンの分だけ両端を空ける
    document.querySelectorAll('.bespoke-marp-overview-header:not(#pv-ov)').forEach((n) => n.remove());
    if (window.parent !== window) bar.classList.add('pv-framed');
    document.body.prepend(bar);
    /* 原稿の隣に PDF があるときだけ、帯の右端に「PDFをダウンロード」を出す（隠しリンクは present.py の pdf_link）。
       発表を聞いた人へ URL を渡せば、資料もそこから持ち帰れる。スマホでは3つが1行に収まるよう「PDFを」を省く */
    const pdf = document.getElementById('pv-pdf');
    if (pdf) {
      const dl = document.createElement('a');
      dl.className = 'pv-ov-dl';
      dl.href = pdf.getAttribute('href');
      dl.download = pdf.getAttribute('download') || '';
      dl.innerHTML = '<span class="pv-dl-pre">PDFを</span>ダウンロード';
      dl.title = `${pdf.dataset.at} の版・${pdf.dataset.size}`;
      dl.addEventListener('click', () => toast(`${pdf.dataset.at} の版の PDF（${pdf.dataset.size}）をダウンロードしています`, 4000));
      bar.querySelector('.pv-ov-btns').appendChild(dl);
    }
    for (const t of ['keydown', 'keyup', 'keypress']) bar.addEventListener(t, (e) => e.stopPropagation());
    bar.querySelector('.pv-ov-one').addEventListener('click', () => { location.href = pageUrl('presenter', activePage()); });
    // 一覧で「投影」を押したら、2画面ではこの窓が操作画面になる。1画面ではこの窓がそのまま全画面のスライドになる
    bar.querySelector('.pv-ov-aud').addEventListener('click', (e) => { e.currentTarget.blur(); project(activePage(), true); });
    /* 探している最中は勝手にスクロールさせない。Marp 標準の一覧は、ページが変わるたび（投影の窓など、同期している
       ほかの窓で変わったときも）そのページへ滑らかにスクロールするので、過去のページを探している途中で引き戻される。
       手で動かしてから3秒は止め、矢印キーで選び直したときだけは追いかける */
    let handAt = 0, keyAt = 0;
    for (const t of ['wheel', 'touchmove']) addEventListener(t, () => { handAt = Date.now(); }, { passive: true });
    addEventListener('keydown', () => { keyAt = Date.now(); }, true);
    document.querySelectorAll('.bespoke-marp-parent > svg.bespoke-marp-slide').forEach((svg, i) => {
      svg.scrollIntoView = function (o) {
        if (Date.now() - keyAt < 600 || Date.now() - handAt > 3000) Element.prototype.scrollIntoView.call(this, o);
      };
      svg.addEventListener('dblclick', () => { location.href = pageUrl('presenter', i + 1); });
    });
    /* 各ページの番号を、スライドの外（升の左上の行間）に小さく出す。スライド右下のページ番号は3列の升では
       小さすぎて読めず、「◯枚目を直して」と伝えるときに数えることになるため。スライドの上に重ねると見出しが
       隠れるので外に置く。svg には擬似要素を付けられないので、一覧の格子へ絶対配置の札を足し、升の位置が
       変わるたびに置き直す */
    const grid = document.querySelector('.bespoke-marp-parent');
    const slides = [...grid.querySelectorAll(':scope > svg.bespoke-marp-slide')];
    const nst = document.createElement('style');
    nst.textContent = `
body[data-bespoke-view=overview] .bespoke-marp-parent{position:relative;row-gap:46px}
@media (max-width:900px){body[data-bespoke-view=overview] .bespoke-marp-parent{row-gap:42px}}
.pv-num{position:absolute;z-index:2;pointer-events:none;transform:translate(2px,calc(-100% - 11px));font:800 13px/1 -apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;letter-spacing:.08em;font-variant-numeric:tabular-nums;color:#0891b2;background:linear-gradient(90deg,#0ea5e9,#06b6d4 50%,#22d3ee);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}`;
    document.head.appendChild(nst);
    const tags = slides.map((_, i) => {
      const t = document.createElement('div');
      t.className = 'pv-num';
      t.textContent = i + 1;
      grid.appendChild(t);
      return t;
    });
    const placeNums = () => {
      const g = grid.getBoundingClientRect();
      slides.forEach((svg, i) => {
        const r = svg.getBoundingClientRect();
        const s = tags[i].style;
        s.left = `${r.left - g.left + grid.scrollLeft - grid.clientLeft}px`;
        s.top = `${r.top - g.top + grid.scrollTop - grid.clientTop}px`;
      });
    };
    placeNums();
    new ResizeObserver(placeNums).observe(grid);
    addEventListener('resize', placeNums);
    return;
  }

  /* 投影画面の窓：自動全画面が許されていればすぐ全画面に、そうでなければ最初のキーかクリックで全画面にする。
     全画面にしたら、キー入力を操作画面（開いた側の窓）へ返す。ディスプレイが1枚なら、窓の下に全画面にするかの案内を出す */
  if (document.body.dataset.bespokeView === '' && window.name === 'pv-audience') {
    // 状態（全画面か・キー入力がこの窓にあるか・最後のキーと全画面のエラー）も伝える。操作画面の表示と、不具合の切り分けに使う
    const diag = { keys: 0, err: '' };
    const say = (t) => chan?.postMessage({ t, fs: !!document.fullscreenElement, focus: document.hasFocus(), ...diag });
    say('here');
    setInterval(() => say('here'), 1500);
    addEventListener('pagehide', () => say('bye'));
    document.addEventListener('fullscreenchange', () => say('here'));
    // 開いた直後にキー入力をこの窓へ向ける（次の Enter で全画面にするため。操作画面へ移るときの読み込みに取られないよう少し待つ）
    for (const ms of [0, 400, 1200]) setTimeout(() => { if (!document.fullscreenElement) window.focus(); }, ms);
    chan?.addEventListener('message', (e) => { if (e.data?.t === 'close') window.close(); });
    const back = () => { try { window.opener?.focus(); } catch {} };
    const full = () => {
      if (document.fullscreenElement) return;
      document.documentElement.requestFullscreen?.().then(() => { bar.remove(); back(); }).catch((e) => { diag.err = String(e); say('here'); });
    };
    const st = document.createElement('style');
    st.textContent = '#pv-aud{position:fixed;left:50%;bottom:36px;transform:translateX(-50%);z-index:99;display:flex;gap:12px;align-items:center;padding:14px 16px 14px 22px;border-radius:99px;background:rgba(255,255,255,.96);box-shadow:0 8px 30px rgba(20,50,70,.25);font:500 15px/1.2 -apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;color:#14262f}#pv-aud button{all:unset;cursor:pointer;border-radius:99px;padding:12px 22px;font-weight:700;color:#fff;background:linear-gradient(90deg,#0aa5c9,#35d0ea)}#pv-aud button.g{background:#eef2f5;color:#14262f;font-weight:500}';
    document.head.appendChild(st);
    const bar = document.createElement('div');
    bar.id = 'pv-aud';
    bar.innerHTML = '<span>投影画面です</span><button class="f">全画面にする</button><button class="g">このまま使う</button>';
    document.body.appendChild(bar);
    bar.querySelector('.g').addEventListener('click', (e) => { e.stopPropagation(); bar.remove(); });
    bar.querySelector('.f').addEventListener('click', (e) => { e.stopPropagation(); full(); });
    // 最初のキー（矢印キーでも）で全画面に。ページ送りはそのまま Marp が行う
    addEventListener('keydown', () => { diag.keys++; if (bar.isConnected) full(); }, true);
    full(); // 自動全画面が許可されたサイトなら、ここで全画面になる
    return;
  }
  if (document.body.dataset.bespokeView !== 'presenter') return;
  const container = document.querySelector('.bespoke-marp-presenter-container');
  const parent = document.querySelector('.bespoke-marp-parent');
  if (!container || !parent) return;

  const KEY = 'presenter-view:' + location.pathname;
  const DEFAULT_MIN = Number(document.body.dataset.pvMinutes || 45);
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  let st = Object.assign({ dur: DEFAULT_MIN * 60, startedAt: null, pausedElapsed: 0 }, load());
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch {} };
  const elapsed = () => st.pausedElapsed + (st.startedAt ? (Date.now() - st.startedAt) / 1000 : 0);
  const mmss = (s) => { s = Math.max(0, Math.floor(s)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  const hhmm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');

  /* ── いまいる章：最初のページと、指定したクラス（既定は lead・top・crosshead）のページを章の切れ目として、その見出しをバーの上に出す ── */
  const slides = [...parent.querySelectorAll(':scope > svg.bespoke-marp-slide')];
  const total = slides.length;
  const titleOf = (svg) => ((svg.querySelector('section h1') || svg.querySelector('section h2'))?.textContent || '').replace(/\s+/g, ' ').trim();
  const chapters = [];
  const breakClasses = (document.body.dataset.pvChapterClass || 'lead top crosshead').split(/\s+/).filter(Boolean);
  slides.forEach((svg, i) => {
    const sec = svg.querySelector('section');
    const isBreak = i === 0 || (sec && breakClasses.some((c) => sec.classList.contains(c)));
    if (isBreak) chapters.push({ start: i, title: titleOf(svg) || `${i + 1}ページ` });
  });
  chapters.forEach((c, k) => { c.end = (chapters[k + 1]?.start ?? total) - 1; c.len = c.end - c.start + 1; });
  /* ── パート：原稿の隣の present-parts.txt に書いた大きな区切り（present.py が埋め込む）。無ければバーは1本 ── */
  const norm = (t) => t.replace(/\s+/g, '');
  const heads = slides.map((svg) => norm(titleOf(svg)));
  let parts = [];
  try {
    for (const p of JSON.parse(document.body.dataset.pvParts || '[]')) {
      const at = heads.findIndex((h) => h && h.startsWith(norm(p.head)));
      if (at >= 0) parts.push({ name: p.name, start: at });
      else console.warn('presenter-view: パートの先頭が見つかりません', p);
    }
  } catch { parts = []; }
  parts.sort((a, b) => a.start - b.start);
  if (parts.length && parts[0].start !== 0) parts[0].start = 0;
  if (parts.length < 2) parts = [{ name: '', start: 0 }];
  parts.forEach((p, k) => { p.end = (parts[k + 1]?.start ?? total) - 1; p.len = p.end - p.start + 1; });
  const curIndex = () => Math.max(0, slides.findIndex((s) => s.classList.contains('bespoke-marp-active')));

  const css = `
body[data-bespoke-view=presenter][data-pv]{background:#f1f4f6;--pv-ink:#14262f;--pv-mute:#6d808b;--pv-line:rgba(20,50,70,.10);--pv-acc:#0aa5c9;--pv-acc2:#35d0ea;--pv-warn:#e08a00;--pv-over:#e0443e;--pv-state:var(--pv-acc);
  --pv-card:0 1px 2px rgba(20,50,70,.06),0 8px 24px rgba(20,50,70,.07);--pv-float:drop-shadow(0 1px 2px rgba(20,50,70,.10)) drop-shadow(0 10px 24px rgba(20,50,70,.13));
  font-family:"Inter","Helvetica Neue",-apple-system,BlinkMacSystemFont,"Hiragino Sans","Hiragino Kaku Gothic ProN",sans-serif}
body[data-pv].pv-warn{--pv-state:var(--pv-warn)}body[data-pv].pv-over{--pv-state:var(--pv-over)}
body[data-bespoke-view=presenter][data-pv] .bespoke-marp-presenter-container{font-family:inherit;color:var(--pv-ink);background:transparent;padding:22px 26px;gap:18px;box-sizing:border-box}
body.pv-framed[data-bespoke-view=presenter][data-pv] .bespoke-marp-presenter-container{padding-top:62px}
body[data-bespoke-view=presenter][data-pv] .bespoke-marp-presenter-container .bespoke-marp-presenter-dragbar-container,
body[data-bespoke-view=presenter][data-pv] .bespoke-marp-presenter-container .bespoke-marp-presenter-info-container,
body[data-bespoke-view=presenter][data-pv] .bespoke-marp-presenter-container .bespoke-marp-presenter-next-container{display:none!important}
body[data-bespoke-view=presenter][data-pv] .bespoke-marp-presenter-container :where(.bespoke-marp-parent){background:transparent;overflow:visible}
body[data-bespoke-view=presenter][data-pv] .bespoke-marp-presenter-container :where(.bespoke-marp-parent)>svg.bespoke-marp-slide{top:0;left:0;width:100%;height:100%;padding:6px 10px 16px;box-sizing:border-box;filter:var(--pv-float)!important}
body[data-bespoke-view=presenter][data-pv] .bespoke-marp-presenter-container .bespoke-marp-presenter-note-container{background:#fff;color:var(--pv-ink);border-radius:16px;box-shadow:var(--pv-card);height:20vh;display:none}
body[data-pv].pv-has-notes .bespoke-marp-presenter-container .bespoke-marp-presenter-note-container{display:block}
body[data-bespoke-view=presenter][data-pv] .bespoke-marp-presenter-container .bespoke-marp-presenter-note-container .bespoke-marp-presenter-note-buttons{background:rgba(20,50,70,.75)}

/* ── 部品（どの案でも同じ） ── */
#pv-head{grid-area:head;background:#fff;border-radius:18px;box-shadow:var(--pv-card);font-variant-numeric:tabular-nums;min-width:0}
#pv-head *{box-sizing:border-box}
.pv-time{grid-area:time;display:flex;align-items:center;gap:12px;min-width:0}
.pv-tools{grid-area:tools;display:flex;align-items:center;gap:18px}
.pv-clock{display:flex;flex-direction:column;gap:4px;cursor:pointer;user-select:none;min-width:150px}
.pv-remain{font-size:46px;font-weight:650;line-height:1;letter-spacing:-.01em;color:var(--pv-ink)}
body.pv-warn .pv-remain,body.pv-over .pv-remain{color:var(--pv-state)}
.pv-state{font-size:12px;color:var(--pv-mute);letter-spacing:.08em;white-space:nowrap}
.pv-state i{display:inline-block;width:7px;height:7px;border-radius:50%;background:#b9c4cb;margin-right:6px;vertical-align:1px}
body.pv-running .pv-state i{background:var(--pv-state)}
#pv-head button.pv-b{all:unset;box-sizing:border-box;font-size:16px;font-weight:700;line-height:1.2;white-space:nowrap;text-align:center;border-radius:12px;padding:13px 22px;min-width:104px;cursor:pointer;color:#fff;background:linear-gradient(90deg,var(--pv-acc),var(--pv-acc2))}
#pv-head button.pv-b.ghost{background:#fff;color:var(--pv-ink);box-shadow:inset 0 0 0 1.5px rgba(20,50,70,.16);font-weight:600}
#pv-head button.pv-b:active{transform:scale(.97)}
#pv-head button.pv-b:focus-visible,button.pv-nav:focus-visible,.pv-th:focus-visible{outline:2px solid var(--pv-acc);outline-offset:2px}
#pv-head button.pv-b[hidden]{display:none}
/* 開始前だけ、数字の分のところが入力欄になる（薄い地と下線で「打てる」と分かる形）。開始すると .pv-count に替わる */
.pv-remain{display:flex;align-items:baseline}
.pv-edit{display:none;align-items:baseline}
body.pv-idle .pv-edit{display:flex}body.pv-idle .pv-count{display:none}
.pv-min{font:inherit;color:inherit;letter-spacing:inherit;font-variant-numeric:tabular-nums;width:calc(var(--pv-n,2)*.6em + 8px);text-align:right;padding:0 4px;margin-left:-4px;border:0;border-radius:8px;background:#eef3f6;box-shadow:inset 0 -2px 0 rgba(10,165,201,.55);outline:none;cursor:text}
.pv-min:focus{background:#fff;box-shadow:inset 0 0 0 2px var(--pv-acc)}
.pv-wall{display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.pv-wall small{font-size:11.5px;color:var(--pv-mute);letter-spacing:.08em;white-space:nowrap}
/* 現在時刻は数字も灰色にする。残り時間と同じ濃い色だと、どちらが残り時間か一瞬迷うため */
.pv-wall b{font-size:24px;font-weight:650;line-height:1;color:var(--pv-mute)}
.pv-map{grid-area:map;min-width:0;display:flex;flex-direction:column;gap:7px}
.pv-now{display:flex;justify-content:space-between;align-items:baseline;gap:14px;min-width:0}
.pv-chapter{color:var(--pv-ink);font-weight:600;font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.pv-pace{white-space:nowrap;flex:none;font-size:13px;font-weight:600;color:var(--pv-ink)}
.pv-pace.late{color:var(--pv-warn)}
.pv-track{position:relative;display:flex;gap:5px;height:12px}
.pv-part{position:relative;flex-basis:0;min-width:0;height:100%;border-radius:99px;background:rgba(20,50,70,.10);overflow:hidden}
.pv-part i{position:absolute;inset:0 auto 0 0;width:0;background:linear-gradient(90deg,var(--pv-acc),var(--pv-acc2));transition:width .25s ease}
.pv-names{display:flex;gap:5px;font-size:12px;color:#9aa8b1;letter-spacing:.04em}
.pv-names span{flex-basis:0;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-left:2px}
.pv-names span.cur{color:var(--pv-ink);font-weight:600}
.pv-names:empty{display:none}
.pv-needle{position:absolute;top:-6px;bottom:-6px;width:3px;margin-left:-1.5px;border-radius:2px;background:var(--pv-ink);transition:left .5s linear;pointer-events:none}
.pv-needle::before{content:"";position:absolute;left:50%;top:-4px;width:9px;height:9px;margin-left:-4.5px;border-radius:50%;background:var(--pv-ink)}
body.pv-warn .pv-needle,body.pv-warn .pv-needle::before,body.pv-over .pv-needle,body.pv-over .pv-needle::before{background:var(--pv-state)}
/* 前後のページ：左から（縦置きの案では上から）まえ … いま … つぎ。押すとそのページへ飛ぶ */
/* 横にあふれたぶんは隠すが、いまのページの青い枠（3px）と影は下へはみ出す。帯の下に逃げを足し、同じ量を下の余白へ
   食い込ませて、サムネイルの大きさは変えない（逃げが無いと枠と影の下側が切れて見える） */
#pv-strip{grid-area:strip;display:flex;justify-content:center;gap:14px;min-height:0;min-width:0;overflow:hidden;box-sizing:border-box;padding-bottom:16px;margin-bottom:-16px}
.pv-th{all:unset;box-sizing:border-box;position:relative;height:100%;aspect-ratio:16 / 10.4;display:flex;flex-direction:column;gap:5px;cursor:pointer;min-width:0;flex:none}
.pv-cap{font-size:12px;font-weight:600;color:var(--pv-mute);letter-spacing:.06em;line-height:1;height:14px;white-space:nowrap;font-variant-numeric:tabular-nums}
.pv-pic{flex:1;min-height:0;position:relative;border-radius:6px;overflow:hidden;background:#fff;box-shadow:0 1px 2px rgba(20,50,70,.10),0 6px 14px rgba(20,50,70,.10);display:block}
.pv-pic>div{position:absolute;inset:0}
.pv-pic svg{display:block;width:100%;height:100%;pointer-events:none}
.pv-th.past .pv-pic{opacity:.55}
.pv-th.now .pv-cap{color:var(--pv-acc);font-weight:700}
.pv-th.now .pv-pic{box-shadow:0 0 0 3px var(--pv-acc),0 6px 14px rgba(20,50,70,.10)}
.pv-th:hover .pv-pic{opacity:1}
#pv-nav{grid-area:nav;display:flex;gap:12px;justify-content:center}
button.pv-nav{all:unset;box-sizing:border-box;align-self:center;width:var(--pv-bw,84px);height:calc(var(--pv-bw,84px)*1.55);display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;border-radius:16px;cursor:pointer;font-size:14px;font-weight:700;white-space:nowrap;color:var(--pv-ink);background:#fff;box-shadow:inset 0 0 0 1.5px rgba(20,50,70,.16)}
button.pv-nav.pv-next{color:#fff;box-shadow:none;background:linear-gradient(180deg,var(--pv-acc),var(--pv-acc2))}
button.pv-nav b{font-size:30px;font-weight:600;line-height:1}
button.pv-nav:active{transform:scale(.985)}

/* ── 配置：上にパネル（2段）、中央に今のページとその左右に送りボタン、下に前後のページの帯。余白を残して詰めない ── */
body[data-bespoke-view=presenter][data-pv] .bespoke-marp-presenter-container{grid-template:"head head head head head" auto ". navp current navn ." minmax(0,1fr) "strip strip strip strip strip" clamp(96px,12.5vh,150px) "note note note note note" auto / minmax(0,1fr) auto var(--pv-cw,minmax(0,6fr)) auto minmax(0,1fr);column-gap:12px}
#pv-head{display:grid;grid-template:"time tools" auto "map map" auto / minmax(0,1fr) auto;gap:12px 20px;padding:14px 20px}
/* 広い画面では上のパネルを1行（残り時間｜進み具合｜一覧・投影・現在時刻）にして、その分スライドを縦に大きくする。
   2段のままだとノートPCの1画面でスライドが小さくなる。狭い幅は2段・3段のまま */
@media (min-width:1000px){
#pv-head{grid-template:"time map tools" auto / auto minmax(0,1fr) auto;align-items:center;gap:0 28px;padding:10px 20px}
.pv-clock{min-width:118px;gap:3px}
.pv-remain{font-size:36px}
#pv-head button.pv-b{padding:10px 18px;min-width:84px}
.pv-map{gap:5px}
.pv-wall b{font-size:21px}
}
/* 送りボタン：今のページのすぐ左に「前へ」、すぐ右に「次へ」（帯・矢印キーと同じ向き） */
#pv-nav{display:contents}
button.pv-nav.pv-prev{grid-area:navp}
button.pv-nav.pv-next{grid-area:navn}
/* スマホの縦持ち：残り時間と「一覧・投影・現在時刻」が1行に収まらず重なるので、
   上のパネルを3段にし、2段目にボタンと現在時刻を幅いっぱいに並べる */
@media (max-width:620px){
body[data-bespoke-view=presenter][data-pv] .bespoke-marp-presenter-container{padding:14px 12px;gap:12px}
#pv-head{grid-template:"time" auto "tools" auto "map" auto / minmax(0,1fr);gap:12px;padding:12px 14px}
.pv-clock{min-width:0;flex:1}
.pv-tools{gap:10px}
#pv-head .pv-tools button.pv-b{flex:1;min-width:0;padding:11px 8px}
}
`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  document.body.dataset.pv = '1';
  /* ノート欄は、いまのスライドにノートがあるときだけ出す（render で毎回判定）。デッキ単位で出すと、メモのコメントが
     1枚にあるだけで全ページに空の欄が残り、スライドが小さくなる。Marp は指示以外の HTML コメントをすべてノートにする */
  const hasNote = (i) => !!document.querySelector(`.bespoke-marp-note[data-index="${i}"]`)?.textContent.trim();
  // Marp 標準の「次のページ」は別の文書を丸ごと読み込む枠なので使わない（前後のページは、手元のスライドを写して見せる）
  document.querySelector('iframe.bespoke-marp-presenter-next')?.remove();

  const head = document.createElement('div');
  head.id = 'pv-head';
  head.innerHTML = `
<div class="pv-time">
  <div class="pv-clock" title="クリックで開始・一時停止">
    <div class="pv-remain"><span class="pv-edit"><input type="text" inputmode="numeric" maxlength="3" class="pv-min" aria-label="持ち時間（分）" title="持ち時間（分）。打って Enter で開始"><span>:00</span></span><span class="pv-count">--:--</span></div>
    <div class="pv-state"><i></i><span></span></div>
  </div>
  <button class="pv-b pv-go">開始</button><button class="pv-b ghost pv-reset" hidden>リセット</button>
</div>
<div class="pv-tools">
  <button class="pv-b ghost pv-list">一覧</button>
  <button class="pv-b ghost pv-aud">投影</button>
  <div class="pv-wall"><small>現在時刻</small><b></b></div>
</div>
<div class="pv-map">
  <div class="pv-now"><span class="pv-chapter"></span><span class="pv-pace"></span></div>
  <div class="pv-track"><div class="pv-needle"></div></div>
  <div class="pv-names"></div>
</div>`;
  const strip = document.createElement('div');
  strip.id = 'pv-strip';
  const nav = document.createElement('div');
  nav.id = 'pv-nav';
  nav.innerHTML = '<button class="pv-nav pv-prev"><b>←</b>前へ</button><button class="pv-nav pv-next"><b>→</b>次へ</button>';
  container.append(head, strip, nav);
  // iframe の中では、埋め込み側が左右上にボタンを重ねることが多いので、上のパネルをその下まで下げる
  if (window.parent !== window) document.body.classList.add('pv-framed');
  const prevBtn = nav.querySelector('.pv-prev'), nextBtn = nav.querySelector('.pv-next');

  const $ = (s) => head.querySelector(s);

  // バー：パートごとに1区切り。下に薄い文字でパート名
  parts.forEach((p) => {
    const seg = document.createElement('div');
    seg.className = 'pv-part'; seg.style.flexGrow = p.len; seg.innerHTML = '<i></i>';
    $('.pv-track').insertBefore(seg, $('.pv-needle'));
    p.el = seg;
    if (p.name) {
      const n = document.createElement('span');
      n.style.flexGrow = p.len; n.textContent = p.name;
      $('.pv-names').appendChild(n);
      p.label = n;
    }
  });

  const input = $('.pv-min');
  const showMin = () => { input.value = Math.round(st.dur / 60); input.style.setProperty('--pv-n', Math.max(2, input.value.length)); };
  showMin();
  // 入力欄とボタンの中のキー操作でスライドがめくれないようにする
  for (const el of [head, strip, nav]) for (const t of ['keydown', 'keyup', 'keypress']) el.addEventListener(t, (e) => e.stopPropagation());
  // 持ち時間：数字だけを受け付け、桁数に合わせて欄の幅を変える。Enter で決めてそのまま開始する
  const commitMin = () => { st.dur = Math.min(600, Math.max(1, Number(input.value) || DEFAULT_MIN)) * 60; save(); showMin(); render(); };
  input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 3); input.style.setProperty('--pv-n', Math.max(2, input.value.length)); });
  input.addEventListener('change', commitMin);
  input.addEventListener('focus', () => input.select());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { commitMin(); input.blur(); toggle(); }
    if (e.key === 'Escape') { showMin(); input.blur(); }
  });
  const toggle = () => {
    if (document.activeElement === input) { commitMin(); input.blur(); }
    if (st.startedAt) { st.pausedElapsed = elapsed(); st.startedAt = null; } else { st.startedAt = Date.now(); }
    save(); render();
  };
  $('.pv-go').addEventListener('click', (e) => { toggle(); e.currentTarget.blur(); });
  $('.pv-clock').addEventListener('click', (e) => { if (e.target !== input) toggle(); });
  // リセットは止めているときにだけ、開始ボタンの右隣に出す（ほかのボタンの位置は動かさない。話している最中は押せない）
  $('.pv-reset').addEventListener('click', () => { st.startedAt = null; st.pausedElapsed = 0; save(); render(); });
  const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, keyCode: k === 'ArrowRight' ? 39 : 37, which: k === 'ArrowRight' ? 39 : 37, bubbles: true }));
  nextBtn.addEventListener('click', (e) => { key('ArrowRight'); e.currentTarget.blur(); });
  prevBtn.addEventListener('click', (e) => { key('ArrowLeft'); e.currentTarget.blur(); });
  // 投影画面：この操作画面と同じ同期キーで出す。投影画面の窓が開いている間は、ボタンが「投影を終える」になり、押すと閉じる
  const audBtn = $('.pv-aud');
  let audSeen = 0;
  let audFs = false;
  chan?.addEventListener('message', (e) => {
    if (e.data?.t === 'here') { audSeen = Date.now(); audFs = !!e.data.fs; }
    if (e.data?.t === 'bye') audSeen = 0;
    syncAudBtn();
  });
  /* 投影画面がまだ全画面でないのに、キー入力がこちら（操作画面）に来ていたら、Enter で投影画面の窓へキー入力を移す。
     全画面にできるのは投影画面の窓での操作だけなので、移したあともう一度 Enter を押してもらう */
  addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !audOpen() || audFs || e.target.closest?.('input')) return;
    const w = window.open('', 'pv-audience');
    if (!w) return;
    try { if (w.location.href === 'about:blank') { w.close(); return; } } catch {}
    w.focus();
    toast('投影画面の窓にキー入力を移しました。もう一度 Enter を押すと全画面になります');
  }, true);
  const audOpen = () => Date.now() - audSeen < 4000;
  const syncAudBtn = () => { audBtn.textContent = audOpen() ? '投影を終える' : '投影'; };
  audBtn.addEventListener('click', (e) => {
    e.currentTarget.blur();
    if (audOpen()) { chan.postMessage({ t: 'close' }); audSeen = 0; syncAudBtn(); return; }
    project(curIndex() + 1, false);
  });
  syncAudBtn();
  setInterval(syncAudBtn, 1000);
  // 一覧：いまのページを選んだ状態で、縦スクロール3列の一覧へ戻る
  $('.pv-list').addEventListener('click', () => { location.href = pageUrl('overview', curIndex() + 1); });

  /* ── 前後のページ：手元のスライド（SVG）を写して並べる。別の文書を読み込まないので軽く、何枚でも出せる ── */
  const picture = (i) => {
    const pic = document.createElement('span'); pic.className = 'pv-pic';
    // Marp のテーマの指定は「div#:$p > svg > …」の形で当たるので、同じ id の入れ物に入れて写す
    const host = document.createElement('div'); host.id = parent.id;
    const svg = slides[i].cloneNode(true);
    svg.removeAttribute('class'); svg.removeAttribute('style'); svg.removeAttribute('data-bespoke-marp-load');
    svg.querySelectorAll('[data-bespoke-marp-fragment]').forEach((n) => n.removeAttribute('data-bespoke-marp-fragment'));
    svg.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    host.appendChild(svg); pic.appendChild(host);
    return pic;
  };
  const caption = (text) => { const c = document.createElement('span'); c.className = 'pv-cap'; c.textContent = text; return c; };
  const thumb = (i, cur) => {
    const b = document.createElement('button');
    b.className = 'pv-th' + (i < cur ? ' past' : i === cur ? ' now' : '');
    b.title = `${i + 1}ページへ`;
    b.append(caption(i === cur ? `いま ${i + 1} / ${total}` : String(i + 1)), picture(i));
    b.addEventListener('click', () => { location.hash = '#' + (i + 1); b.blur(); });
    return b;
  };
  /* 帯は PowerPoint のサムネイルのように、左右スクロール（トラックパッドの横スワイプ・ホイール）でめくって前後のページを
     探せる。めくっても投影は変えず、押したページへ飛ぶ。ページが変わるか、10秒さわらなければ、いまのページの周りへ戻る */
  let stripCount = 6, stripKey = '', browse = 0, browseAt = 0, wheelAcc = 0, lastCur = -1;
  const drawStrip = (cur) => {
    if (cur !== lastCur) { lastCur = cur; browse = 0; }
    if (browse && Date.now() - browseAt > 10000) browse = 0;
    const k = cur + ':' + stripCount + ':' + browse;
    if (k === stripKey) return;
    stripKey = k;
    const c = Math.max(0, Math.min(total - 1, cur + browse)); // 帯の真ん中あたりに来るページ
    // まえは1〜2枚、残りをつぎに回す。端では足りないぶんを反対側へ足す
    let before = Math.min(c, stripCount >= 6 ? 2 : 1);
    let after = Math.min(total - 1 - c, stripCount - 1 - before);
    before = Math.min(c, stripCount - 1 - after);
    const list = [];
    for (let i = c - before; i <= c + after; i++) list.push(thumb(i, cur));
    strip.replaceChildren(...list);
  };
  strip.addEventListener('wheel', (e) => {
    e.preventDefault();
    wheelAcc += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const step = Math.trunc(wheelAcc / 60);
    if (!step) return;
    wheelAcc -= step * 60;
    const cur = curIndex();
    browse = Math.max(-cur, Math.min(total - 1 - cur, browse + step));
    browseAt = Date.now();
    drawStrip(cur);
  }, { passive: false });
  // 帯に並べる枚数：帯の幅に入るだけ
  const fit = () => {
    // 大きい窓での文字・ボタンの拡大（控えめに最大1.35倍）
    const u = Math.max(1, Math.min(window.innerWidth / 1350, window.innerHeight / 950, 1.35));
    head.style.zoom = u; prevBtn.style.zoom = u; nextBtn.style.zoom = u;
    // 今のページの列の幅：行の高さに入る大きさ。ただし左右に送りボタンの幅を残す（ボタンをページのすぐ隣に置くため）
    const cs = getComputedStyle(container);
    const innerW = container.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const colGap = parseFloat(cs.columnGap) || 0;
    const byHeight = (parent.clientHeight - 22) * 16 / 9 + 20;
    const bw = innerW < 700 ? 54 : 84;                                // 細い窓ではボタンを細くして、今のページの幅を残す
    container.style.setProperty('--pv-bw', bw + 'px');
    const byWidth = innerW - (bw * u + colGap * 2) * 2;
    // 下限はスマホの縦持ち（幅390）でも横にはみ出さない大きさにする（240 だと送りボタンと合わせて画面の幅を超える）
    container.style.setProperty('--pv-cw', Math.max(160, Math.round(Math.min(byHeight, byWidth))) + 'px');
    const ss = getComputedStyle(strip);
    const w = strip.clientWidth, h = strip.clientHeight - parseFloat(ss.paddingTop) - parseFloat(ss.paddingBottom);
    if (!w || !h) return;
    const tw = h * 16 / 10.4;
    const n = Math.max(3, Math.min(9, Math.floor((w + 14) / (tw + 14))));
    if (n !== stripCount) { stripCount = n; drawStrip(curIndex()); }
  };

  function render() {
    const e = elapsed(), remain = st.dur - e, running = !!st.startedAt, started = e > 0;
    const warn = remain >= 0 && remain <= Math.min(300, st.dur * 0.15) && started;
    document.body.classList.toggle('pv-over', remain < 0);
    document.body.classList.toggle('pv-warn', warn);
    document.body.classList.toggle('pv-running', running);
    document.body.classList.toggle('pv-idle', !started && !running);
    $('.pv-count').textContent = remain >= 0 ? mmss(remain) : '+' + mmss(-remain);
    $('.pv-state span').textContent = remain < 0 ? '時間を超えています' : (running ? '残り時間' : (started ? '一時停止中' : '持ち時間を入力'));
    $('.pv-go').textContent = running ? '一時停止' : (started ? '再開' : '開始');
    $('.pv-go').classList.toggle('ghost', running);
    $('.pv-reset').hidden = running || !started;

    const i = curIndex();
    const k = Math.max(0, chapters.findIndex((c) => i >= c.start && i <= c.end));
    const pk = Math.max(0, parts.findIndex((p) => i >= p.start && i <= p.end));
    parts.forEach((p, n) => {
      p.el.firstChild.style.width = (n < pk ? 100 : n > pk ? 0 : ((i - p.start + 1) / p.len) * 100) + '%';
      p.label?.classList.toggle('cur', n === pk);
    });
    $('.pv-chapter').textContent = chapters[k].title;
    if (document.body.classList.contains('pv-has-notes') !== hasNote(i)) {
      document.body.classList.toggle('pv-has-notes', hasNote(i));
      requestAnimationFrame(() => fit());
    }
    drawStrip(i);
    $('.pv-needle').style.left = Math.min(100, (e / st.dur) * 100) + '%';
    $('.pv-needle').style.display = started ? '' : 'none';
    // ペース：全ページを同じ長さで話すと仮定した目安
    const pace = $('.pv-pace');
    if (!started || total < 2) { pace.textContent = ''; }
    else {
      const diff = Math.round((e - st.dur * (i / (total - 1))) / 60);
      pace.textContent = diff === 0 ? 'ほぼ予定どおり' : (diff > 0 ? `${diff}分 遅れ` : `${-diff}分 先行`);
      pace.classList.toggle('late', diff >= 2);
    }
    $('.pv-wall b').textContent = hhmm(new Date());
  }
  new ResizeObserver(fit).observe(strip);
  new ResizeObserver(fit).observe(container);
  render();
  fit();
  setInterval(render, 250);
  // 読み込み直後は書体が後から入って画面が動く。そろうまで隠し、そろってから一度に見せる
  // （隠す指定は present.py が head に入れた html.pv-boot。ここで pv-ready を付けて解く）
  {
    const done = () => document.documentElement.classList.add('pv-ready');
    Promise.resolve(document.fonts?.ready).then(() => setTimeout(done, 80));
    setTimeout(done, 2000);
  }
  window.addEventListener('hashchange', render);
  window.addEventListener('storage', (ev) => { if (ev.key === KEY) { st = Object.assign(st, load()); if (document.activeElement !== input) showMin(); render(); } });
})();
