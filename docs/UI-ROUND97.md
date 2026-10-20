# UI-ROUND97 — حذف باکس اسکن سرور (Network Rescan) از صفحهٔ لاگین

- تاریخ: سپتامبر ۲۰۲۶
- نسخه: 1.9.51 → **1.9.52**
- نوع: حذف UI (به‌درخواست کاربر) + پاک‌سازی کد مرده

## درخواست کاربر

«این بخش انتخاب سرور رو هم از بخش لاگین حذف کن» — اسکرین‌شات باکس قرمز دور بخش **Network Rescan** («No server to scan yet — type your broker's server (or account) above.») در صفحهٔ لاگین.

## آنچه حذف شد

| # | فایل | تغییر |
|---|------|-------|
| 1 | `src/renderer/index.html` | مارکاپ `#srv-scan` حذف شد: دکمهٔ Network Rescan (`#srv-rescan`)، آیکونش (`#srv-rescan-ic`)، لیست سرورها (`#srv-list`) و پیام خالی. کامنت ROUND97 جایگزین شد. |
| 2 | `src/renderer/js/ui/login.js` | زنجیرهٔ مردهٔ ROUND55 حذف شد: `SRV_IC`، `srvToken`/`srvManual`/`srvScanned`، `srvSavedDemo()`، `srvTier()`، `renderServers()`، `scanServers()`، `applyServerScan()` و دو کال‌سایت (در `apply()` و رندر آیکون rescan). فایل ۵۰۹ → ۳۷۵ خط. |

## آنچه عمداً باقی ماند

- **قابلیت درون‌برنامه‌ای**: منوی broker-servers نوار پایین (`toolbar.js`) همان Network Rescan + لیست سرورها با پینگ + سوییچ را دارد و مالک آن است — مشابه سابقهٔ راند ۸۴ (حذف باکس refresh-rate از لاگین، مالکیت درون‌برنامه‌ای).
- `switchServer()` و `savedRefreshRate()` در `login.js`: رویداد `mt5-switch-server` (سوییچ سرور درون‌برنامه‌ای) و مسیر Connect به آن‌ها وابسته‌اند.
- **فیلد Server** (`#mt5-server`): داخل باکس قرمز کاربر نبود و مسیر Connect مستقیماً می‌خواندش — دست‌نخورده.
- CSS مرتبط (`app.css`، بلوک ROUND55): کلاس‌های `.srv-rescan`/`.srv-row`/`.srv-bars` را منوی درون‌برنامه‌ای هم مصرف می‌کند — دست‌نخورده.
- منطق لاگین، connect، پروایدرها، پروتکل وایر، کش راند ۹۵ — صفر خط تغییر.

## تایید

- `node --check src/renderer/js/ui/login.js` → OK.
- grep: هیچ ارجاع باقی‌مانده به `SRV_IC` / `srvToken` / `srvManual` / `srvScanned` / `srvSavedDemo` / `srvTier` / `renderServers` / `scanServers` / `applyServerScan` / `srv-scan` / `srv-rescan` / `srv-list` در `login.js` (فقط در کامنت توضیحی).
- grep: `savedRefreshRate` / `switchServer` / `mt5-switch-server` / `connect` سرجایشان هستند.
- بدون `#srv-scan`، مسیرهای قبلی scan همگی no-op بودند (null-guarded)؛ حالا حتی آن مسیرهای مرده هم حذف شده‌اند — در صفحهٔ لاگین دیگر هیچ اسکن شبکه‌ای خودکار رخ نمی‌دهد.
