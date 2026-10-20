# BUGFIX-ROUND24.md — سند نگهداشت راند 24 (نسخه 0.9.18 / package 1.2.9)

این سند مرجع دقیق نگهداشت برای ۱۴ باگ `BUG-REPORT.md` + دو ممیزی الزامی (AUD-001 / OVF-001) است.
برای هر آیتم: **ریشه → تغییر دقیق (فایل/تابع) → نقاط اتصال که در به‌روزرسانی‌های بعدی نباید شکسته شوند → تست تأییدشده.**
قواعد سراسری رعایت‌شده: رنگ‌ها فقط از توکن تم (§9.2/§3.4) · UI انگلیسی‌فقط · پچ vendor صفر (نسخه LWC قفل 4.2.3) · هیچ کلید localStorage تغییر/حذف نشد · کلیدهای جدید: هیچ.

---

## BUG-007 — محور قیمت ثابت ~1.99998 (بحرانی) ✅
- **ریشه:** (۱) payload غیرمعتبر (non-finite OHLC / تایم تکراری) باعث خطای `series.setData` می‌شد و داده قدیمی نماد قبلی روی محور می‌ماند در حالی که لجند از `pane.bars` جدید می‌خواند؛ (۲) پنجره زوم عمیق `pane.pz` (نوشته‌شده توسط درگ محور قیمت در `Engine.priceZoom`) با سوییچ نماد ریست نمی‌شد و `autoscaleInfoProvider` بازه منجمد (~2.0) برمی‌گرداند → همه تیک‌ها 1.99998.
- **تغییرات — `js/chart/manager.js`:**
  - `sanitizeBars(bars, symbol, tfId)` (خط ~233): حذف non-finite، fold تایم تکراری در بار قبلی، drop نزولی‌ها (بدون بازترتیب). Export: `Manager.sanitizeBars`.
  - `loadBars()`: `bars = sanitizeBars(...)` قبل از setPaneData → ریست `pane.pz = {active:false,...}` → try/catch با retry → `pane.bars = bars` فقط بعد از پذیرش setData → probe `[data-guard]` (هشدار کنسول در واگرایی series/legend).
- **نقاط اتصال برای آینده:** هر مسیر داده جدید (Compare جدید، import، …) باید از `sanitizeBars` بگذرد؛ هر کد جدیدی که `pane.pz` می‌نویسد باید با loadBars ریست شود؛ probe `[data-guard]` را در لاگ‌ها جدی بگیرید.
- **تست:** `tests/unit/test_bug007.py` (15/15) — بازتولید پنجره کهنه، سوییچ نماد/TF، sanitize unit، درگ محور + دابل‌کلیک ریست (Round-14). اسکرین‌شات: `bug007-before/after`.

## BUG-002 — گام غیر یکنواخت محور زمان ✅
- **ریشه (در vendor LWC 4.2.3، بدون پچ):** تیک‌های نیتیو ایندکس‌محورند با gap=ceil(9.375×8/barSpacing) و **هر مرز روز اجرا را ریست می‌کنند**؛ منطقه آینده اصلاً تیک ندارد (لایه قبلی tax-ext گام ثابت 46px می‌کشید) → سه گام مختلف.
- **تغییرات:**
  - `chart/manager.js` → `chartTimeScaleOpts()`: `tickMarkFormatter: () => ''` (حذف متن نیتیو؛ bubble کراسهیر از `timeFormatter` مستقل است و دست نخورده) + `grid.vertLines.visible:false`.
  - `drawing/engine.js` → `_updateTaxExt(v)` بازنویسی کامل: انتخاب کادنس از نردبان `[1,2,5,10,15,30,60,…,43200]` → `[1,2,3,4,6,7,14,21,28]روز` → `[1,2,3,6,12,24,60,120]ماه` با شرط `c≥tfSec` و `c×(barSpacing/tfSec)≥46px`؛ snap/step در پایه سرور (multiples، انکر هفته `wi=di-((di+4)%7)`، شروع ماه) — همان انکرهای `bucketStartFor`؛ لیبل با `TZ.tickLabel/parts` + رول‌اور روز/ماه/سال؛ گارد لبه (هیچ لیبلی کلیپ نمی‌شود) و همپوشانی؛ لیبل زنده کندل آخر حفظ شده (round-23)؛ کش با کلید `[n,lastT,lr,pw,axisW,timeH,cad,kind,tz,off,tfSec,dow]`. موقعیت‌ها در `this._taxGrid` ذخیره و در `render()` به‌صورت خطوط گرید عمودی رسم می‌شوند (اول از همه، زیر سارنده‌های دوره‌ای و رسم‌ها).
  - `chart/settings.js` → `applyPane()`: `vertLines.visible:false` ثابت (سوییچ «Vertical grid lines» تب Canvas حالا نقاش engine را کنترل می‌کند — `Engine.render` هر فریم `S.vGrid/S.gridColor` را می‌خواند).
- **نقاط اتصال:** هر کدی که لیبل/گرید زمان اضافه می‌کند باید داخل همین معماری برود؛ سوییچ vGrid/hGrid و رنگ گرید از تنظیمات؛ اگر روزی vendor ارتقا یافت، `tickMarkFormatter:''` باید دوباره ارزیابی شود.
- **تست:** `test_bug002_003.py` (18/18) — یکنواختی در سه زوم، لیبل آینده، بدون کلیپ، تراز گرید/لیبل، سوییچ TZ؛ `test_bug002_dwm.py` (8/8) — D1/W1/MN.

## BUG-003 — ساعت نوار پایین (تهران) ✅
- **ریشه:** `TZ.nowLabel` خروجی `Date.now()` (UTC واقعی) را مستقیم به `TZ.parts` می‌داد که ورودی را «stamp سرور» فرض و `serverOff` دوباره کم می‌کرد → با بروکر GMT+3 دقیقاً ۳ ساعت عقب.
- **تغییرات — `core/timezone.js`:** `TZ.partsUtc(tz, utcSec)` = `TZ.parts(tz, utcSec + off)` (یک مسیر برای «الان»)؛ `TZ.nowLabel` = `Math.floor(Date.now()/1000)` → `partsUtc` (floor قبل از ورود، چون `toUtc` گرد می‌کند). لنگر سرور (ری‌مِژ offset هر 30s از provider) دست‌نخورده.
- **نقاط اتصال:** هر فرمت «الان» جدید باید از `partsUtc` برود؛ انواری ساعت==لیبل دقیقه جاری حفظ شود.
- **تست:** `test_bug002_003.py` چک 10-16 (off=0 و off=3h با stub شدن `_setOff`).

## BUG-004 + BUG-013 — واتچ‌لیست Last/Spread + سینک زنده ✅
- **ریشه‌ها:** (۱) `subscribe`های boot (سوکت بسته) بی‌صدا drop می‌شدند؛ (۲) `Manager.tickBA` export نشده؛ (۳) demo.py bid/ask نمی‌فرستاد؛ (۴) چرخه حیات پنل وجود نداشت.
- **تغییرات:**
  - `core/feed.js`: صف `this._pendingSubs` — `subscribe/unsubscribe` وقتی سوکت نیست صف/حذف می‌شوند؛ `ws.onopen` صف را فلش می‌کند.
  - `chart/manager.js`: export های `Manager.acquireSub/releaseSub` (شمارش مرجع مشترک چارت+پنل)، `Manager.tickBA`، `Manager.lastTickAt`.
  - `panels/watchlist.js`: `Watchlist.setPanelOpen(open)` (باز→acquire همه، بسته→release)؛ حذف subscribe-all بی‌شرط از init؛ `onTick(symbol, price, time, vol, bid, ask)` → `Watchlist.ba` + `_lastTickAt`؛ `updateRow`: Spread=ask−bid به digits، dash با tooltip «bid/ask not available from the provider»، stale>30s → کلاس `.stale` + tooltip «no ticks — market closed»؛ add/remove هنگام باز بودن پنل acquire/release.
  - `app.js`: `RightPanelShowTab/Close` → `Watchlist.setPanelOpen(tab==='watchlist' / false)`.
  - `provider/demo.py`: `next_tick` ← `(px, vol, epoch, bid, ask)` با spread=max(12×point، 1bp)؛ نسخه `--off` هم bid/ask را پاس می‌دهد. `provider/mt5.py` از قبل داشت (بدون تغییر).
  - `css/panels.css`: `.wl-price.stale, .wl-sprd.stale { opacity:.42 }`.
- **نقاط اتصال:** F-08 (rAF/400ms dirty renderer، اولویت نماد فعال) دست‌نخورده؛ click-row فقط چارت را عوض می‌کند (refcount از قطع داده ردیف جلوگیری می‌کند)؛ پایگانه عضویت `mt5_watchlist` unchanged.
- **تست:** `test_bug004_013.py` (13/13).

## BUG-005 + BUG-010 + OVF-001 — برازش overlayها ✅
- **ابزار واحد — `core/util.js` → `U.fitPopup(el, anchorTop, anchorBottom, {topSafe=44, margin=12})`:** پایین ترجیح؛ flip-up اگر `above>below>140`؛ در هر حال `max-height=فضای موجود`؛ `top` clamp؛ بازگشت placement.
- **اتصال‌ها:** `drawing/ui.js openFlyout` (بعد از ساخت tiles) + `chart/toolbar.js popupAt` (بعد از clamp افقی)؛ هر دو با resize→close (شنونده در closeFlyout/closePopup پاک می‌شود).
- **BUG-010 ساختار flex:** `css/app.css`: `.lay-picker{display:flex;flex-direction:column}`؛ `.lay-scroll{flex:1 1 auto;min-height:60px;overflow-y:auto}` (سقف ثابت 58vh حذف شد)؛ بخش LAYOUTS داخل `.lay-layouts{flex:0 1 auto;min-height:44px;overflow-y:auto}` (ساخته‌شده در `toolbar.js openLayoutMenu`) → SYNC همیشه کامل، Save همیشه در دسترس.
- **نکته:** گروه‌های تک‌ابزاری (measure/zoom) طبق کد موجود مستقیم فعال می‌شوند و flyout ندارند.
- **مستند ممیزی:** `docs/OVERLAY-FIT-AUDIT.md` (۱۷ سطح × ۲ تم × ۱۲۸۰×۷۲۰/۱۳۶۶×۷۶۸). **تست:** `test_bug005_010.py` (8/8 در 1280×720 + پنجره 600px).

## BUG-006 — ادغام Patterns در Gann & Elliott ✅
- **تغییر — `drawing/ui.js` GROUPS:** سکشن `{title:'Pattern', tools:['xabcd','abcd','cypher','trianglepat','threedrives','hs']}` به گروه `gannelliott` اضافه و گروه `patterns` کامل حذف شد (دکمه + caret + hit-area با آن).
- **چرا امن است:** `toolsOf()` با sections کار می‌کند → Round-21 (آیکون گروه=آخرین ابزار) خودکار؛ سرستون‌ها `.lt-flysec` با `text-transform:uppercase` → PATTERN دقیقاً هم‌استایل؛ قالب‌ها/تنظیمات per-type (`mt5_tool_last_<type>`, Round 14) وابسته به گروه نیستند؛ favorites با tool id؛ Object Tree گروه‌بندی type-محور (دست‌نخورده)؛ کلیدهای یتیم احتمالی: `groupState` در-memory است و خودش می‌پزد.
- **تست:** `test_bug006.py` (8/8) — بدون دکمه، سه سکشن دقیق، بدون duplicate/loss، رسم+حذف XABCD، favorites.

## BUG-008 — Snapshot ✅
- **تغییرات — `chart/toolbar.js`:**
  - `Manager.getSnapshotPalette(mode?)`: پالت کامل از تم فعال؛ رنگ‌های کاربر فقط برای تم فعال خوانده می‌شوند و برای probe تم دیگر `Theme.chartDefaults` — unit-testable.
  - `snapPaneInto(..., pal, stampLogo)`: پس‌زمینه (تکی/گرادیانی از bg1/bg2 — screen parity)؛ واترمارک با `pal.dim`؛ **کشیدن spanهای `.tax-ext` 1:1** (لیبل‌های محور زمان که پس از BUG-002 در DOM زندگی می‌کنند)؛ legend با `pal.text/up/down`؛ لوگو 48px، inset 16px، پایین-چپ داخل پلات، یک‌بار (آخرین pane).
  - `Snapshot.capture()`: fill واحد + قاب 1px با `pal.frame`؛ لوگوها preloaded (بدون شبکه).
  - `core/theme.js`: `Theme.chartDefaults(mode)` (کپی CHART_DEFAULTS).
- **نقاط اتصال:** لیبل‌های زمان snapshot از همان `.tax-ext` می‌آیند — اگر BUG-002 را تغییر دادید، snapshot خودش پیروی می‌کند؛ رنگ هاردکد در compositor ممنوع (فقط از `getSnapshotPalette`).
- **تست:** `test_bug008.py` (9/9) — pixel-probe قاب/لیبل محور/لوگو در هر دو تم + گوشه لایت + Download==Copy. نمونه خروجی: `download/bug008-snapshot-dark.png` / `-light.png`.

## BUG-014 — ریست Template Default ✅
- **ریشه:** اولین آپشن سلکت همان «Default» بود → انتخابش change نمی‌داد (هیچ‌وقت اجرا نمی‌شد).
- **تغییرات — `chart/settings.js`:** placeholder `'—' (value='__pick')` انتخاب اول؛ هندلر Default → `themeAwareDefaults()` = clone کامل `Settings.DEFAULTS` + `Object.assign` با `Theme.chartDefaults(تم فعال)` (لایت → رنگ کارخانه لایت) → `persist()+applyAll()`؛ گارد پوشش: `Settings.set` برای کلید بی‌دیفالت `console.warn('[settings] … BUG-014 guard')` می‌دهد.
- **دست‌نخورده:** save-as/apply/delete نام‌دار، قالب‌های per-tool، snapshot/Cancel، کلید `mt5_settings`/`mt5_st_tpl`.
- **تست:** `test_bug014.py` (10/10) — ریست همه گروه‌ها، persist، apply فوری، لایت، named، Cancel، گارد بی‌صدا.

## BUG-009 + AUD-001 — تم ✅
- **فیکس‌ها (جزئیات کامل + جدول استثناها در `docs/THEME-AUDIT.md`):** `#ctx-toolbar`/`#fav-float`/`#replay-bar`/`.pl-txt`/`.tv-typing` → `var(--panel)`؛ سایه لایت برای ctx/fav؛ سرچ هشدار → کلاس `.al-search` توکن‌دار (جای inline dark)؛ پیش‌نمایش خطوط (`ui.js`/`drawing/settings.js`) → `U.th('text')`؛ سارنده دوره‌ای → توکن `Theme.c('periodSep')`؛ چیپ ابزار (`tools.js`) → `Theme.c('chipBg')`؛ helper `U.th(key, fallback)` در util.js.
- **تست:** `test_aud001_bug009.py` (8/8) — چرخه دارک→لایت→دارک با computed-style token match.

## BUG-001 — لاگین دوستونه ✅
- **تغییرات:** `index.html` — محتوا به `.login-logo.login-brand-col` (لوگو/نام/تگ‌لاین) + `.login-form-col` (هر ۱۲ کنترل با همان ID و ترتیب) تقسیم شد؛ **login.js صفر خط تغییر.** `css/app.css` — `#login-screen{overflow:hidden}` (اسکرول صفحه‌ای هرگز)؛ `@media (min-width:960px) and (min-height:600px)`: کارت flex-row با برندینگ چپ 42% (radial gradient، غیرتعاملی با `pointer-events:none`) و فرم راست `overflow-y:auto` (تنها اسکرول)؛ زیرBreakpoint تک‌ستونه فشرده قبلی؛ `#saved-accounts{max-height:138px;overflow-y:auto}` (~۳ چیپ).
- **نقاط اتصال:** هر state جدید لاگین (logout/failed/add-another) داخل `.login-form-col` رندر می‌شود چون IDها همان‌اند.
- **تست:** `test_bug001_011_012.py` (13/13) — دوستونه 1366×768، تک‌ستونه 860px و ارتفاع<600، بدون اسکرول صفحه، همه IDها، لاگین demo کارا.

## BUG-011 — لیبل قیمت/تایمر ✅
- **تغییرات:** `manager.js fmtRemain` → همیشه `mm:ss` صفرپر (`h:mm:ss` بعد از 1h)؛ `null` برای D1/W1/MN → لیبل تایمر کاملاً حذف؛ `updateCountdown` → hide وقتی بازار بسته (تیک >180s قدیمی)؛ bg لیبل = رنگ سری (up/down یا آبی خطی)؛ `top = y+10` چسبیده زیر لیبل نیتیو قیمت (بدون قیمت تکراری). `css/app.css .cd-label` → فونت 9.5px (~75%)، radius بالا-صفر (ادامه همان باکس).
- **نقاط اتصال:** محاسبه شمارش معکوس (Round 10، lنگر سرور) دست‌نخورده — فقط presentation عوض شد؛ snapshot از لیبل‌های canvas می‌گیرد و لیبل یکپارچه روی تصویر می‌افتد.
- **تست:** `test_bug001_011_012.py` چک 9-11 (فرمت/رنگ/حذف در D1).

## BUG-012 — واترمارک برند ✅
- **تغییرات:** `drawing/engine.js render()` — کنار جای‌گذاری واترمارک نماد، `pane.brand.style.bottom = (timeH اندازه‌گیری‌شده + 8)px` (هم‌سطح inset افقی 8px)، cache با کلید `th`؛ fallback CSS `bottom:34px`.
- **تست:** `test_bug001_011_012.py` چک 12 — gap==8px دقیق.

---

## رگرسیون نهایی راند 24
هر ۱۰ سوئیت سبز: **۱۱۰ چک PASS، صفر خطای کنسول** (فهرست و آمار در CHANGELOG 0.9.18).
مجموعه تست در `scripts/` کنار پروژه — اجرا: `python3 scripts/test_bugXXX.py` (هر سوئیت provider DEMO خودش را بالا می‌آورد؛ قبل از اجرا مطمئن شوید provider دیگری روی پورت 8777 نیست: `pkill -f provider/demo.py`).

## یادداشت برای راندهای بعدی
1. vendor LWC هنوز 4.2.3 قفل است — این راند **هیچ پچ vendor** داشت (BUG-002/008 هر دو app-level حل شدند).
2. «مالکیت» نوار زمان حالا با Engine است (لیبل+گرید) — هر ویژگی زمان-محور جدید به `_updateTaxExt`/`render` اضافه شود، نه به tickMarkFormatter.
3. «مالکیت» سابسکرایب‌ها با refcount مشترک (Manager.acquire/release + صف feed) است — subscribe/unsubscribe مستقیم feed در کد جدید ممنوع.
4. رنگ جدید در JS/CSS = ابتدا توکن (Theme.c/U.th/CSS var) — استثناها فقط با سطر در THEME-AUDIT.md.
5. هر کلید تنظیمات جدید = ابتدا سطر در `Settings.DEFAULTS` (وگرنه گارد BUG-014 هشدار می‌دهد و Default آن را ریست نمی‌کند).
