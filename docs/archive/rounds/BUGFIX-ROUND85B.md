# BUGFIX — راند ۸۵ب (v1.9.37) — رفع «Trade Failed» در ارسال معاملات

## گزارش کاربر
معامله‌ی تستی از اپ ثبت نشد و فقط پیام «Trade Failed» نمایش داده شد؛ هیچ دلیلی برای رد شدن نشان داده نمی‌شد.

## ریشه‌یابی (مسیر کامل بررسی شد)
مسیر معامله: تیکت (`trade/ticket.js`) → `Trade.placeOrder` (`trade/state.js`) → `feed._send({'type':'trade',...})` → پروایدر (`mt5.py`/`demo.py` `trade_rpc`) → پاسخ `{type:'trade', req_id, op, ok, data|error}`.

سه ضعف واقعی پیدا و رفع شد:

### BUG-85B-A — پیام عمومی «trade failed» به‌جای دلیل واقعی (مهم‌ترین)
ردِ سطح بروکر (10016 استاپ نامعتبر، 10018 بازار بسته، 10019 موجودی ناکافی، 10026/10027 AutoTrading، 10030 filling، …) با `{'ok':false,'data':{'retcode':N,'comment':'…'}}` برمی‌گشت؛ اما `feed.js` فقط فیلد `error` را می‌خواند که در این شکل پاسخ وجود نداشت → `Error('trade failed')` بدون هیچ توضیحی.
- **رفع (`feed.js`)**: پیام خطا حالا به‌ترتیب از `m.error` → `m.data.error` → `m.data.comment` (با پیشوند `retcode N:`) ساخته می‌شود.
- **رفع (`mt5.py` / `demo.py`)**: همه‌ی opهای دارای retcode حالا هم‌زمان فیلد `error` متنی هم کنار `data` برمی‌گردانند (قرارداد یکسان در هر دو پروایدر). UIهای تیکت/داک/اورلی بدون تغییر کد از این پیام‌های کامل استفاده می‌کنند.

### BUG-85B-B — درخواست مارکت بدون فیلد `price`
مستندات رسمی MetaTrader5 برای `TRADE_ACTION_DEAL` فیلد `price` جاری را در مثال خود دارد؛ برخی نسخه‌های ترمینال درخواست مارکت بدون `price` را با 10015/10013 رد می‌کنند.
- **رفع (`mt5.py`)**: برای مارکت، `price` از تیک جاری (ask برای خرید، bid برای فروش) پر می‌شود؛ اگر تیک نباشد خطای شفاف «No quotes for SYMBOL (market closed or symbol not tradable now)».

### BUG-85B-C — AutoTrading خاموش در ترمینال (شایع‌ترین علت واقعی این گزارش)
اگر دکمه‌ی «Algo Trading» ترمینال متاتریدر سبز/فعال نباشد، همه‌ی `order_send`ها شکست می‌خورند در حالی که چارت‌ها و دیتا کاملاً سالم به‌نظر می‌رسند.
- **رفع (`mt5.py`)**: وقتی `order_send` برمی‌گرداند None، `last_error` دیکد می‌شود؛ برای 10026/10027 راهنمای عملی فارسی از فعال‌کردن دکمه اضافه می‌شود؛ در هر شکست، اگر `terminal_info().trade_allowed=false` باشد همین هشدار به پیام چسبانده می‌شود.
- **رفع (`trade/dock.js` + `trade.css`)**: چیپ قرمز چشمک‌زن «AutoTrading OFF» در نوار حساب داک (با tooltip راهنما) وقتی ترمینال اجازه‌ی معامله نمی‌دهد.
- **رفع (`trade/ticket.js`)**: تیکت قبل از ارسال، `trade_allowed=false` را بلاک می‌کند و پیام راهنما نشان می‌دهد (به‌جای شکست مبهم؛ در Demo همیشه مجاز است).

## تست
- `scripts/test_trade_rpc.py` — ۲۸/۲۸: کل جریان RPC روی WS واقعی + جدید: «هر ردی باید دلیل متنی قابل‌خواندن داشته باشد».
- `scripts/test_trade_e2e_browser.py` (جدید، Playwright/Chromium) — ۲۴/۲۴: مسیر واقعی کاربر از ورود تا بستن پوزیشن:
  boot → login (demo) → تب Trading → تیکت (حجم 0.10، SL 250pt، TP 500pt، one-click) → BUY مارکت → ثبت پوزیشن در بروکر شبیه‌ساز → سه خط Entry/SL/TP روی چارت (برچسب‌های BUY/SL/TP) → **درگ عمودی خط SL روی چارت → modify واقعی سمت بروکر (1.08199 → 1.07883)** → ردِ کلوز بیش از حجم با پیام قابل‌خواندن → Buy Limit پندینگ → رسم روی چارت → لغو از داک → کلوز ۵۰٪ → Close all → هیستوری (گروه‌بندی + خلاصه) → نوار حساب زنده → صفر خطای صفحه.
- رگرسیون: `tools/dev/round84_harness.mjs` (۱۳۵ + ۳۹۲٬۰۰۰ چک) و `scripts/test_trade_math.mjs` (۲۱/۲۱) — همه سبز.

## فایل‌های تغییر یافته (فقط در محدوده‌ی همین ایراد)
`src/core/feed.js`، `provider/mt5.py`، `provider/demo.py`، `src/renderer/js/trade/ticket.js`، `src/renderer/js/trade/dock.js`، `src/renderer/css/trade.css` + `CHANGELOG.md`، `package.json` (1.9.36 → 1.9.37).
