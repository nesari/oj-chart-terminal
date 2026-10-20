# PINE Engine — گزارش انطباق فنی و نقشه راه استاندارد (v3 تا v6)

> تاریخ: اکتبر ۲۰۲۶. مبنا: سورس `src/core/pine/` + مستندات رسمی TV (Sphinx docs قابل fetch) + چک‌لیست مهاجرت v3→v4→v5→v6 + موجودی کامل موتور (همه ادعاها با `file:line`).
> هدف: **هر اندیکاتور عمومی Pine روی اپ بدون دیباگ تکی اجرا شود** — یعنی انطباق با استاندارد، نه fix موردی.
> روش پیشنهادی پذیرش: corpus-based (§۷) — نه «سوپرترند بعدی».

---

## ۰. خلاصه اجرایی (یک پاراگراف)

موتور امروز یک مفسر bar-by-bar سالم با هیستوری دقیق (`interpreter.js:1818-1829`)، `ta.*` پرکاربرد، `request.security` تک‌نماد، drawings پایه و MTF اختصاصی است — برای اسکریپت‌های سبک v4/v5 کافی، ولی **سه کلاس ناسازگاری** دارد که با «دونه‌دونه دیباگ» حل نمی‌شود: (الف) **معناشناسی خاموش-غلط** (§۳: eager `?:` و `and/or` برخلاف lazy رسمی، `varip==var`، نبود qualifier، bool-coercion) که خروجی اشتباه بدون خطا می‌دهد؛ (ب) **کتابخانه ناقص با خطای بلند** (§۴: ‎~۱۴ تابع `ta.*`، ‏`str.format`، ‏`input.enum`، ‏`log.*`، ‏`matrix/map/table`، ‏`strategy.*`، مولتی‌لاین، `study()` ریجکت) که کامپایل را می‌اندازد؛ (ج) **سقف‌های معماری** (§۶: تک‌نماد بودن `security`، نبود tick-model، نبود backtester). ترتیب پیشنهادی: اول معناشناسی (§۳)، بعد کتابخانه (§۴)، بعد سقف‌ها (§۶) — چون باگ خاموش از خطای بلند خطرناک‌تر است.

---

## ۱. وضعیت فعلی موتور (نقشه)

| لایه | فایل | وضعیت |
|---|---|---|
| lexer/parser | `lexer.js` (195)، `parser.js` (716) | v5-ish؛ `indicator/strategy/library`، `type/enum/method`، `switch/for/while`، UDT، tuple — همه parse می‌شوند. `import/export` ریجکت (`parser.js:92-93`). `//@version` خوانده ولی اعمال نمی‌شود (پیش‌فرض ۵، `parser.js:57-60`). |
| interpreter | `interpreter.js` (~2490) | اجرای bar-by-bar + هیستوری + drawings + inputs + security تک‌نماد HTF/LTF |
| types/scope/errors | `types.js` / `scope.js` / `errors.js` | `PineColor`، `SeriesBuf(cap 5000)`، کدهای `CE…/RE…` |
| stdlib | `ta/math(+str)/color/array/objects/inputs/time/request(+security)/mtf/arrow` | پوشش §۴ |
| MTF اختصاصی | `mtf.js` + `pine-ui.js:525,609` | باکت HTF + `remapOut` خالص + lower-TF کش |

---

## ۲. ماتریس انطباق نسخه‌ها

| موضوع | v3 | v4 | v5 | v6 | وضعیت موتور |
|---|---|---|---|---|---|
| اعلان `study()` | ✅ رسمی | ✅ رسمی | ❌→`indicator()` | ❌ | **ریجکت** (`compile.js:88` فقط indicator/strategy/library) — سمپل‌های v4 خودمان با fallback زنده‌اند ولی اسکریپت تازه `study` خطا می‌گیرد |
| bare globals (`sma()`, `red`, `close[1]`) | ✅ | ✅ | ❌→`ta.*/color.*` | ❌ | پذیرفته (aliases `interpreter.js:334-414` + bare colors `1680`) — خوب برای سازگاری عقب‌رو |
| `transp=` | ✅ | ✅ | ❌→`color.new/rgb` | ❌ | **نادیده خاموش** (`plotshape` فقط title/style/location/color/offset/text/… را می‌خواند `919-965`) — اسکریپت v4 با `transp=0` رنگ متفاوت می‌گیرد، بی‌خطا |
| `input(type=input.integer…)` | — | ✅ | ❌→`input.int…` | ❌ | پذیرفته (`__nsTag`، `1883-1889,2220-2226`) — خوب |
| `iff()/offset()` | ✅ | ✅ | ❌ | ❌ | `iff` هنوز پیاده است (بی‌ضرر) |
| qualifier ‏(`const/input/simple/series`) | ضعیف | ضعیف | اجباری‌جاها | اجباری‌جاها | **اعمال نمی‌شود** — فقط رتبه روی enum-const (`types.js:12-14,140-152`). اسکریپتی که در TV با «cannot call with series» می‌میرد اینجا بی‌صدا اجرا می‌شود (خروجی متفاوت) |
| bool سخت‌گیرانه v6 (no int→bool، bool هرگز na) | — | — | — | ✅ رسمی | **اعمال نمی‌شود** — `truthy()` صفر/غیرصفر را coerce می‌کند (`types.js:28`)؛ `if close` اینجا کار می‌کند، در TV خطا |
| تقسیم int (`1/2=0.5`) | int | int | int | **float** ✅ | بررسی‌نشده — اگر `_binop` تقسیم صحیح نکند، اسکریپت v6 خروجی متفاوت می‌دهد (تست لازم) |
| `switch` / `for…in` / متد کالکشن | — | — | ✅ | ✅ | parse+اجرا می‌شود (`482-503,438-472`؛ `2281-2317`) — خوب |
| `type`/`enum`/`method` | — | — | type ✅ | enum ✅ | parse می‌شود (`312-355`)؛ `input.enum()` **نیست** |
| `varip` | — | — | ✅ | ✅ | **`== var`** (`1383-1386`) — روی کندل زنده رفتار متفاوت |
| dynamic requests / `request.*` در لوپ | — | — | ❌ | ✅ | نامشخص/محدود — تست لازم |
| `log.*` (Pine Logs) | — | — | — | ✅ | **نیست** (grep صفر) |
| مولتی‌لاین `"""` | — | — | — | ✅ (2026) | **نیست** (grep صفر) |
| `polyline`/`chart.point` | — | — | — | ✅ | `new/delete` هست، متد کامل نیست (`740-746`) |
| `table.*` | ✅(v4+) | ✅ | ✅ | ✅ | **استاب** (throw، `308-314,469-479`) — هر اندیکاتور داشبوردی می‌میرد |
| `strategy.*` + بک‌تستر | ✅ | ✅ | ✅ | ✅ (+trim) | **استاب کامل**؛ `strategy()` مثل indicator رفتار می‌کند |
| `footprint` (Premium-gated) | — | — | — | ✅ | نیست — باید **خطای gating** بدهد نه سکوت |

---

## ۳. گپ‌های معناشناسی بحرانی (خاموش-غلط — اولویت ۱)

خطرناک‌ترین کلاس: نه کامپایل می‌افتد نه throw — فقط عدد اشتباه روی چارت.

| # | گپ | شاهد | اثر واقعی |
|---|---|---|---|
| 3-1 | **`?:` eager است، رسمی lazy** | `interpreter.js:1779-1787` (کامنت «BOTH branches» ادعای انطباق دارد — **غلط است**؛ گاید مهاجرت v4→v5 صریح می‌گوید `iff→?:` با lazy-eval و hoist کردن `ta.*`) | `ta.sma` داخل شاخه اجرا‌نشده در TV هیستوری نمی‌سازد، اینجا می‌سازد → واگرایی عددی؛ بدتر: گارد `x!=0 ? y/x : na` در TV امن، اینجا… (در عمل `_binop` تقسیم‌برصفر را na می‌کند پس throw نه، ولی هیستوری `ta.*` داخل شاخه‌ها قطعاً واگراست) |
| 3-2 | **`and/or` بدون short-circuit** | `interpreter.js:1718-1726` (کامنت مشابه غلط) | `cond and ta.crossover(a,b)` — اینجا crossover همیشه جلو می‌رود، در TV فقط وقتی cond برقرار است → سیگنال متفاوت. کلاسیک‌ترین باگ مهاجرت |
| 3-3 | **`if` استیتمنت lazy است ولی `?:` نه** | `1789-1791` در برابر `1779` | ناسازگاری داخلی: دو شکل یک منطق، دو جواب |
| 3-4 | `varip == var` | `1383-1386` | روی هیستوری یکسان، روی کندل زنده/تیک متفاوت (rollback باید var را برگرداند و varip را نه) |
| 3-5 | qualifier اعمال نمی‌شود | `types.js:12-14` | پذیرش اسکریپت‌هایی که TV ریجکت می‌کند + رفتار متفاوت در `plot(offset=series)` و `ta.*(len=series)` |
| 3-6 | bool-coercion آزاد | `types.js:28` | `if bar_index` / آرگومان int به‌جای bool در v6 باید خطا بدهد |
| 3-7 | `security` فقط تک‌نماد + `gaps` تزئینی | `interpreter.js:457` (throw کراس‌نماد)؛ `request-security.js:57-58` (فقط bool نگه می‌دارد، na-gap تزریق نمی‌شود) | هر واچ‌لیست/اسپرد/کراس‌نماد واقعی می‌میرد؛ `gaps_on` بدون تزریق na خروجی متفاوت می‌دهد |
| 3-8 | بافر ۵۰۰۰ در برابر ۱۰۰۰۰ OHLCV رسمی | `scope.js:14-16`، `interpreter.js:38` | اسکریپت‌های بلندمدت (>۵۰۰۰ کندل) هیستوری کوتاه می‌بینند |
| 3-9 | مدل tick غایب | فقط `runBar(isForming)` + `updateForming` (`1206-1297`) | `calc_on_every_tick`، رفتار intrabar، `varip` واقعی — همه تقریبی |

**تعریف درست (از داک رسمی):** اجرا bar-by-bar از اول به آخر؛ هر بار state نهایی commit می‌شود و فقط همان برای بارهای بعد قابل‌دیدن است؛ `[]` روی committed می‌خواند؛ ریل‌تایم per-tick با rollback همه‌چیز جز `varip`/لاگ/اردر/خطا؛ `request.security` پیش‌فرض `gaps_off + lookahead_off` (از v3) و `lookahead_on` بدون آفست `[1]` یعنی repaint.

---

## ۴. گپ‌های کتابخانه (خطای بلند — اولویت ۲، مرتب با فرکانس واقعی)

### ۴-۱. `ta.*` — موجود (۴۰): `sma ema rma wma vwma hma rsi change mom roc cum rising falling tr atr stdev dev bb bbw macd supertrend cci stoch wpr mfi obv highest lowest highestbars lowestbars crossover crossunder cross barssince valuewhen pivothigh pivotlow linreg sar vwap` (`ta.js:176-649`)
### ‏۴-۲. `ta.*` — **مفقود (~۱۴ + متغیرهای سری)**: ‏`alma cmo cog correlation dmi kc kcw median mode percentile_linear_interpolation percentile_nearest_rank percentrank rci swma tsi variance` + وِرهای سری `ta.accdist ta.iii ta.nvi ta.obv ta.pvi ta.pvt ta.wad ta.wvad` (در v6 این‌ها متغیرند نه تابع؛ grep صفر، `ta.js` هیچ‌کدام را ندارد)
### ۴-۳. `math.*` — موجود (۲۶+۶ const، `math.js:22-97`، شامل `round_to_mintick:85`)؛ **مفقود**: خانواده `math.bitwise_*` (v6 namespace جدا)؛ بررسی `avg/sum` روی آرایه (موجود ادعاشده — تست لازم)
### ۴-۴. `str.*` — موجود (۱۷، `math.js:118-166`)؛ **مفقود کلیدی**: `str.format` (جاوا‌استایل `{0,number}` — پرکاربردترین تابع نمایشی v6؛ فقط `format_time` هست)
### ۴-۵. `color.*` — کامل عملی (۷ تابع + ~۹۰ const، `color.js` + `types.js:37-71`)
### ۴-۶. `array.*` — کامل عملی (۲۷ متد + namespace/method دابل‌دیatches)؛ `matrix.*`/`map.*` **استاب کامل** (هر کال throw)
### ۴-۷. drawings — `line/box/label` کامل عملی (~۱۹/۲۲/۱۹)؛ `polyline/linefill` فقط new/delete؛ **`table.*` استاب**؛ `box.extend` هاردکد `none` (`objects.js:300`)؛ `line.get_x` throw صریح (`643`)
### ۴-۸. `input.*` — ۱۲ namespaced + legacy/v4 (`inputs.js`، `interpreter.js:415-432,2170-2254`)؛ **مفقود**: `input.enum()` (بااینکه `enum` parse می‌شود)، پارامتر `active` (v6)، `confirm` drop می‌شود
### ۴-۹. متفرقه مفقود با grep صفر: `log.info/warning/error`، مولتی‌لاین `"""`، `session.*`، `ticker.*`، `currency.*` (فقط ۳/۳۰)، `order.*`، `request.dividends/earnings/splits/financial`، `syminfo.main_tickerid/isin`، `timeframe.main_period`، `chart.*` جزئی (`is_standard/heikinashi` فقط، `1872-1875`)، `display.*` جزئی
### ۴-۱۰. محدودیت‌های رسمی پیاده‌نشده: سقف ۶۴ پلات هست (`866-873`) ولی **حسابداری TV** (رنگ سری‌مقدار ×N، hline رایگان) نیست؛ کپ drawings ما ۵۰۰ پیش‌فرض در برابر ۵۰/۵۰۰ رسمی (`objects.js:26-52` — نزدیک، کافی)؛ سقف ۴۰ `request.*`، کپ ۱۰۰K کالکشن، «na-ID هم می‌شمارد» — هیچ‌کدام

---

## ۵. گپ‌های خروجی/رندر (پس از اجرای درست)

`plot/plotshape/plotchar/plotarrow/plotcandle/fill/bgcolor/barcolor/hline` پینت می‌شوند (راندهای ۱۳۸–۱۴۹)؛ `table.*` رندر ندارد (به استاب §۴-۷ گره خورده)؛ `plot.offset` ایندکس را شیفت می‌دهد و اسلات‌های آینده drop (`820-863` — مرز viewport باید تست شود)؛ `plotarrow.offset`/`plotshape.offset` نادیده (یادداشت راند ۱۴۹).

---

## ۶. سقف‌های معماری (تصمیم مدیریتی می‌خواهد، نه فقط کد)

1. **کراس‌نماد `security`** — فید ما عملاً تک‌نماد-per-pane است؛ پشتیبانی واقعی یعنی کش چندنماده + WS چندگانه. تا آن روز: خطای صریح فعلی درست است (سکوت ممنوع).
2. **بک‌تستر `strategy.*`** — اسکوپ جداگانه (موتور سفارش + fills + trim + `closedtrades.first_index`)؛ فازبندی §۸.
3. **tick-model واقعی** — `updateForming` فعلی single-rerun است؛ varip واقعی و `calc_on_every_tick` به executor چندتیکی نیاز دارد.
4. **`library/import/export`** — ریجکت فعلی درست است تا وقتی resolver/registry نداریم.
5. **نسخه‌گیتینگ** — `//@version` امروز تزئینی است؛ رفتار متفاوت نسخه‌ها (bool سخت‌گیر، int-div، `study`) بدون گیت، هم v3 قدیمی را می‌شکند هم v6 جدید را.

---

## ۷. روش‌شناسی پذیرش: corpus نه تک‌نمونه

1. **کورپوس طبقه‌بندی‌شده** (هر طبقه ≥۳ اسکریپت عمومی واقعی): ترند (Supertrend، EMA-cross)، مومنتوم (RSI div، MACD، Squeeze)، MTF (`security` بالا/پایین)، drawings-heavy (SMC، 786-Zones)، table-dashboard، session/time، multi-`input`، v3/v4 legacy، استراتژی (فقط کامپایل‌OK تا فاز بک‌تستر).
2. **هارنس**: `compile → runAll روی دیتای قطعی → snapshot خروجی (plots/shapes/drawings/errors)`؛ هر فیچر جدید = فیxture + expected پین‌شده؛ رگرسیون خودکار در همان `scripts/test_*.mjs`.
3. **تست افتراقی فرمولی**: برای هر `ta.*` جدید، مقادیر برابر مرجع مستقل (فرمول داک) روی سری قطعی — نه برابر TV (در دسترس نیست)، برابر ریاضی.
4. **قانون طلایی**: هیچ «حذف محدودیت» بی‌صدا — هر رفتار house-rule در کامنت `ROUNDnnn` + همین سند ثبت شود (مثل `arrow.js` راند ۱۴۹).

---

## ۸. نقشه راه فازی (هر فاز = ۱–۳ راند، قابل‌عرضه مستقل)

- **فاز A — معناشناسی (بحرانی)**: lazy ‏`?:` ‏(فقط شاخه گرفته + ثبت اینکه `ta.*` داخل شاخه هیستوری نمی‌سازد — همان هشدار رسمی)، short-circuit ‏`and/or`، ‏`varip` واقعی در rollback (`snapshot/restore` + `dropObjectsBornAfter`)، گیت bool سخت‌گیر پشت `version>=6`، تست int-div روی v6.
- **فاز B — `ta.*` کامل**: ۱۴ تابع مفقود §۴-۲ + وِرهای سری + هارنس فرمولی؛ سپس `math.bitwise_*` و `str.format`.
- **فاز C — ورودی/نسخه**: `input.enum()` + `active`، گیت `//@version` (حداقل: v3/v4 `study` پذیرفته شود، رفتارهای v6 گیت شود)، `transp=` به `color.new` مپ شود (سازگاری v4 خاموش-درست)، مولتی‌لاین، `log.*` (لااقل collect مثل `alert()`).
- **فاز D — دیتا**: `gaps_on` تزریق na واقعی، بافر OHLCV تا ۱۰۰۰۰، `syminfo/timeframe/chart.session` تکمیلی، `request.*` غیر-secruity با خطای دقیق (زنده/mرده مثل `quandl`).
- **فاز E — drawings کامل**: `table.*` (موتور + رندر — بزرگ‌ترین آیتم رندری)، `box.extend`، متدهای `polyline`، حسابداری ۶۴-پلات TV.
- **فاز F — استراتژی**: تصمیم اسکوپ (کامپایل‌OK + خطای صادقانه «بک‌تستر نیست» در برابر MVP بک‌تستر)؛ `when=` ریجکت با پیام مهاجرت.
- **فاز G — انطباق خطا**: کدهای `CE/RU` برابر مرجع برای ۲۰ خطای پرتکرار + پیام‌های مهاجرت نسخه (نه throw ژنریک).
- **فاز H — کورپوس و CI**: §۷ به‌علاوه E2E رندری هر طبقه؛ آستانه پذیرش: ۱۰۰٪ کورپوس یا کامپایل‌OK+پین‌سبز یا خطای مستندشده در همین سند.

## ۹. ترتیب ۵ قدم بعدی (پیشنهاد مجری)

1. راند ۱۵۰ ✅: lazy ‏`?:` ‏+ short-circuit (فاز A).
2. راند ۱۵۱ ✅: گلوگاه کامپایل/اجرای کورپوس ۵ سنگین (تاپل، type-word، ‏`array.new_*`، ‏`table` MVP، ‏`str.format`، ‏`position/format/display`) — به‌جای varip (گلوگاه اولویت داشت).
3. راند ۱۵۲ ✅: `varip` واقعی + گیت bool نسخه۶ + threading نسخه (int-div قدیمی تعویق خورد — نیاز به typed-values، رفتار فعلی دقیقاً v6 است).
4. راند ۱۵۳ ✅ (بچ اول ta.*: نه تابع پنجره‌ای + هارنس افتراقی) — راند ۱۵۴ ✅ (بچ دوم: کامپوزیت‌ها + وِرهای سری + ‏input.enum + مپ transp= + فیکس strict-na در tr).
5. راند ۱۵۵ ✅ (رندر table DOM + متدفرم/merge/height + باگ eye-restore + اکسپورت rebuild؛ هر دو E2E سبز). راند ۱۵۶ ✅ (study first-class + باگ stub در request.security عضو + باگ کپ در reset + بافر ۱۰k + مهاجرتی‌ها). راند ۱۵۷ ✅ (تزریق na برای gaps_on + E2E سه‌تای باقی‌مانده روی ۵۰۰۰ کندل زنده). راند ۱۵۸ ✅ (نرمال‌سازی ingest + فیکس فریم security + percentile). راند ۱۵۹ ✅ (جاروی سراسری: فیکس named در method + یکپارچه‌سازی HTF + هر سه E2E سبز + ضمیمه وضعیت). راند ۱۶۰ ✅ (گزارش SMC: توقف paint حین لود + var محلی پایدار + bucket tape + فرم point). راند ۱۶۰ ✅ (گزارش SMC: توقف paint حین لود + var محلی پایدار + bucket tape + فرم point). راند ۱۶۱ ✅ (پین E2E دیالوگ input.enum؛ ۱۶ چک). راند ۱۶۲ ✅ (گزارش شلوغی SMC: مسیر ایونت تبرئه + پین parity؛ ۱۰ چک — باگ انجینی نبود). راند ۱۶۳ ✅ (سرشماری drawings در لاگ برای ردیابی خطوط؛ ۱۲ چک). راند ۱۶۴ ✅ (باگ واقعی var مشترک call-siteها + فیکس؛ ۱۲ چک؛ هر سه E2E زنده سبز). راند ۱۶۵ ✅ (لول‌های D/W/M + سایز لیبل‌ها؛ ۲۹ چک نود + ۱۱ چک E2E زنده). راند ۱۶۶ ✅ (PSAR + ممیزی Style؛ ۱۷ چک نود + ۱۳ چک E2E زنده؛ هر چهار E2E سبز). راند ۱۶۷ ✅ (منوی استایل پلات + Price line؛ ۱۳ چک نود + ۱۳ چک E2E زنده). راند ۱۶۸ ✅ (کراس‌سیمبل ۱a؛ ۸ چک نود + ۶ چک E2E زنده). راند ۱۶۹ ✅ (کراس‌سیمبل ۱b؛ ۱۳ چک نود + ۶ چک E2E زنده). راند ۱۷۰ ✅ (کراس‌سیمبل ۱c؛ ۱۴ چک نود + ۶ چک E2E زنده — فاز ۱ کامل). راند ۱۷۱ ✅ (بک‌تستر ۲a؛ ۲۸ چک نود). راند ۱۷۲ ✅ (بک‌تستر ۲b؛ ۲۰ چک نود). راند ۱۷۳ ✅ (بک‌تستر ۲c؛ E2E زنده ۹ چک — فاز ۲ کامل). راند ۱۷۴ ✅ (پایداری provider؛ ۵ چک پایتون + ۱۱ چک نود). چیز باز: بقیه §۱۱.

> دو ادعای [3P] تأییدنشده عمداً وارد نقشه نشد: «حذف `strategy.risk.*` در v6» (خلاف رفرنس — نادرست) و «`bgcolor` فقط global در v6» (خلاف داک — نادرست).

## ۱۲. فازهای کراس‌سیمبل و بک‌تستر (به‌روز: راند ۱۷۳ — فاز ۲ کامل اکتبر ۲۰۲۶)

**فاز ۱ — کراس‌سیمبل واقعی (`request.security` چندنمادی):**
- ۱a ✅ راند ۱۶۸ — هیستوری هم‌تایم‌فریم (تست ۸ چک + E2E زنده ۶ چک)
- ۱b ✅ راند ۱۶۹ — کراس‌تایم‌فریم چندنمادی + کش per-symbol/TF + prefetch با پوشش span (تست ۱۳ چک + E2E زنده ۶ چک)
- ۱c ✅ راند ۱۷۰ — تیک زنده نماد دوم + سیمبل داینامیک (fetch-and-retry) + dry بی‌صدا (تست ۱۴ چک + E2E زنده ۶ چک)
- قرارداد کلید دیتا: `env.symBars['SYM|sec']` (سمبل بدون پیشوند بروکر + ثانیه تایم‌فریم)؛ نبود دیتا → خطای صریح، نه سکوت

**فاز ۲ — بک‌تستر استراتژی:**
- ۲a ✅ راند ۱۷۱ — هسته سفارش: entry/exit/order/close/cancel، فیل نکست‌اوپن، pyramiding، معکوس، OCA، گترها با هیستوری (تست ۲۸ چک)
- ۲b ✅ راند ۱۷۲ — حساب: سرمایه/کمیسیون/slippage، کمیت cash/percent، trailing، equity و brokerStats (تست ۲۰ چک)
- ۲c ✅ راند ۱۷۳ — پنل Strategy Tester: خلاصه + پوزیشن + جدول تریدها (E2E زنده ۹ چک)

## ۱۱. وضعیت اجرا (به‌روز: راند ۱۷۴ — پایداری provider اکتبر ۲۰۲۶)

نگاشت گپ‌های §۳/§۴ به وضعیت. «پین‌شده» یعنی تست دائمی دارد.

| گپ | وضعیت |
|---|---|
| lazy ‏`?:` ‏+ short-circuit/Kleene | ✅ راند ۱۵۰ (تست ۱۵ چک) |
| `varip` واقعی + threading نسخه + گیت bool v6 | ✅ راند ۱۵۲ (تست ۲۰ چک) |
| int-div قدیمی | ⏸ تعویق (نیاز به typed-values؛ رفتار فعلی دقیقاً v6) |
| `ta.*` پنجره‌ای (۹تایی بچ اول) | ✅ راند ۱۵۳ (هارنس ۱۸ چک) |
| کامپوزیت‌ها dmi/kc/kcw/tsi + وِرهای obv/pvt/wad/wvad/accdist | ✅ راند ۱۵۴ (هارنس ۲۱ چک) |
| nvi/pvi (seed تأییدنشده)، iii/ta.percentrank (فانتوم)، percentile_* | ⏸ پارک — percentile ✅ راند ۱۵۸، بقیه باز |
| تاپل‌لیترال، type-word، ‏array.new_*‎، ‏order.* | ✅ راند ۱۵۱ (کورپوس ۵/۵) |
| table MVP + رندر DOM + merge/height + متدفرم | ✅ راند ۱۵۱/۱۵۵ (unit ۱۸ + E2E ۱۴ چک) |
| `str.format`، ‏`position.*`، ‏`format.mintick`، حساب display، ‏`input.enum` + دیالوگ، مپ `transp=` | ✅ راند ۱۵۱/۱۵۴ |
| باگ بافر `(expr)[k]` در snapshot | ✅ راند ۱۵۱ |
| `study()` first-class، بافر ۱۰k، bare ‏`security()`، پیام `when=`، متد `_htfSeries` | ✅ راند ۱۵۶ (تست ۱۴ چک) |
| stub در `request.security` عضو (همیشه throw) | ✅ راند ۱۵۶ |
| تزریق na در `gaps_on` | ✅ راند ۱۵۷ (تست ۱۱ چک) |
| نرمال‌سازی ingest، فریم security برای عبارت ترکیبی، `_htfSeries/_htfBuiltin` یکپارچه، named در مسیر method | ✅ راند ۱۵۸ + جاروی ۱۵۹ |
| آیتم تقویمی pine78 §۱۰ | 🔶 باز (وابسته به تاریخ؛ فاز D زمان) |
| کراس‌نماد `security`، بک‌تستر، tick-model، ‏library/import، ‏matrix/map، ‏`log.*`، مولتی‌لاین، رندر E2E باقی‌طبقه‌ها | 🔶 باز — پارک‌شده با تصمیم کاربر (اکتبر ۲۰۲۶) |
| `input.enum` در دیالوگ مرورگری | ✅ راند ۱۶۱ (E2E مسیر واقعی: ۱۶ چک) |
| شلوغی SMC در برابر TV (same-TF) | ✅ راند ۱۶۲ (مسیر ایونت تبرئه + پین parity: ۱۰ چک؛ باگ انجینی نبود — حساسیت دیتا/عمق + زوم؛ آزمایش PRESENT/زوم با کاربر باز) |
| خطوط «HTFنما» در SMC | ✅ راند ۱۶۴ (باگ واقعی: `var` تابعی بین call-siteها مشترک بود — `leg(50/5/3)` همدیگر را آلوده می‌کرد؛ فیکس + ۱۲ چک؛ E2E زنده: SMC از ۱۰۰۵ به ۶۳۱ drawings) |
| لول‌های D/W/M + سایز لیبل‌ها | ✅ راند ۱۶۵ (binary_search_*، identity هم‌تایم‌فریم، backfill tape برای فراخوانی تکی، ‏in_seconds با آرگومان، payload آپشن‌ها + سایز رشته‌ای + ‏==‎؛ تست ۲۹ چک + E2E زنده ۱۱ چک) |
| PSAR خالی + ممیزی Style | ✅ راند ۱۶۶ (کرنل Wilder برای ta.sar؛ ردیف PlotCandle/hline؛ سکشن Graphic objects؛ ورودی‌ها در لجند؛ تست ۱۷ چک + E2E زنده ۱۳ چک) |
| منوی استایل پلات + Price line | ✅ راند ۱۶۷ (۱۱ استایل TV + steplinebr؛ تست ۱۳ چک + E2E زنده ۱۳ چک) |
| کراس‌سیمبل ۱a (هیستوری هم‌تایم) | ✅ راند ۱۶۸ (fetch نماد دوم + join زمانی + `[k]` کراس؛ تست ۸ چک + E2E زنده ۶ چک) |
| کراس‌سیمبل ۱b (کراس‌تایم) | ✅ راند ۱۶۹ (باکت روی آرایه نماد دوم + کش per-symbol/TF + prefetch span؛ تست ۱۳ چک + E2E زنده ۶ چک) |
| کراس‌سیمبل ۱c (زنده + داینامیک) | ✅ راند ۱۷۰ (تیک نماد دوم + fetch-and-retry + dry؛ تست ۱۴ چک + E2E زنده ۶ چک) |
| بک‌تستر ۲a (هسته سفارش) | ✅ راند ۱۷۱ (entry/exit/order/close/cancel + فیل نکست‌اوپن + گترها؛ تست ۲۸ چک) |
| بک‌تستر ۲b (حساب) | ✅ راند ۱۷۲ (سرمایه/کمیسیون/slippage، کمیت cash/percent، trailing، equity و stats؛ تست ۲۰ چک) |
| بک‌تستر ۲c (پنل) | ✅ راند ۱۷۳ (تب Strategy Tester: خلاصه + پوزیشن + جدول تریدها؛ E2E زنده ۹ چک) |
| پایداری provider (stall) | ✅ راند ۱۷۴ (trade روی executor + سقف زمانی؛ واچ‌داگ ping/pong؛ سقف prefetch؛ تست ۵+۱۱ چک) |
| ناسازگاری واحد `time` در HTF-aggregate (ثانیه در برابر ms) | 🔶 باز (کشف‌شده در جارو؛ هر دو مسیر یک مقدار می‌دهند — تغییرش ریسک رگرسیون دارد) |

## ۱۰. آیتم تقویمی شناخته‌شده (اکتبر ۲۰۲۶ — ✅ راند ۱۹۹ بسته شد)
- `verify_pine78` §۳ («ساعت سشن FR/LN باید 9 محلی باشد») از اول اکتبر ۲۰۲۶ می‌افتاد (‏`{"FR":10,"LN":10}` در برابر انتظار 9). ریشه دو باگ انجینی بود نه فیxture: (۱) write داخل تابع اسکوپ caller را capture می‌کرد (`d` داخلی ‏sundayOfMonth پارام صداکننده را بازنویسی می‌کرد — فیکس fnBase)؛ (۲) ‏dayofweek خام ۰-۶ برمی‌گرداند به‌جای قرارداد رسمی ۱-۷ (آخرین یکشنبه اکتبر را ۲۶ می‌داد به‌جای ۲۵). هر دو فیکس + ‏time در HTF به ms (ثانیه بود)؛ ‏verify_pine78 حالا ۲۹/۲۹ سبز است.
