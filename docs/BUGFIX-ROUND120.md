# BUGFIX-ROUND120 — هشت اصلاحیهٔ کاربر (v1.9.75)

هشت درخواست کاربر در یک راند: پنل فلوت در مولتی‌چارت، کراس‌هیر بین نمادهای متفاوت، تأخیر Total، تطابق هیستوری با متاتریدر، تایم‌زون ساعات معاملات، تفکیک کامل Demo/Live، تیکت واحد Trading و نمایش Partial Exit مثل متاتریدر.

## ۱) پنل فلوت = یک پنل برای هر نماد (`trade/oneclick.js`)
- **Designation rule**: ابزارک هنوز per-pane ساخته می‌شود، اما فقط **اولین چارتی که نماد را دارد** (`App.panes.find(p => p.symbol === sym) === pane`) پنل را نشان می‌دهد — دو چارت طلا = یک پنل؛ طلا + یورو = یک پنل برای هر نماد.
- **موقعیت per-symbol**: نقشهٔ موقعیت‌ها زیر `mt5_oct_pos_map` (`{[symbol]: {fx,fy}}`) ذخیره می‌شود؛ کلید قدیمی `mt5_oct_pos` به‌عنوان fallback مهاجرت می‌ماند. درگِ پنلِ یک نماد هرگز پنل نماد دیگری را جابه‌جا نمی‌کند (`_dragMove` فقط `_position(st)` خودش را صدا می‌زند) و `_dragUp` زیر کلید همان نماد ذخیره می‌کند.
- **سوییچ multi ↔ single**: designation در **هر تیک ۲۰۰ms** دوباره محاسبه می‌شود؛ پنل هرگز حذف نمی‌شود — در سینگل همیشه هست، در بازگشت به مولتی دوباره روی چارتِ منتخبِ همان نماد، در همان موقعیت ذخیره‌شده ظاهر می‌شود. پن‌های non-designated از تیک سنگین خارج می‌شوند (صرفه‌جویی CPU) و درفت‌های آن‌ها لغو می‌شود.

## ۲) کراس‌هیر بین نمادهای متفاوت (`core/state.js` + `chart/toolbar.js` + `chart/manager.js`)
- توگل جدید **«Crosshair on different symbols»** (`App.sync.crossX`، پیش‌فرض خاموش) در منوی Layout → SYNC IN LAYOUT، زیر توگل Crosshair.
- **گیت per-destination** (`crossSyncOk`): پن هم‌نماد با مبدأ → توگل Crosshair قبلی؛ پن با نماد متفاوت → فقط crossX. `syncCrossMove`/`syncCrossClear` هر مقصد را از این گیت رد می‌کنند و سابسکریپشن LWC با «هر کدام روشن بود» اجرا می‌شود (رفتار قبلی برای هم‌نمادها دست‌نخورده).

## ۳) رفع تأخیر Total (`trade/dock.js`)
- نوار Total تب Positions قبلاً فقط هنگام re-render (۱.۲s) محاسبه می‌شد. حالا هوک‌های `data-role="rollup"` / `data-sum="volume|swap|profit"` روی سلول‌ها می‌نشینند و `_updateTotalLive` در همان پاس ۶۰۰ms `_updateLive` رول‌آپ + جمع Volume/Swap/Floating را از `TradeRoute.positions()` + `profitOf` بازنویسی می‌کند — هماهنگ با سلول‌های ردیف‌ها. (پنل فلوت از قبل در تیک ۲۰۰ms زنده بود.)

## ۴) هیستوری = هیستوری متاتریدر (`provider/mt5.py` + `trade/dock.js`)
- **شیفت بازه به مبناي بروکر**: زمانِ dealها broker-stamp است و باندِ کلاینت device-wall — مرزها با `current_off()` به پایهٔ بروکر می‌روند؛ پنجره حالا همان چیزی را برمی‌دارد که ترمینال برمی‌دارد.
- **بک‌فیل IN مفقود**: معامله‌ای که قبل از بازه باز و داخل آن بسته شده بود بدون IN برمی‌گشت و گروه کامل حذف می‌شد → شمارش از متاتریدر کمتر بود. حالا هر position_id بدون IN با `history_deals_get(position=pid)` (بounded 400) کامل می‌شود.
- **DEAL_ENTRY_INOUT (2) و OUT_BY (3)** به‌عنوان deal بسته‌شده شمرده می‌شوند (قبلاً فقط entry=1 — close-by/revaluation حذف می‌شدند).

## ۵) ساعات معاملات با تایم‌زون اپ (`core/timezone.js` + `trade/dock.js` + `trade/history.js`)
- هلپر جدید **`TZ.partsNum(tz, chartSec)`**: اجزای عددی y/m/d + h/m/s از همان فانل چارت (stamp → true UTC → zone).
- `_fmtT`/`_fmtT5` داک و hover چارت (`history.js`) از `TZ.partsNum(App.tz, …)` می‌خوانند — ساعت Positions/Orders/History دقیقاً با محور چارت یکی است.
- چِیپ **«Today»** از نیمه‌شبِ تایم‌زون اپ روی پایهٔ چارت محاسبه و به‌صورت true-UTC به پرووایدر می‌رود.

## ۶) تفکیک کامل Demo/Live + انتقال هیستوری دمو به ToolBox (`trade/route.js` + `trade/dock.js` + `trade/replaytrade.js`)
- facade های جدید: **`TradeRoute.history(from,to)`** (دمو → لجرِ دمو سنتزشده به شکل deal؛ لایو → بریج) و **`TradeRoute.closeAll(symbol)`**.
- تب History داک حساب **فعال** را نشان می‌دهد؛ کش per-account (`_dealsMode`) و در تغییر مود پاک می‌شود — هیستوری دمو از پنل Trading حذف و به ToolBox منتقل شد.
- دکمهٔ Close all (و کل نوار حساب) از `TradeRoute` می‌خواند — هرگز حساب مقابل را نمی‌بندد.
- پنل دموی قدیمی (فرم Market/Pending + تب‌های Positions/Orders/History/Cash) حذف شد؛ بخش دمویی باقی‌مانده: تنظیمات حساب (گیر) + دفتر نقدی (`#tr-demo-extra`) + خط وضعیت منبع قیمت.

## ۷) تیکت واحد Trading — Demo و Real یکی (`trade/ticket.js` + `index.html`)
- **یک عنصر تیکت** (`#trade-ticket`) هر دو حالت را سرو می‌کند؛ `TradeRoute._paintUI` آن را روی هر سوییچ بین `#tr-live` و `#tr-demo` جابه‌جا می‌کند. ساختار/ظاهر دو مود یکسان است؛ فقط سوییچ و چیپ مود (LIVE آبی / DEMO نارنجی، `.tt-modechip`) تفاوت دارد.
- مسیرها mode-aware شدند: نوار حساب از `TradeRoute.account()/equity()`، کوت‌ها از `TradeRoute.quote()`، ارسال از `TradeRoute.sendOrder()` با گیت `canTrade()` (AutoTrading لایو + available دمو) — و `typeTime/expiration` به مسیر لایو پاس می‌خورد.
- در دمو، گزینهٔ **Stop-Limit** مخفی می‌شود (موتور دمو نوع ۶/۷ را شبیه‌سازی نمی‌کند).

## ۸) Partial Exit دقیقاً مثل متاتریدر (`trade/dock.js` + `trade/replaytrade.js`)
- **گرید History = نمای deal ترمینال**: هر dealِ بستن یک ردیف است (`_histRows`) — پوزیشن ۱.۰ لات که ۰.۴ و ۰.۶ بسته شده **دو ردیف** با زمان/قیمت/حجم/سود خودش می‌گیرد (tooltip: partial close i/n). کارمزد/فی/سواپِ IN روی **اولین** فرگمنت می‌نشیند تا جمع ردیف‌ها = جمع پوزیشن.
- خلاصهٔ شمارش (trades/win%/net) **per position** می‌ماند — همان تعریف «یک معامله» در ترمینال.
- **دمو**: رکورد بستن حالا `otime` (زمان باز) + `vol0` (حجم پیش از بستن) + SL/TP لحظهٔ بستن را نگه می‌دارد و `demoDeals()` آن را به شکل deal بریج سنتز می‌کند (reason: sl→4 / tp→5) — پس گرید و چارت دمو هم همان نمای فرگمنتی را دارند.
- **چارت**: لایهٔ هیستوری حالا از `TradeRoute.history` می‌خواند (قبلاً فقط لایو) — یک کانکتور به‌ازای هر فرگمنت بسته‌شده، برای هر دو حساب؛ زمان‌های hover با تایم‌زون اپ.

## Tests
- `scripts/test_round120_fixes.mjs` (۴۷ بررسی): قراردادهای سورس هر هشت اصلاحیه + آینه‌های رفتاری (اقتصاد فرگمنت: جمع ردیف‌ها = جمع پوزیشن؛ گیت کراس‌هیر same/different).
- سوییپ کامل: هر ۱۶ سویییت mjs (۱۰۲ تا ۱۱۹) سبز — قراردادهای ساختاری راندهای ۱۰۸/۱۰۹/۱۱۲/۱۱۷ که این راند عمداً تغییرشان داده بود، به رفتار تازه ارتقا یافتند (روال همیشگی هر راند).
- `node --check` روی همهٔ ماژول‌های تغییر کرده + `ast.parse` روی `provider/mt5.py`.
- e2eهای پایتونی (rround112/119 و…) به بروکر زنده نیاز دارند و در این محیط قابل اجرا نبودند؛ `repro_round112_modes.py` به سلکتورهای پنل قدیمی دمو ارجاع می‌دهد و آرشیوی تلقی می‌شود (تست ساختار جایگزین شده در سویییت mjs راند ۱۱۲).
