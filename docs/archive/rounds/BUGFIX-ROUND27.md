# BUGFIX-ROUND27 — ریشه‌یابی باگ نوار قیمت + همترازی با پلتفرم مرجع (MT5 Charts Pro)

این سند مرجعِ راند ۲۷ است: ریشه‌یابی دقیقِ باگ «نوار قیمت غلط در نمادهای دارای دلار»،
مقایسهٔ معماری با نرم‌افزار مرجع (`mt5-charts-pro-windows` / OJChart v1.4.0)،
و مستند فایل‌به‌فایلِ همهٔ تغییرات.

---

## ۱) ریشه‌یابی باگ نوار قیمت (ریشه واقعی — نه اعشار!)

### گزارش کاربر
نوار قیمت در برخی نمادهای فارکس که یک طرفشان USD است غلط بود؛ EURUSD (۵ رقم اعشار)
مشکل داشت ولی جفت‌های ۳ رقمی سالم بودند. وچ‌لیست قیمت درست نشان می‌داد.

### یافتهٔ کلیدی
مشکل **ریشه‌ای در تعداد اعشار نداشت**. زنجیرهٔ digits (ارقام اعشار) از ابتدا سالم بود:
`provider/mt5.py get_digits` (digits واقعی MT5) → `feed.js digitsBySym` →
`manager.js loadBars resp.digits → applySeriesFormat` (precision/minMove سری LWC).
عددِ ۵ رقمیِ تمیزی که روی محور یخ زده بود فقط «شکل ظاهریِ» مشکل بود.

### ریشهٔ واقعی: اختلاط دو پایهٔ زمانی (Server clock vs Local clock)
تیک‌های پرووایدر به‌ع-time **سرور بروکر** مهر می‌خورند (`mt5.py server_now() = ساعت محلی + آفست بروکر`)
ولی رندرر در ۳ نقطه آنها را با **ساعت محلی ویندوز** مقایسه می‌کرد:

| # | فایل / نقطه | کد قدیمی | اثر روی بروکر واقعی (GMT+2/+3 و کاربر UTC+3:30) |
|---|---|---|---|
| ۱ | `manager.js` → `axisGuard` چک F1b (لنگر تیک زندهٔ R26) | `Date.now()/1000 - lastTickAt ≤ 90` | skew ثابتِ ۹۰+ دقیقه → گارد **هرگز فعال نمی‌شد** → هر تاریخچهٔ مسموم/کهنه برای همیشه محور را روی قیمت غلط یخ می‌زد |
| ۲ | `manager.js` → `updateCountdown` (چک تازگی تیک) | `Date.now()/1000 - lt > 180 → hide` | شمارش معکوس روی حساب واقعی برای همیشه مخفی می‌شد |
| ۳ | `manager.js` → `onTick` (fallback زمان تیک) | `time ‖ Date.now()/1000` | در نبودِ مهرِ زمان، باکت تیک به زمان محلی می‌افتاد |

نکتهٔ ظریف: `updateMarketChip` (چیپ Market open/closed) از همان ابتدا آفست سرور را
اضافه می‌کرد و درست کار می‌کرد — یعنی الگوی درست داخل خود پروژه موجود بود.

### چرا آزمایش‌های R26 سبز شده بود؟
شبیه‌ساز demo بدون `--off` آفست صفر دارد؛ یعنی ساعت سرور = ساعت محلی و هر سه
مقایسه به‌طور تصادفی درست از آب درمی‌آمد. فقط با `demo.py --off -5400`
(شبیه‌سازی کاربر تهران روی بروکر GMT+2) گارد مرده دیده می‌شد.

### راهکار پلتفرم مرجع (که پورت شد)
OJChart همهٔ مهرهای زمان را در ورودی به **UTC واقعی** نرمال می‌کند
(`detect_server_utc_offset` در بریج پایتون) و کل سیستم روی **یک پایهٔ زمانی** کار می‌کند.
معادلِ کم‌تهدیدترین پیاده‌سازی در معماری ما (داده = زمان سرور + نمایش = TZ انتخابی):
هر مقایسهٔ «تازگی تیک» باید با **ساعت سرور تخمینی** (`Date.now()/1000 + feed.serverOff`)
انجام شود — دقیقاً همان کاری که `updateMarketChip` می‌کرد.

### فیکس (همه در `src/renderer/js/chart/manager.js`)
- `axisGuard`: `const nowS = Date.now() / 1000 + serverOff();`
- `updateCountdown`: `Date.now() / 1000 + serverOff() - lt > 180`
- `onTick`: fallback `Math.floor(Date.now() / 1000 + serverOff())`
- `watchlist.js` + `alerts.js`: ستون Last و ردیف‌های Alert حالا از helper مرکزی
  `U.priceDigits()` (اولویت: `feed.digitsBySym` پرووایدر، fallback: heuristic قدیمی)
  استفاده می‌کنند — و `feed.js` digits را از پاسخ bars هم ثبت می‌کند تا حتی قبل از
  اولین تیک، وچ‌لیست با ارقام واقعی چاپ کند. (پاک‌سازی آخرین ناهمگونی digits)

### اثبات (Playwright E2E — `tools/dev/bug_repro_offset.py`)
تاریخچهٔ مسموم (سطح 155.2 با مهر زمانی +1 روز) روی EURUSD تزریق می‌شود؛ تیک زنده ≈1.08:

| حالت | قبل از فیکس | بعد از فیکس |
|---|---|---|
| `off=0` (کنترل) | HEALED | HEALED |
| `off=-5400` (بروکر واقعی) | **STUCK — محور روی 155.2 یخ، وچ‌لیست 1.08 زنده** | **HEALED — series==bars==watch==tick، گارد ۱ بار reload زده** |

---

## ۲) همترازی با پلتفرم مرجع — قابلیت‌های اضافه‌شده

### A. عمق تاریخچه (کندل‌های بیشتر — دمو و MT5 واقعی)
- سقف پرووایدر ۵۰۰۰ → **۲۵۰۰۰** (`mt5.py MAX_BARS_REQ`)؛ `copy_rates_range` با
  datetime آگاه از TZ برای صفحات قدیمی‌تر (همان تلهٔ tz-aware `copy_ticks_range`).
- `demo.py`: کش عمیق ۲۵هزارتاییِ deterministic per (symbol,tf) با سقف بازهٔ ۵۴ سال
  (`deep_count_for`) + غلتک دُم زنده در حالت `--off`.
- `state.js COUNT_FOR`: M1 3000→**5000**، M5 2000→**4000**، M15 →**3000**، H1 →**2500**،
  D1 →**1200** و… + `OLDER_CHUNK=1000` و `MAX_CHART_BARS=25000`.
- پروتکل `bars_req` فیلد اختیاری **`to`** (اکسکلوسیو) گرفت → پاسخ bars قدیمی‌تر از `to`.
- **صفحه‌بندی «Load older bars»** (`manager.js loadOlder`): پیل پایین-چپ + بارگذاری
  خودکار وقتی چپ‌ترین ایندکس < 8 (`subscribeVisibleLogicalRangeChange`)؛ ادغام
  sanitize-شده، **حفظ ویوپورت** (شیفت logical range به اندازهٔ bars اضافه‌شده)،
  توقف هوشمند وقتی پرووایدر خشکید (`_olderDone`)، سقف ۲۵k، حذف در Replay.

### B. سیستم اندیکاتورها (۲۷ اندیکاتور — پورت کامل از مرجع)
- `js/chart/indicators.js` (جدید): کتابخانهٔ ریاضی خالص (sma/ema/wma/stdev/rsi/atr/…)
  + رجیستری ۲۷ اندیکاتور — همان تعاریف/پیش‌فرض‌های `lib/chart/indicators.ts` مرجع:
  - **روی چارت:** SMA, EMA, WMA, HMA, Bollinger, Donchian, Keltner, Envelopes, VWAP,
    Parabolic SAR (نقطه‌چین با `pointMarkersVisible`), SuperTrend, Ichimoku
  - **پن جدا:** RSI, MACD (هیستوگرام), Stochastic, StochRSI, Williams %R, CCI, ATR,
    StdDev, Momentum, ROC, Awesome Oscillator
  - **حجم:** Volume(+MA), OBV, MFI, A/D Line
- `js/chart/indicators-ui.js` (جدید): اتصال به LWC v4.2 (بدون API پنِ native):
  - اورلی‌ها روی اسکیل اصلی چارت؛ اسیلاتورها روی اسکیل‌های overlay با
    **اسلات‌بندی bottom-up** (`scaleMargins`) و `fixedRange` (RSI 0..100 و…)
  - خطوط سطح (۷۰/۳۰، صفر MACD و…) با `createPriceLine`
  - **ردیف‌های لجند** زیر OHLC: عنوان + مقدار زندهٔ زیر کراس‌هیر + چشم/چرخ‌دنده/حذف
  - **دیالوگ Indicators** (دکمهٔ ƒx تولبار یا کلید **`/`**): جستجو + گروه‌ها + علاقه‌مندی‌ها
  - دیالوگ تنظیمات هر نمونه: پارامترها + پالت ۸ رنگ per-series
  - بازمحاسبه: روی هر loadBars/loadOlder/replay-cut + تیک (throttle 400ms) + حذف/افزودن
  - **persist:** در `mt5_boot_panes` و Save Layout همراه هر چارت (بازیابی با اعتبارسنجی رجیستری)

### C. لجند سبک TV — ساعت/تاریخِ کندلِ انتخاب‌شده + رنگ‌بندی OHLC
- `updateLegend`: ردیف OHLC حالا با **«Dow dd Mon yyyy  hh:mm»** (TZ انتخابی؛ برای
  تایم‌فریم‌های ثانیه‌ای hh:mm:ss) شروع می‌شود و مقادیر O/H/L/C و تغییر بر اساس
  **جهت کندل** رنگ می‌شوند (سبز/قرمز).
- سوییچ تنظیمات جدید: `Settings → Status line → «Bar date & time»` (`stBarTime`, پیش‌فرض روشن).
- Data Window از قبل زمان TZ-دار داشت — بدون تغییر ماند.

### D. پاس استانداردسازی
- **No-data overlay صادقانه** (`.pane-nodata`) وقتی تاریخچه واقعاً خالی می‌آید (پاریتی با مرجع).
- digits واقعی پرووایدر در همهٔ پنل‌ها (Watchlist/Alerts/چارت/Time&Sales).
- سازگاری Replay/Compare/Free-Transform با اندیکاتورها و صفحه‌بندی.
- شمارش معکوسِ تازه‌شده روی بروکر واقعی (نتیجهٔ فیکس پایهٔ زمان).

### عمداً از این راند خارج ماند (پاریتی آینده)
فیل باند اندیکاتورها (fill نیمه‌شفاف بین باندها — خطوط کافی و مرجع هم ظریف است)،
DOM/عمق بازار، تقویم اقتصادی، سشن‌بندها — نیازمند تغییرهای معماری بزرگ‌تر.

---

## ۳) تست‌ها
- `tools/dev/bug_repro_offset.py` (تصمیم‌گیرندهٔ باگ): off=0 HEALED ✅ / off=-5400 HEALED ✅ (قبلاً STUCK)
- `tests/unit/test_round27_features.py` (جدید، ۱۱ چک): عمق M1=5000 ✅ · صفحهٔ قدیمی‌تر
  (+1000 bars، سختِ قدیمی‌تر، صعودی) ✅ · digits=5 چارت+وچ‌لیست ✅ · افزودن EMA/RSI/MACD +
  ردیف‌ها ✅ · RSI∈[0,100] و هیستوگرام MACD ✅ · حذف اندیکاتور ✅ · لجند تاریخ/ساعت ✅ ·
  OHLC رنگی ✅ · **صفر خطای کنسول** ✅ — **11/11 PASS**
- `tools/dev/probe_countdown.py`: شمارش معکوس زنده «00:03 → 00:01» (mm:ss درست M1) ✅
- رگرسیون: `py_compile` هر ۳ فایل پرووایدر ✅ · `node --check` تمام jsها ✅
- اسکرین‌شات‌های مدرک: `docs/r27-t1-depth.png`, `docs/r27-t4-indicators.png`, `docs/r27-final-state.png`
