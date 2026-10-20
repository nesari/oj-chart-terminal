# FEATURE-ROUND87 — Custom Session دقیقه‌ای + اندیکاتورهای Pine در هر دو حالت (v1.9.44)

## درخواست کاربر (فارسی، خلاصه)
1. «الان فقط ساعت رو میشه مشخص کرد . میخوام دقیقه رو هم بشه مشخص کرد» — پنجره‌ی Custom Session باید دقیقه هم بگیرد.
2. اندیکاتور شخصی کاربر (786 Zones v5.5 — باکس‌های ناحیه‌ی باز شدن ۶ سشن Sydney/Tokyo/HongKong/Frankfurt/London/NewYork با DST و rollover سیدنی) باید:
   - **هم در حالت عادی چارت و هم در Custom Session** درست اجرا شود؛
   - اگر در Custom Session بخشی از روز انتخاب شد، «هر تعداد از باکس‌ها که داخل ناحیه‌ی زمانی انتخابی کاربر بود باید بدرستی نمایش داده بشه»؛
   - در Extend mode گزینه‌ی **End of Day** روی چارت سشن باید باکس‌ها را «تا انتهای همون ناحیه در روز امتداد بدهد و وارد روز بعدی نشود»؛ گزینه‌ی **End of Chart** مجاز است باکس‌ها را تا انتهای چارت امتداد دهد؛
   - اپ هیچ‌کدام از محدودیت‌های اکانت رایگان تریدینگ‌ویو را نباید داشته باشد.
3. **قید مهم**: فایل اسکریپت کاربر نباید داخل اپ قرار بگیرد (فقط برای مطالعه/تست فرستاده شد).

## آنچه ساخته شد

### ۱) دقیقه در Custom Session
- **`panels/gotodate.js`** — دیالوگ Go to Date → تب Custom Session: دو دراپ‌داون دقیقه‌ی `#cs-mfrom` / `#cs-mto` (۶۰ گزینه، گام ۱ دقیقه) کنار ساعت‌ها، برچسب‌های «From/To (hour:minute)»، خط اطلاعات با برچسب `HH:MM–HH:MM (Xh YYm) window` و اعتبارسنجی ثانیه‌ای (`sTo > sFrom`؛ پنجره‌ی ۰۰:۰۰–۰۰:۳۰ مجاز است). خروجی readInfo شامل `mFrom/mTo` است.
- **`core/session-math.js`** — `inSessionWindow`/`stitchBars` پارامتر دقیقه گرفتند (undefined = ۰ → سازگاری کامل با راند ۸۶)؛ `windowSec(h,m,h,m)` اضافه شد (کلمپ `hTo=24,mTo>0 → 86400`).
- **`panels/session.js`** — cfg = `{hFrom,hTo,mFrom,mTo,dFrom,dTo}` (پیکربندی قدیمی = دقیقه‌ی صفر)؛ toast با فرمت HH:MM.
- CSS: `.gd-hm` (جفت ساعت:دقیقه در یک برچسب) در `replaytrade.css`.

### ۲) اندیکاتورهای Pine در Custom Session (سیم از طریق `App.sessionHook` — بدون import cycle)
- **موتور اینترابار سشن (`chart/pine-ui.js`)**:
  - `ensureM1Cache`: وقتی سشن فعال است و نردبان پایه M1 را انتخاب کرده، اینترابارها از **کش پایه‌ی M1 سشن** (`SessionRange.m1Source` — کندل‌های روز کامل برای کل بازه) تأمین می‌شوند؛ برای بازه‌های تاریخی که کش زنده‌ی M1 هیچ نداشت، اسکریپت‌های lower-tf حالا کار می‌کنند.
  - `buildIntrabars`/`refreshLastIntrabar`: برش هر کندل چارت به بازه‌ی `[t0, t0+TF) ∩ پنجره‌ی انتخابی` فیلتر می‌شود — دمِ کندلِ ناقص (مثلاً H1 با پنجره‌ای که ۰۶:۴۵ تمام می‌شود) دیگر داده‌ی خارج ناحیه به اسکریپت نمی‌دهد.
  - نتیجه: **فقط زون‌هایی تشکیل می‌شوند که پنجره‌ی ۵دقیقه‌ای شروع‌شان داخل ناحیه‌ی انتخابی کاربر است** (تأیید e2e: فقط NY رسم شد، TK/LN غایبند).
- **گیره‌ی انتهای ناحیه (`chart/pine-render-adapter.js` + `sessionRegionEnds`)**:
  - `sessionRegionEnds(barTimes, tf, hTo, mTo)` (خالص، Node-testable): برای هر روزِ موجود در چارتِ سشن، انتهای ناحیه = `min(شروع روز + پایان پنجره، آخرین کندل همان روز + TF)`.
  - `_clampSessionEdge(o, edge, anchor)`: در paint باکس/خط، لبه‌ی دور (`right`/`x2` با `xloc.bar_time`) که از انتهای ناحیه‌ی «روزِ لنگر» عبور کند به همان انتها بریده می‌شود؛ لبه‌ای که ≥ انتهای کل چارت (`time_close` آخرین کندل) باشد عبور می‌کند (End of Chart). خارج از سشن: no-op مطلق. کشِ `_sessClampState` با کلید (طول/اول/آخر barTimes + پنجره + TF + نماد).
  - معنای کاربر: «End of Day» در سشن = تا انتهای همان ناحیه، بدون ورود به روز بعد؛ «End of Chart» = تا انتهای چارت؛ «Fixed» که از ناحیه بیرون بزند هم به انتها بریده می‌شود.

### ۳) دو باگ واقعی موتور Pine که در این تست‌ها بیرون افتاد
- **اشیای ماندگار بین اجراهای کامل** (`core/pine/interpreter.js` + `stdlib/objects.js`): `runAll`/`runChunked` متغیرهای `var` را بین اجراها حفظ می‌کردند؛ اسکریپت‌های صاحبِ `var box[]/line[]/label[]` بعد از هر ری‌ران (تغییر ورودی، لود مجدد تاریخچه، سشن تازه) به شیء کهنه `set_*` می‌زدند و اشیای خارج‌ازشهر برای همیشه با مختصات قدیمی می‌مانند. **اصلاح**: `_resetForFullRun()` در شروع هر اجرای کامل — فروشگاه اشیاء خالی + `rec.initialized=false` روی همه‌ی globalها + sites/funcInsts/histBufs تازه + `_gwEpoch++` — دقیقاً معنای full recalculation در TV (متغیر `var` فقط در طول تیک‌های real-time زنده می‌ماند، نه بین محاسبات کامل). `verify_pine80` قبلاً «leak قابل‌مشاهده» را ثابت می‌کرد؛ حالا قرارداد «runtime بازاستفاده‌شده == runtime تازه» را ثابت می‌کند.
- **فریم منطقی LWC روی چارت سشن** (`pine-render-adapter.js` `_xOf` + `session.js`): سری‌ی سشن سطرهای whitespace بین روزها دارد ولی `pane.barTimes` فشرده است؛ تبدیل زمان→اندیس با محور فشرده و اندیس→پیکسل با فریم LWC، **هر رسم xloc.bar_time را به‌ازای هر مرز روز ~۲-۳ کندل به چپ می‌کشید**. اصلاح: محور شامل فاصله‌ها (`pane._sessWithGapTimes`) در پنجره‌های سشن مبنای جست‌وجو قرار گرفت — باکس‌ها دقیقاً روی کندل‌های خودشان.

### ۴) محدودیت‌های اکانت رایگان TV
- موتور caps را از **اعلان خود اسکریپت** می‌گیرد (`max_boxes_count=500` …) و در تست با `daysBack=10 + Main+14` = ۱۲۰ باکس با GC صفر اجرا شد؛ سقفی از نوع free-tier (تعداد اندیکاتور در چارت، lower_tf، …) وجود ندارد و چند-نمونه‌ای روی یک چارت (۳ نمونه همزمان در e2e) پشتیبانی می‌شود.

## تست‌ها
- **`scripts/test_round87_math.mjs` (۳۰/۳۰)**: پنجره‌ی دقیقه (۰۴:۳۰–۰۶:۴۵)، مرزهای انحصاری، پنجره‌ی باریک ۰۰:۰۰–۰۰:۳۰، stitchBars M1/H1/D1 با دقیقه (bucket روز-آغازین، آخرین bucket ناقص)، سازگاری فراخوانی ساعت-محور راند ۸۶، `sessionRegionEnds` (روز کامل/کم‌داده/H1 با داده‌ی ناقص)، سلامت gapها.
- **`scripts/test_round87_pine.mjs` (۲۴/۲۴)** — اسکریپت **واقعی کاربر** روی موتور واقعی (فایل خارج از باندل، فقط test-side):
  - حالت عادی: ۶ باکس Main، تطبیق هر `left` با پورت مستقل DST/rollover نوشته‌شده در تست، پاکت high/low == کندل‌های M1 پنجره، Fixed = +۲۴۰دقیقه، EOD = ۲۱:۰۰ GMT روزِ تجاری (شامل سرریز سیدنی به فردا)، End of Chart = `time_close` آخرین کندل، daysBack=2/3/10.
  - سشن (پنجره‌ی NY±30/90 دقیقه، دقیقه‌ای): دقیقاً ۱ باکس (NY)، TK/LN غایب، لبه‌ی Fixed/EOD گیره می‌شود، End of Chart عبور می‌کند.
  - بدون محدودیت free-tier: ۱۲۰ باکس، GC صفر.
- **`scripts/test_round87_e2e_browser.py` (۳۱/۳۱، پروایدر دمو واقعی + کرومیوم)**: تزریق اسکریپت مثل کاربر (`PineScriptsStore.create` + `PineUI.add`)، اجرای عادی + پیکسل، دیالوگ واقعی (کلیک تب، انتخاب ساعت **و دقیقه**، برچسب `12:30–14:30`، Apply)، اعمال سشن از مسیر دیالوگ، گپ‌ها، سه نمونه Fixed/EOD/EOC روی چارت سشن، «بقعه‌ی پیکسلی» (پُر داخل ناحیه، هیچی بعد از انتهای ناحیه)، حذف TK/LN، سوییچ H1 داخل سشن با اندیکاتور زنده، Turn off → بازگشت تاریخچه‌ی زنده + no-op شدن گیره، صفر خطای صفحه.
- **رگرسیون کامل**: round86 math ۶۳/۶۳، round86 e2e ALL PASS، round86b e2e ALL PASS، trade e2e ALL PASSED، trade rpc ۲۸/۲۸، trade math ۲۱/۲۱، round86c paging ۱۹/۱۹، verify_pine74 ۴۷/۴۷، verify_pine78 ۲۹/۲۹، verify_pine80 ۱۶/۱۶ (قرارداد جدید)، bench_pine78 parity، e2e_pine78 ALL PASS، `node --check` همه‌ی JS، `py_compile` هر سه پروایدر.

## قلمرو تغییرات (hard constraint)
`core/session-math.js`، `core/pine/interpreter.js`، `core/pine/stdlib/objects.js`، `renderer/js/panels/session.js`، `renderer/js/panels/gotodate.js`، `renderer/js/chart/pine-ui.js`، `renderer/js/chart/pine-render-adapter.js`، `renderer/css/replaytrade.css` (کلاس `.gd-hm`)، `package.json`، `CHANGELOG.md`، این سند و اسکریپت‌های تست (خارج از zip). **فایل اسکریپت کاربر داخل اپ/zip نیست** — فقط `scripts/786zones-pine-source.txt` سمت تست.

## یافته‌ی جانبی پیشین (خارج از قلمرو، لمس نشد)
`e2e_pine80` گزینه‌ی «MN1: close lands on the next calendar month start» به‌ازای داده‌ی دمو (باکت‌های ~۳۱روزه‌ی پروایدر نزدیک پایان ماه) date-dependent است و در راند ۸۷ لمس نشد — مربوط به تقریب MN1 پروایدر دمو/مدیر (rounds ≤ 80) است.
