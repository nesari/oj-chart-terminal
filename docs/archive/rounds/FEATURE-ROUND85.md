# FEATURE-ROUND85 — ماژول معامله‌گری کامل (ارسال معاملات به متاتریدر + مدیریت ریسک و مدیریت لایو)

> درخواست صریح کاربر: «می‌خوام یک بخش ارسال معاملات از اپ خودمون به متاتریدر درست کنی… یک سیستم مدیریت ریسک و حجم و همچنین مدیریت معاملات بصورت لایو… نمایش نقطه ورود و استاپ و تارگت روی چارت و قابلیت جابجایی و مدیریت نقاط استاپ و تی‌پی روی خود چارت. امکان اوردر گذاری به همه ی روش های ممکن و یک بخش برای نمایش معاملات، بالانس و هیستوری… داکیومنت متاتریدر توی این بخش رو مطالعه کن. پنل‌ها کاملا داینامیک و user friendly.»

محدوده: فقط زیرساخت معامله‌گری و نقاط اتصال آن. هیچ بخش دیگری از اپ تغییر معنایی نکرده است (فهرست فایل‌های تغییر کرده در انتها).

## 1. معماری و پروتکل (مطالعه‌شده از مستندات رسمی MetaTrader5 Python)

مسیر داده: `renderer (Feed WS)` → `provider_common.Broker.handler` → `trade_rpc()` هوک → در حالت MT5 پل واقعی `MetaTrader5` (mt5.py) و در حالت Demo بروکر شبیه‌سازی‌شده (demo.py).

- پیام جدید `{'type':'trade', 'op':…, …}` با پاسخ `{'type':'trade', req_id, op, ok, data|error}` — قانون راند ۳۶: پاسخ **همیشه** ارسال می‌شود (حتی روی exception).
- opهای پیاده‌سازی‌شده (هر دو پروایدر، قرارداد سیمی یکسان):
  - `account` — account_info (balance/equity/profit/margin/margin_free/margin_level/leverage/currency/trade_allowed)
  - `spec` — مشخصات نماد: digits, point, contract, **tick_value/tick_size** (فرمول رسمی سود), vol_min/max/step, **stops_level/freeze_level**, filling_mask, bid/ask, spread
  - `order_send` — مارکت (TRADE_ACTION_DEAL) و تمام ۶ نوع پندینگ (TRADE_ACTION_PENDING): BUY/SELL LIMIT/STOP/STOP-LIMIT + انقضا (GTC/DAY/SPECIFIED) + deviation + comment + magic
  - `close` — بستن کامل یا جزئی (TRADE_ACTION_DEAL با `position=ticket`، حجم دلخواه)
  - `close_all` — بستن همه (با فیلتر نماد اختیاری)
  - `modify_sltp` — TRADE_ACTION_SLTP روی پوزیشن
  - `order_modify` — TRADE_ACTION_MODIFY (قیمت/SL/TP/انقضای اوردر پندینگ)
  - `order_cancel` — TRADE_ACTION_REMOVE
  - `positions` / `orders` / `history` — جداول زنده و تاریخچه دیل‌ها (+ خلاصه)
  - `state` — حساب + پوزیشن‌ها + اوردرها در **یک** رفت‌وبرگشت (poll 1.2s کلاینت)
- جزئیات مستندمحور در mt5.py: retcodeهای 10004–10044 به متن فارسی‌ازداده‌شده‌ی انگلیسی نگاشت شدند؛ `type_filling` از ماسک `symbol_info().filling_mode` (FOK=1/IOC=2) انتخاب و روی retcode **10030** یک‌بار با حالت جایگزین retry می‌شود؛ تاریخچه با datetime **tz-aware UTC** (تله‌ی همان نسخه‌ی `_tick_bars_span`)؛ `trade_allowed` ترمینال در `state` برمی‌گردد تا پیام‌های 10026/10027 (Algo Trading خاموش) قابل تشخیص باشد.

## 2. فایل‌های جدید

| فایل | نقش |
|---|---|
| `src/renderer/js/trade/state.js` | هسته: RPC روی Feed، poll هر 1.2s (`state`)، کش spec با TTL 60s، P/L لایو بین pollها از جریان تیک با فرمول MT5 `(Δ/tick_size)×tick_value×volume`، محاسبه لات از ریسک (`lotForRisk`)، clamp حجم به step/min/max، subscribe یک‌باره‌ی نمادهای پوزیشن‌ها |
| `src/renderer/js/trade/ticket.js` | تب «Trading» پنل راست: نوار حساب لایو، Volume + چیپ‌های step، SL/TP با ۴ حالت ورودی (Price / Points / Money / **Risk %** برای SL؛ Price / Points / Money / **R:R** برای TP) با نمایش زنده‌ی قیمت و پولِ ریسک/ریوارد، دکمه‌ی **Auto lot** (حجم از فاصله‌ی SL + هدف ریسک)، Market/Limit/Stop/Stop-Limit + انقضا + deviation + کامنت، **One-click trading**، دکمه‌های SELL/BUY با قیمت زنده و اسپرد، pre-check فاصله‌ی استاپ‌ها (minPts) مطابق معناشناسی MT5 |
| `src/renderer/js/trade/dock.js` | داک پایین: نوار حساب زنده (Balance/Equity/Floating P/L/Margin/Free/Level + نشانگر live) و سه تب Positions/Orders/History؛ مدیریت کامل: ویرایشگر inline SL/TP، بستن ۵۰٪، بستن کامل، Close all، ویرایش قیمت/SL/TP اوردر پندینگ، لغو اوردر؛ هیستوری با بازه‌های Today/3D/Week/Month/All و گروه‌بندی دیل‌ها بر اساس position_id + خلاصه (تعداد/وین‌ریت/net/best/worst)؛ dock قابل جمع‌شدن و تغییر ارتفاع (persist) |
| `src/renderer/js/trade/overlay.js` | خطوط معامله روی چارت هر pane (فقط نماد همان چارت): Entry (آبی، عنوان زنده با P/L)، SL (قرمز)، TP (سبز)، اوردر پندینگ (نارنجی) با لیبل محور قیمت؛ **درگ عمودی** خطوط SL/TP و قیمتِ اوردر پندینگ → ارسال modify (hit-test 8px، قطع موقت handleScroll/handleScale، چیپ قیمت هنگام درگ، snap-back روی خطا)؛ sync ساختاری هر 700ms + رویداد onChange؛ بدون هیچ تغییری در manager.js (WeakMap به ازای pane) |
| `src/renderer/css/trade.css` | استایل کامل سه ماژول بالا فقط با متغیرهای تم (دارک/لایت هر دو) |

## 3. نقاط اتصال (تغییرات حداقلی در فایل‌های موجود)

- `provider/provider_common.py`: شاخه‌ی `trade` در handler + هوک پایه‌ی `trade_rpc` (پاسخ همیشه).
- `provider/mt5.py`: `trade_rpc` کامل با پکیج MetaTrader5 (بخش ۱).
- `provider/demo.py`: بروکر شبیه‌سازی: حساب $10,000/لوریج 100، پرچ spread واقعی demo، اجرای مارکت روی Bid/Ask، تریگر پندینگ‌ها (buy-side روی ASK، sell-side روی BID)، اجرای SL/TP به ازای هر تیک + حلقه‌ی مستقل (`loops`) تا پوزیشن‌ها حتی بدون چارت باز هم مدیریت شوند، مارجین/اکوییتی لایو، دیل‌های IN/OUT و هیستوری با خلاصه. قرارداد سیمی عیناً برابر mt5.py است (تست‌پذیری کامل روی هر ماشین).
- `src/renderer/index.html`: لینک `css/trade.css`، تب راست جدید `tab-trade` + آیکن ریل (`orderDoc`)، کانتینر `#trade-dock` بین `#main` و فوتر.
- `src/renderer/js/app.js`: ایمپورت/بوت چهار ماژول + **override**ی `Toolbar.openOrderTicket` → منوی (+) محور قیمت («Buy limit / Sell stop / Add order…») حالا تیکت **واقعی** را با قیمت/نوع پیش‌پرشده باز می‌کند (stub قدیمی demo در toolbar.js دست‌نخورده ماند و عملاً بازنویسی می‌شود) + expose در `window.__app`.

## 4. رفتارهای داینامیک/User-friendly

- همه‌ی پنل‌ها state دار و persist هستند (حجم، حالت‌های SL/TP، درصد ریسک، one-click، deviation، نوع اوردر، تب/ارتفاع/نمایانی داک، بازه‌ی هیستوری — کلیدهای `mt5_tr_*`).
- P/L پوزیشن‌ها و Equity بین pollها هم با هر تیک بازمحاسبه می‌شوند (بدون پشت‌سرهم‌کاری با poll سرور).
- ویرایشگرهای inline در برابر poll بازسازی نمی‌شوند (data-editing guard) — ورودی کاربر وسط ویرایش پاک نمی‌شود.
- خطاها همیشه به کاربر می‌رسند: toast + خط وضعیت تیکت با متن retcode (از جمله راهنمای «Algo Trading» برای 10026/10027).
- چند-چارت: خطوط فقط روی چارتِ هم‌نماد؛ تیکت با «Follow chart» نماد چارت فعال را دنبال می‌کند و از منوی (+) روی نماد همان چارت قفل می‌شود.

## 5. تست‌ها

- `scripts/test_trade_rpc.py` — e2e روی WS واقعی با demo.py: **۲۷/۲۷ PASS** (bars-regression، state، spec، مارکت+SL/TP، 10016 برای استاپ نزدیک، modify_sltp، پندینگ/modify/cancel، بستن جزئی/کامل، close_all، history+summary، عملیات نامعتبر).
- `scripts/test_trade_math.mjs` — فرمول‌های کلاینت: **۲۱/۲۱ PASS** (سود Long/Short با Bid/Ask درست، riskMoney، lotForRisk با گرد شدن به step، clamp، equity زنده، spreadPts، فیلدهای spec).
- Smoke test مرورگر واقعی (headless، demo provider زنده): اتصال → ثبت مارکت BUY با SL/TP → خطوط SL/TP/Entry روی چارت با لیبل محور → ویرایش inline SL/TP → **درگ خط SL روی چارت** (SL از 1.08300 به 1.07999 روی سرور ثبت شد) → بستن ۵۰٪ → ثبت BUY LIMIT با SL/TP → لغو → بستن کامل → هیستوری با خلاصه → منوی (+) به تیکت واقعی. همه PASS.
- `node --check` روی تمام فایل‌های JS (شامل ۵۴ فایل قبلی) و `py_compile` روی providerها.

## 6. فایل‌های تغییر یافته / افزوده

- جدید: `src/renderer/js/trade/{state,ticket,dock,overlay}.js`، `src/renderer/css/trade.css`، `docs/archive/rounds/FEATURE-ROUND85.md`، `scripts/test_trade_rpc.py`، `scripts/test_trade_math.mjs`
- ویرایش: `provider/provider_common.py`، `provider/mt5.py`، `provider/demo.py`، `src/renderer/index.html`، `src/renderer/js/app.js`، `package.json` (1.9.35 → 1.9.36)، `CHANGELOG.md`

نسخه: **1.9.36**
