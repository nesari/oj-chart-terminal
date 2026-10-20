# UI-ROUND96 — برندینگ: حذف زیرنویس لاگین و تغییر نام پنجره به OJ Chart

- تاریخ: سپتامبر ۲۰۲۶
- نسخه: 1.9.50 → **1.9.51**
- نوع: تغییر UI متنی (بدون هیچ تغییر منطقی)

## درخواست کاربر

1. «توی صفحهٔ لاگین یک متن دارم: TradingView-style charts · MetaTrader 5 data — اینو می‌خوام حذفش کنی.»
2. «اسم اپ OJ Chart هست، ولی اون بالا سمت چپ اسم اپ رو نوشته MT5 Chart Terminal — اونو هم عوض کن بنویس OJ Chart.»

## تغییرات

| # | فایل | تغییر |
|---|------|-------|
| 1 | `src/renderer/index.html` | حذف کامل خط `<div class="login-sub">TradingView-style charts &middot; MetaTrader 5 data</div>` از ستون برند صفحهٔ لاگین. آیکون و عنوان «OJ Chart» دست‌نخورده ماندند. |
| 2 | `src/renderer/css/app.css` | حذف قاعدهٔ یتیم `.login-sub` (تنها مصرف‌کننده‌اش همان div حذف‌شده بود؛ grep کل ریپو تأیید کرد هیچ ارجاع دیگری وجود ندارد). |
| 3 | `src/renderer/index.html` | `<title>MT5 Chart Terminal</title>` → `<title>OJ Chart</title>`. نوار عنوان پنجرهٔ ویندوز (بالا-چپ) از همین `<title>` می‌آید چون `BrowserWindow` در `main.js` هیچ `title` ای ست نمی‌کند و هیچ `page-title-updated` handler یا `document.title` دیگری در ریپو وجود ندارد. |
| 4 | `main.js` | fallback عنوان نوتیفیکیشن هشدارها: `'MT5 Chart Terminal'` → `'OJ Chart'` (خط ۴۰۴) تا نام نمایشی اپ همه‌جا یکدست باشد. |

## خارج از محدوده (عمداً دست‌نخورده)

- منطق لاگین (`src/renderer/js/ui/login.js`)، پروایدرها، پروتکل وایر، کش راند ۹۵ — صفر خط تغییر.
- هدرهای داخلی `README.md` / `CHANGELOG.md` و هدر لاگ دیاگ (`src/core/logger.js` رشتهٔ diagnostics log) — مستندات/داخلی، نه UI؛ در صورت درخواست کاربر بعداً یکدست می‌شوند.
- `package.json` فقط `version` (برای راند‌بندی)؛ `name` داخلی npm تغییر نکرد تا مسیرهای بسته‌بندی/اسکریپت‌ها دست نخورده بمانند.

## تایید

- `node --check main.js` → OK.
- grep «TradingView-style charts» در `src/renderer/` → فقط description داخل `package.json` (متادیتای npm، نمایش داده نمی‌شود) و `README.md` (مستندات) — از صفحهٔ لاگین کاملاً حذف شد.
- grep «login-sub» → صفر ارجاع باقی‌مانده.
- `<title>` جدید فقط «OJ Chart» است و هیچ مسیر دیگری عنوان را بازنویسی نمی‌کند.
