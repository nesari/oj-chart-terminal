# BUGFIX — Round 82 (v1.9.33): رفع دو خطای دیده‌شده در لاگ diagnostics کاربر

## گزارش کاربر

> «اوکیه ولی موقع باز شدم ی خطا خورد سیستم لاگ میفرستم»

فایل `mt5-diagnostics--031qi-2026-09-15-03-39-42.log` (۱۵ رکورد، ۳ تا ERROR) بررسی شد.

## خطای ۱ (مهم) — `prompt() is not supported.` در Pine Editor

**رکوردهای لاگ:**
```
11 | ERROR | prompt() is not supported. | pine-editor.js:185
12 | ERROR | prompt() is not supported. | pine-editor.js:193
```

**ریشه:** دو دکمه در Pine Editor — **New script** (خط ۱۸۵) و **Rename script** (خط ۱۹۳) — از
`window.prompt()` استاندارد وب استفاده می‌کردند. **Electron اصلاً `prompt()` را پیاده‌سازی نمی‌کند**
(بر خلاف `alert()`/`confirm()` که کار می‌کنند) — در محیط دسکتاپ بدون کروم مرورگر، Chromium آن را
silent به `null` تبدیل می‌کند و فقط در کنسول هشدار «prompt() is not supported.» می‌دهد. یعنی این
دو دکمه عملاً **هیچ‌کاری نمی‌کردند** — کاربر روی «اسکریپت جدید» یا «تغییر نام» کلیک می‌کرد و هیچ
اتفاقی نمی‌افتاد.

**رفع:**
- تابع مشترک `U.promptDialog(message, defaultValue)` در `core/util.js` اضافه شد — یک دیالوگ
  in-app واقعی (`Promise<string|null>`)، با همان مارک‌آپ/استایل `#popup-layer` /
  `.dialog-backdrop` / `.dialog` که بقیه‌ی دیالوگ‌های اپ (مثل تنظیمات اندیکاتور) از قبل استفاده
  می‌کنند — یعنی ظاهرش با بقیه‌ی اپ یکی است، نه یک باکس مرورگری.
  Enter = تأیید، Escape/کلیک بیرون/ضربدر = لغو (دقیقاً رفتار `prompt()` واقعی).
- هر دو دکمه در `panels/pine-editor.js` به `await U.promptDialog(...)` تغییر کردند.
- کل کدبیس برای بقیه‌ی موارد `prompt(` جست‌وجو شد — جای دیگری استفاده نشده بود.

## خطای ۲ — `[object Event]` بلافاصله بعد از بوت

**رکورد لاگ:**
```
3 | ERROR | error | [object Event] | {"msg":"[object Event]"}
```

**ریشه:** «تور crash net» سراسری در `platform/electron/loghost.js` روی `window` با
`addEventListener('error', fn, true)` (فاز capture) ثبت شده — این فاز، **خطاهای بارگذاری منابع**
(img/script/link که ۴۰۴ می‌شوند) را هم می‌گیرد، نه فقط خطاهای واقعی جاوااسکریپت. چنین رویدادی یک
`Event` ساده است (نه `ErrorEvent`) و `.message`/`.error` ندارد، پس فرمت‌کننده‌ی لاگ (`fmtEv`) به
fallback نهایی‌اش می‌افتاد: `String(ev)` = `"[object Event]"`. زمان‌بندی (بلافاصله بعد از boot،
قبل از تلاش لاگین) و نبود `<link rel="icon">` در `index.html` نشان می‌دهد علت محتمل، **پراب
خودکار favicon.ico توسط Chromium** است که چون فایلی برایش تعریف نشده بود، ۴۰۴ می‌خورد.

**رفع:**
1. `<link rel="icon" href="assets/logo.png">` به `index.html` اضافه شد — دیگر پراب ناموفق انجام
   نمی‌شود.
2. در `loghost.js`، هندلر `error` حالا رویدادهای بارگذاری منبع (`ev.target` یک المنت DOM است، نه
   `window`) را از خطای واقعی جاوااسکریپت جدا می‌کند: این‌ها با سطح `warn` و پیام مفید (تگ + URL
   ناموفق) لاگ می‌شوند، بدون toast خطا — به‌جای این‌که به‌اشتباه به‌عنوان یک کرش گزارش شوند.
   این یعنی حتی اگر در آینده یک تصویر/اسکریپت دیگر لود نشود، دیگر با یک پیام مبهم
   «[object Event]» گیج‌کننده نخواهد بود.

## فایل‌های تغییریافته
`src/renderer/js/core/util.js`, `src/renderer/js/panels/pine-editor.js`,
`src/renderer/css/app.css`, `src/platform/electron/loghost.js`, `src/renderer/index.html`.

همه با `node --check --input-type=module` سینتکس‌چک شدند.
