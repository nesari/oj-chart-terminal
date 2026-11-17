# اندیکاتورهای خراب — تشخیص راند ۳۰۲ (برای چت بعدی)

> **خلاصه:** از ۲۷ اندیکاتور داخلی، **۱۴ مورد به‌طور کامل رسم نمی‌شوند** (زیرپنل
> ساخته می‌شود ولی صفر پیکسل روی چارت می‌نشیند) و **۲ مورد ناپایدارند**. علت در
> زیرساخت **زیرپنل Pine** است، نه در فرمول‌ها.

## روش اندازه‌گیری

یک هارنس زنده (`tests/archive/e2e/_tmp_r302.py` در working tree، پاک‌شدنی) هر
اندیکاتور را **۳ بار** اضافه می‌کند و هر بار می‌سنجد:

1. `changedPx` — تعداد پیکسل‌هایی که روی canvasهای چارت واقعاً تغییر کرده‌اند
   (پیش از افزودن vs پس از افزودن).
2. `hasSub` / `subH` — آیا زیرپنل ساخته شد و ارتفاعش چقدر است.
3. `rects` — طول `pane._subRects` (آنچه رنگ‌آمیز برای کلیپ‌کردن استفاده می‌کند).

## نتیجهٔ اندازه‌گیری (۳ اجرای هر اندیکاتور)

| اندیکاتور | subH | rects | changedPx | وضعیت |
|---|---|---|---|---|
| sma, ema, wma, hma | 0 | 0 | ۲۶۰۰–۴۵۷۶ | ✅ (ema یک اجرا از سه: **۰**) |
| bollinger, donchian, keltner | 0 | 0 | ۲۶۰۰–۶۳۴۷۳ | ✅ |
| envelopes, vwap, supertrend, ichimoku | 0 | 0 | ۶۵۰۰۰–۷۹۰۰۰ | ✅ |
| sar | 0 | 0 | ۳۱۸۰ / **۴۱** / ۳۴۴۰ | ⚠️ ناپایدار |
| **rsi, macd, stochastic, stochrsi, willr, cci, momentum, roc, awesome, volume, obv, mfi, adline, atr, stddev** | **۱۶۶** | **۱** | **۰** | ❌ **نامرئی** |

## دو یافتهٔ قطعی

### ۱) زیرپنل ساخته و چیده می‌شود، ولی پیکسلی رسم نمی‌شود

برای RSI اندازه‌گیری شد:

```
sub.host         : .sub-pane.sub-pine   top:448px  h:166px  (در DOM، چیده‌شده)
pane._subRects   : 1  (در یک اجرا)  /  0  (در اجرای دیگر)
ad._paintRect()  : { top: 448, h: 140 }        ← درست
ad._yOf(86.26)   : 465.8                        ← داخل زیرپنل، درست
ad._xOf(...)     : 1041.9                       ← درست
pine-fg-canvas   : 1215×614، ۴۴۶۴ پیکسل غیرشفاف در باند y=440..560
```

یعنی **خط RSI روی `pine-fg-canvas` کشیده می‌شود** (۴۴۶۴ پیکسل، دقیقاً داخل
باند زیرپنل). ولی در اسکرین‌شات دیده نمی‌شود.

**مشکوک اصلی: لایه‌بندی.** `document.elementFromPoint()` در ناحیهٔ زیرپنل
`pane-overlay` را برمی‌گرداند:

| لایه | z-index | یادداشت |
|---|---|---|
| `.sub-pane.sub-pine` | `auto` | **بدون z-index** — در DOM آخر است ولی درون stacking context والد |
| `canvas.pane-overlay` | **۱۰** | canvas نقشهٔ ترسیم (روی همه) |
| `canvas.pine-fg-canvas` | **۸** | زیر `pane-overlay` |
| `canvas.pine-tables` | ۹ | |

`.pane-overlay` یک canvas با `z-index:10` است که روی `pine-fg-canvas`(۸)
می‌نشیند. اگر خالی/شفاف باشد RSI باید دیده شود — پس یا اندازه‌اش کل پنل است و
با `clearRect` مبهم می‌شود، یا `pine-fg-canvas` زیر `.sub-pane` (که خودش
`z-index:auto` دارد) قرار می‌گیرد و **LWC زیرپنل رویش رنگ می‌کشد**.

گام بعدی پیشنهادی: `getComputedStyle` روی `.sub-pane` و ترتیب
`stacking context` را با یک تست ساده بررسی کن (`.sub-pine` را موقتاً
`z-index:20` کن و ببین RSI ظاهر می‌شود).

### ۲) race در `_subRects`

در اجرای اول `pane._subRects.length === 1` بود، در اجرای بعد `0` — با اینکه
`subH=166` در هر دو. یعنی `layoutSubPanes` بعد از ساخت زیرپنل فراخوانی
می‌شود ولی **گهگاهی بعد از آن دوباره با `subs=0` اجرا می‌شود** و
`_subRects` را خالی می‌کند (یا اصلاً فراخوانی نمی‌شود).

- تنها نویسندهٔ `_subRects` در کل کد: `pane.js:455` (`layoutSubPanes`) و
  `pane.js:635` (`destroyPanes`).
- `_ensureSub` در `pine-render-adapter.js:228` آن را صدا می‌زند.
- برای اثبات: `Manager.layoutSubPanes` را در `add_init_script` بپوشان و
  `subsBefore/rectsAfter` را لاگ کن (الگوی
  `tests/archive/e2e/_tmp_lay.py`).

### ۳) SAR: `pointMarkersRadius: undefined` → `null`

اسکریپت SAR با `style = plot.style_circles` تعریف شده. آداپتور
(`pine-render-adapter.js` ساخت سری) این را می‌فرستد:

```js
pointMarkersRadius: dots ? 1 : undefined,
```

با `r: None` در LWC → رادیوس پیش‌فرض اعمال نمی‌شود. اندازه‌گیری زنده:

| تنظیم | پیکسل غیرشبکه‌ای |
|---|---|
| پیش‌فرض (`pmr=null`) | ۱۵۹۶ |
| `pointMarkersRadius: 2.5` | ۱۶۰۴ |
| `lineVisible: true, lineWidth: 2` | **۳۷۵۸** |

یعنی نقاط ۱ پیکسلی تقریباً نامرئی‌اند. رفع: `pointMarkersRadius: dots ? 3 : undefined`
و برای SAR بهتر است `style = plot.style_circles, linewidth = 2` با رادیوس ۳
باشد (TV همین را می‌کند).

## فایل‌های کلیدی

| فایل | نقش |
|---|---|
| `src/renderer/js/chart/pine-render-adapter.js` | `_ensureSub` (۲۱۰)، `_buildSeries` (۲۵۴)، `_yOf` (۷۰۳)، `_paintRect` (۷۳۳)، `_paintPlotLines` (۱۱۶۱)، `paintPaneForced` |
| `src/renderer/js/chart/manager/pane.js` | `layoutSubPanes` (۴۲۷)، `computeSubHeights` (۳۸۷)، `sortedSubs` (۴۱۴) |
| `src/renderer/css/app.css` | `.sub-pane` (۶۹۴، **بدون z-index**)، `.pine-fg-canvas` (۲۰۲۴، z=8)، `.pane-overlay` (۸۲۱، z=10) |
| `src/core/pine/builtins-catalog.js` | ۲۷ اسکریپت (SAR در `builtin:sar`، `style=plot.style_circles`) |

## اسکریپت‌های بازتولید (در working tree، هنوز commit نشده)

```
python tests/archive/e2e/_tmp_r302.py     # جدول کامل ۲۷ اندیکاتور × ۳ اجرا
python tests/archive/e2e/_tmp_sub.py      # زیرپنل RSI: sub/rects/paint/y
python tests/archive/e2e/_tmp_bands.py    # کدام y-band پیکسل دارد
python tests/archive/e2e/_tmp_vis.py      # elementFromPoint + z-order + stack
python tests/archive/e2e/_tmp_sar.py      # SAR radius experiment
```
