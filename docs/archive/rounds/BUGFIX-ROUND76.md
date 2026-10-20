# BUGFIX — راند ۷۶ (v1.9.27) — کرش دیالوگ تنظیمات ۷۸۶ Zones («Cannot set property 'type' of #<HTMLSelectElement>»)

## گزارش کاربر

«اندیکاتوری که من دارم یک بخش تنظیمات دارد؛ وقتی روی چرخ‌دنده می‌زنم که بروم داخل تنظیماتش این ارور را می‌دهد» + لاگ Diagnostics + سه اسکرین‌شات از پنل تنظیمات اندیکاتور در مرجع (TradingView) برای اینکه مشخص باشد اندیکاتور دقیقاً چه تنظیماتی دارد.

## خطای لاگ (Diagnostics export)

```
ERROR | error | Cannot set property type of #<HTMLSelectElement> which has only a getter
at openSettingsDialog (pine-ui.js:441) — هنگام کلیک روی چرخ‌دندهٔ لجند Pine
```

نکتهٔ مثبت: قفل‌شدن UI راند قبل دیگر رخ نداد — دیالوگ به‌لطف راند ۷۵ «fail-safe» شد (لایه بسته و پاک می‌شود و فقط توست خطا می‌آید)؛ این گزارش، خطایِ «ساخت» بود، نه انجماد رابط.

## ریشهٔ باگ (BUG-74-E) — دو لایه

1. **لایهٔ موتور (اصلی):** گزینه‌های `input.string(options=[...])` از پارسر به‌صورت **پروکسی آرایهٔ Pine** (`{__pineArray: true, items: [...]}`) به `register()` می‌رسند و همان‌طور خام در تعریف input ذخیره می‌شدند؛ مصرف‌کنندهٔ رندرر (`openSettingsDialog`) آن را با `d.options || []` می‌خواند — شیء truthy است ولی `.length` ندارد → شرطِ «بدون گزینه» به‌اشتباه برقرار می‌شود. اثر جانبی خاموش: اعتبارسنجی «snap به گزینهٔ معتبر» در `strInput` هم هرگز اجرا نمی‌شد (پروکسی `.some` هم ندارد).
2. **لایهٔ DOM:** در شاخهٔ «بدون گزینه»، کد روی همان `<select>` می‌نوشت `inp.type = 'text'` — در حالی که `HTMLSelectElement.type` **فقط-خواندنی** است → `TypeError` و شکست کل ساخت دیالوگ.

اسکریپت‌های قبلی (RSI/EMA/MACD/Bollinger) هیچ `input.string` نداشتند، برای همین این مسیر تا ورود ۷۸۶ Zones هرگز اجرا نشده بود (۷ رشته با options، ۲ source، ۴۲ bool، ۱۱ color، ۸ int = ۷۰ ورودی).

## رفع

1. **موتور** (`core/pine/stdlib/inputs.js`): تابع `normalizeOptions()` — گزینه‌ها یک‌بار در لحظهٔ ثبت به آرایهٔ معمولی JS از رشته‌ها نرمال می‌شوند (پروکسی `.items` و آرایهٔ خام، هر دو پشتیبانی می‌شوند)؛ `register` و `strInput` هر دو از نسخهٔ نرمال استفاده می‌کنند و اعتبارسنجی snap اکنون واقعاً کار می‌کند.
2. **دیالوگ** (`chart/pine-ui.js`): شاخهٔ string بازنویسی شد — خواندن امن گزینه‌ها (آرایهٔ معمولی یا پروکسی)؛ با گزینه → `<select>` واقعی؛ بدون گزینه → `<input type="text">` واقعی (هیچ‌گاه نوشتن روی `select.type`)؛ مقدار null-safe.
3. **چیدمان TV-پارتی** (از اسکرین‌شات‌های مرجع کاربر): ورودی‌های هم‌کلید `inline=` حالا در **یک ردیف افقی** می‌نشینند («Enable | Type ▾»، «Length | Source»، «Color | style | width»، «SY|TK|HK|FR|LN|NY»، «Main|14|18|30») — ۱۹ ردیف برای ۷۸۶ Zones؛ برچسب‌های بدون عنوان دیگر شناسهٔ خام (`ig:…`) نشان نمی‌دهند؛ عرض دیالوگ 380→460px.
4. **باگ CSS جانبی که حالا پیدا شد** (`css/app.css`): قانون عمومی `.dialog label { flex-direction: column }` با specificity بالاتر از `.pine-inp`، برچسب هر ورودی را بالای کنترلش می‌چسباند (در راند قبل پنهان مانده بود چون دیالوگ اصلاً باز نمی‌شد) → چیدمان سطری حالا با `.dialog label.pine-inp` در (0,2,1) بازاظهار می‌شود.

## تحقیق و آزمون

- پروب Node روی فیکسچر واقعی 786-zones.pine: `collectInputs` = ۷۰ تعریف؛ هر ۷ گزینهٔ رشته‌ای اکنون آرایهٔ معمولی (`["Fixed","End of Day","End of Chart"]` و...)؛ رنگ‌ها رشتهٔ CSS و sourceها رشتهٔ ساده‌اند.
- `tests/unit/verify_pine74.mjs`: همان **۴۷/۴۷** سبز (موتور دست‌نخورده از نظر ریاضی/اجرا).
- `tests/e2e/e2e_pine75.py` (رگرسیون راند ۷۵، RSI): همهٔ چک‌ها سبز.
- **e2e جدید `tests/e2e/e2e_pine76.py`** (هدلس Chromium روی پرووایدر دمو — بازتولید دقیق سناریوی کاربر با خود ۷۸۶ Zones): چسباندن سورس در ادیتور → کامپایل سبز → Add to chart → کلیک چرخ‌دنده → **دیالوگ با هر ۷۰ ورودی و تایپ‌های درست** (۴۲ checkbox، ۱۱ color، ۸ number، ۹ select با گزینه‌های واقعی TV) → ویرایش Days Back → Ok → بستن تمیز بدون backdrop باقی‌مانده → بازسازی سبز → اثبات عدم قفل (بازشدن دیالوگ Indicators بلافاصله پس از آن) → **صفر خطای صفحه در کل سشن** + اسکرین‌شات تأیید بصری (`shots/r76-786-settings.png`).

## diff

- **تغییر**: `core/pine/stdlib/inputs.js` (normalizeOptions + snap واقعی)، `chart/pine-ui.js` (شاخهٔ string + buildInput/inline-runها)، `css/app.css` (specificity برچسب + ردیف inline + عرض دیالوگ)، package.json (۱.۹.۲۷)؛ **جدید**: `docs/archive/rounds/BUGFIX-ROUND76.md`، `tests/e2e/e2e_pine76.py`؛ به‌علاوه CHANGELOG.
