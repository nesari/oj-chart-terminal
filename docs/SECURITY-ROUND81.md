# SECURITY — Round 81 (v1.9.32): سخت‌سازی CSP، تأیید یکپارچگی Electron، شفاف‌سازی localStorage

این راند در پی یک بررسی امنیتی/فنی کامل روی برنامه انجام شد (کل base code، با تمرکز ویژه روی موتور Pine Script).
سه مورد از چهار موردِ «نیاز به بررسی دقیق‌تر» که در آن بررسی مطرح شده بود، اینجا نهایی شدند.

## ۱) حذف `'unsafe-inline'` از `style-src`

**قبل:** ۲۵ محل در ۱۱ فایل رندرر، رنگ/موقعیتِ پویا (رنگ انتخابی کاربر برای یک ترسیم، رنگ نماد در Compare،
رنگ نقطه‌ی وضعیت یک اندیکاتور Pine، موقعیت px برچسب محور زمان) را مستقیماً به‌صورت رشته داخل
`innerHTML` می‌نوشتند: `<i style="background:${x}"></i>`. چون این مقدار در زمان اجرا ساخته می‌شود،
`style-src` مجبور بود `'unsafe-inline'` داشته باشد، وگرنه هیچ‌کدام رندر نمی‌شدند.

**ریسک:** چون `script-src` این اجازه را نداشت، بیشترین آسیب ممکن از این مسیر تزریق CSS بود
(نه اجرای جاوااسکریپت) — عملاً محدود به نشت دیتا از طریق تکنیک‌های CSS-exfiltration در سناریوی
XSS فرضی. با این حال حذف کامل `'unsafe-inline'` سطح حمله را برای همیشه می‌بندد.

**راه‌حل:**
- مقادیر **ثابت** (`display:none`, `width:auto`, `flex-direction:row...`) → کلاس‌های CSS جدید در
  `app.css` (`.u-invisible`, `.u-checkbox-inline`, `.u-row-inline`, `.u-dlg-note`, `.u-ml-auto-sm`,
  `.u-fs12`, `.u-ml2`, `.u-err-color`, `.n-imp-*`, `.dot-ok/.dot-error/.dot-idle`).
- مقادیر **پویا** (رنگ/موقعیت واقعاً runtime) → به‌جای نوشتن در رشته‌ی `innerHTML`، بعد از درج
  در DOM با `el.style.background = x` (تنظیم مستقیم CSSOM) اعمال می‌شوند. این روش از نظر مرورگر
  «inline style attribute» محسوب نمی‌شود و مشمول محدودیت `style-src` نیست.
- ۳ مورد `el.style.cssText = '...'` هم پیدا و به خواص جداگانه (`el.style.padding = ...` و مشابه)
  تبدیل شد — چون `cssText` هم مثل `setAttribute('style', ...)` رفتار می‌کند و مشمول CSP است.

**فایل‌های تغییریافته:**
`panels/news.js`, `panels/watchlist.js`, `panels/alerts.js`, `drawing/ui.js`, `drawing/engine.js`,
`chart/pine-ui.js`, `chart/toolbar.js`, `chart/compare.js`, `chart/manager.js`,
`chart/pine-render-adapter.js`, `chart/indicators-ui.js`, `renderer/css/app.css`, `renderer/index.html`.

**نتیجه در `index.html`:**
```
style-src 'self' file:
```
(بدون `'unsafe-inline'`)

همه‌ی فایل‌های تغییریافته با `node --check --input-type=module` سینتکس‌چک شدند.

---

## ۲) تأیید یکپارچگی باینری Electron (زنجیره‌ی تأمین)

**مشکل:** `run-demo.bat`/`run-mt5.bat` در اولین اجرا `ELECTRON_MIRROR` را روی یک آینه‌ی غیررسمی
(`npmmirror.com`) تنظیم می‌کردند تا دانلود در شبکه‌های محدودشده کار کند. نصب‌کننده‌ی خود پکیج
Electron یک checksum را هم چک می‌کند، اما آن checksum هم از **همان mirror** خوانده می‌شود —
یعنی اگر mirror یک روز compromise شود، می‌تواند هم باینری دستکاری‌شده و هم یک `SHASUMS256.txt`
جعلی و هم‌خوان با آن را سرو کند، بدون این‌که هیچ خطایی دیده شود.

**راه‌حل:** اسکریپت جدید `scripts/verify-electron.js`:
1. نسخه‌ی نصب‌شده‌ی Electron را از `node_modules/electron/package.json` می‌خواند.
2. فایل zip کش‌شده (محل کش پیش‌فرض Electron روی ویندوز: `%LOCALAPPDATA%\electron\Cache`) را پیدا و SHA-256 آن را حساب می‌کند.
3. چک‌سام رسمی را مستقیماً از **GitHub Releases** (`github.com/electron/electron`) می‌گیرد —
   منبعی مستقل از mirror.
4. اگر دو مقدار مغایرت داشتند، اجرا با کد خطا متوقف می‌شود و هیچ‌جا electron.exe اجرا نمی‌شود.
5. اگر GitHub در دسترس نبود (شبکه‌ی محدود)، فقط هشدار می‌دهد و اجازه‌ی اجرا را می‌دهد — چون
   هدف این اسکریپت «تشخیص تخریب»، است نه اضافه‌کردن یک وابستگی سخت به یک دامنه‌ی دیگر.

هر دو `run-demo.bat` و `run-mt5.bat` قبل از اجرای `electron.exe` این اسکریپت را صدا می‌زنند
و در صورت شکست، متوقف می‌شوند.

---

## ۳) شفاف‌سازی محتوای `localStorage`

**بررسی:** README ادعا می‌کرد drawings/favorites/alerts در `localStorage` ذخیره می‌شوند. بررسی اول
(round قبلی) به‌اشتباه این را رد کرده بود چون grep فقط دنبال رشته‌ی تحت‌اللفظی `localStorage` در
فایل‌های UI می‌گشت و لایه‌ی انتزاعی `src/core/env.js` (`ENV.storage.get/set`) را ندید — که واقعاً
مسیر واحد و رسمی پروژه برای پرسیستنس است (نگاه کنید به `src/core/state.js`).

**نتیجه‌ی نهایی (تأییدشده با ردیابی همه‌ی مصرف‌کننده‌ها):**
- بله، `localStorage` واقعاً محل ذخیره‌ی drawings (`mt5_drawings`)، watchlist، تنظیمات چارت
  (`mt5_settings`)، تمپلیت‌های ابزار (`mt5_tool_tpl`)، اسکریپت‌های Pine ذخیره‌شده، تایم‌فریم‌های
  دلخواه، و... است — این با README همخوانی داشت.
- **اما** هیچ‌کدام از این کلیدها credential/token/رمز نیستند. رمز عبور حساب MT5 مسیر کاملاً جدایی
  دارد: کانال IPC `accounts-save` در `main.js` → رمزنگاری با `safeStorage`/DPAPI → ذخیره در دیسک.
  این دو مسیر هرگز باهم قاطی نمی‌شوند.
- یعنی از نظر امنیتی مشکلی نیست — این دقیقاً همان الگویی است که اکثر اپ‌های دسکتاپ برای تنظیمات/
  حالت غیرحساس کاربر استفاده می‌کنند؛ فقط مستندات (README) دقیق‌تر شد تا این تفکیک صریح باشد.

**راه‌حل:** به‌روزرسانی بخش «Notes» در `README.md` با فهرست دقیق کلیدها و تأکید صریح که
credential از این مسیر عبور نمی‌کند.

---

## ۴) `pine/stdlib/request.js` (بدون تغییر کد — فقط تأیید)

در بررسی قبلی کل پوشه‌ی `src/core/pine/` (اینترپرتر + stdlib) خط‌به‌خط از نظر `fetch`, `XMLHttpRequest`,
`require`, `fs.*`, `process.*`, `child_process`, `ipcRenderer` جست‌وجو شد — هیچ‌کدام پیدا نشد.
`request.security_lower_tf` فقط روی `rt.env.intrabars` (داده‌ی از پیش دریافت‌شده از پروایدر) کار
می‌کند و کاملاً آفلاین است. نیازی به تغییر کد نبود؛ تنها توصیه‌ی باقی‌مانده (خارج از دامنه‌ی این
راند) اجرای fuzz test روی ورودی‌های Pine برای اطمینان از عدم DoS با ورودی‌های بدخواهانه (تودرتوی
عمیق/حلقه‌ی بی‌نهایت) است.
