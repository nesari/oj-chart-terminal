# مقایسه ابزارهای ترسیم با TradingView — آدیت راند ۲۸۴

> مبنا: کد واقعی (`src/renderer/js/drawing/`) در برابر رفتار مستند/مشاهده‌شدهٔ TV.

## خلاصه

| سنجه | مقدار |
|---|---|
| ابزار ثبت‌شده | ۶۳ (+ ۳ ابزار مکان‌نما) |
| ابزار با schema تنظیمات | **۶۰ از ۶۰** |
| گپ «موتور می‌خواند، دیالوگ ندارد» | **۰** |
| باگ/گپ واقعی که این راند بست | **۴** |

ابزارهای مکان‌نما (`cross`, `arrowcur`, `dot`) عمداً schema ندارند: چیزی ترسیم نمی‌کنند و فقط نشانگر ماوس را عوض می‌کنند (در TV هم تب Style ندارند).

### ⚠️ یک درس مهم در روش

تحلیل خودکار اول من **غلط** بود و ۱۷ ابزار را «بدون تنظیمات» اعلام کرد. دلیل: schemaها در **دو جا** تعریف می‌شوند —
جدول `const SCHEMAS = { ... }` و بعد از آن `SCHEMAS.<tool> = [...]`. تعریف دوم در زمان اجرا برنده است و تحلیل اول فقط جدول را می‌خواند.
بعد از تصحیح تحلیل (خواندن هر دو محل)، فقط **۴ گپ واقعی** ماند که در ادامه آمده. اسناد و تست‌ها هر دو اصلاح شدند.

---

## گپ‌های واقعی که برطرف شد

### ۱. `zoomin` — هیچ schema نداشت + رنگ‌ها hardcode بود
- `TOOLS.zoomin` رنگ آبی `rgba(41,98,255,.14)` و خط‌چین `#2962ff` را مستقیم در کد نوشته بود.
- حتی اگر schema داشت، هیچ‌کدام از تنظیمات خوانده نمی‌شد.
- **اصلاح:** schema با خط + شفافیت حاشیه + پس‌زمینه، و `draw` حالا `opts.color/width/style/borderOpacity/fill/fillColor/fillOpacity` را می‌خواند.

### ۲. `flagmark` — ضخامت میله قابل تنظیم نبود
- نقاش میله را با `d.opts.width` می‌کشد، اما schema فقط `{kind:'color'}` داشت (نه `{kind:'line'}`)، پس `width` هیچ‌وقت نوشته نمی‌شد.
- **اصلاح:** `{kind:'line'}` جای `{kind:'color'}` — رنگ + ضخامت + سبک با هم.

### ۳. `fib` — مسیر مردهٔ `bgFill`
- `if (d.opts.fill || d.opts.bgFill)`، اما هیچ UI‌ای `bgFill` نمی‌نویسد.
- **اصلاح:** فقط `opts.fill` — یک منبع حقیقت.

### ۴. شکل‌های توخالی — نبود پیش‌فرض `fill`
- `circle`، `polyline`، `curve`، `dblcurve`، `rotrect` schema «Background» **داشتند**، اما factory defaults هیچ کلید `fill` نداشتند؛ پس کلید از `undefined` شروع می‌کرد.
- **اصلاح:** `fill/fillColor/fillOpacity` صریح در factory defaults (خاموش + شفافیت ۰٫۱۲).

### ۵. TV Box Extend — حالت «Both» نبود
- منوی باکس سه حالت داشت و `settings.js` هنگام باز شدن دیالوگ `extendRight` را صفر می‌کرد اگر هر دو روشن بودند.
- موتور از همیشه هر دو لبه را مستقل می‌کشد (`xa = eL ? 0 : xL`, `xb = eR ? v.pw : xR`).
- **اصلاح:** چهار حالت TV + حذف migration قدیمی.

---

## چیزهایی که بررسی شد و **سالم** بود

- `parallel` Extend (هر چهار حالت، از طریق `applyExtend` به `extendLeft/Right` نگاشت می‌شود).
- `measure`، `callout`، `emoji`، `circle`، `curve`، `dblcurve`، `polyline`، `rotrect`، `arrowmarker`، `path`، `arc` — همه schema داشتند (اعلام اول من غلط بود).
- `trend`، `hline/hray/vline/crossline`، `pitchfork*`، `fib*` اصلی، `gann*`، `elliott*`، هارمونیک‌ها، `volprofile/avwap`، `text/note`: schema کامل و بدون گپ.

---

## پوشش تست

- `tests/unit/test_round284_drawing_settings.mjs` — پارس واقعی سورس: هر ابزار schema دارد، هیچ کلید `opts.*` بی‌کنترل نیست، ادعاهای خاص، و پین رگرسیون برای schemaهایی که با `SCHEMAS.x =` تعریف شده‌اند.
- `tests/archive/e2e/e2e_round284_drawing_settings.py` — دیالوگ **واقعی** را برای ۱۵ ابزار باز می‌کند، ویجت‌ها را می‌شمارد، تیک Background را می‌زند و تغییر `opts` را می‌بیند، و روی canvas ساختگی اثبات می‌کند fill واقعاً کشیده می‌شود (روشن/خاموش).

---

## اولویت بعدی (موج بعدی)

موارد بزرگ‌تر که عمداً انجام نشدند:

1. **`callout`: حباب کامل TV** — الان مستطیل گرد است؛ TV دنبالهٔ مثلثی و جهت‌گیری چهارطرفه دارد.
2. **`measure`: قالب TV** — TV سه خط اطلاعات در باکس جدا با آیکن دارد.
3. **`volprofile` / `avolprofile`** — فقط `bins`؛ TV تعداد ردیف، Value Area، جهت و POC دارد.
4. **`ghostfeed`** — فقط `bars`؛ TV درصد forecast/رنگ/شفافیت.
5. **`posforecast`** — فقط `coeff`؛ TV سه ناحیهٔ سود/ریسک/ورود جدا.
6. **`sector` / `barspattern` / `disjoint`** — الگوی خطوط و برچسب داخلی TV نیست.
