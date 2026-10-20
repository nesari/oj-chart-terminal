# BUGFIX-ROUND123 — نمایش لایو اطلاعات تب‌ها + اصلاح کامل Undock/Dock-back

**نسخه:** 1.9.78 · **تاریخ:** سپتامبر ۲۰۲۶ · **محدوده:** `src/renderer/js/chart/tabs.js`، `main.js`، `preload.js` + تست‌ها

دو اشکالِ گزارش‌شدهٔ کاربر روی راند ۱۲۲ (v1.9.77):

> «همچنان روی تب‌ها مواردی که گفتم نمایش داده نمی‌شود؛ فقط اسم نماد و یک خط چین (—) دیده می‌شود.»
> «وقتی یک تب جدید اضافه می‌کنم و Undock می‌کنم، دوباره نمی‌توانم به پنجرهٔ اصلی بچسبانمش.»

---

## FIX A — چرا تب فقط «نماد + —» نشان می‌داد؟

### ریشه (باگ این‌بار واقعاً دوتایی بود)

1. **قلاب تیک بدون گیرنده فراخوانی می‌شود.** فید (`core/feed.js`) هر قلاب ثبت‌شده در
   `App.feed.onTick` را به شکل `f(t.symbol, t.price, …)` صدا می‌زند — یعنی همان تابعِ
   لختی، بدون شیء میزبان. `Tabs.onTick` با `push(Tabs.onTick)` ثبت شده بود و بدنه‌اش
   به `this.q` اشاره می‌کرد. در ماژول ES (همیشه strict)، `this` در آن حالت
   `undefined` است؛ پس **اولین تیکِ هر نماد** در `this.q[symbol]` خطای TypeError
   می‌داد و `try { f(...) } catch (e) {}`ِ خود فید آن را بی‌صدا بلعیده می‌شد. نتیجه:
   `Tabs.q` همیشه خالی می‌ماند و `_paintQuotes` هیچ‌وقت از «—» جلوتر نمی‌رفت.
   (واچ‌لیست سالم ماند چون بدنه‌اش به‌جای `this` مستقیماً `Watchlist` را می‌بندد.)

2. **حتی پس از رفع ۱، نمادهای کم‌معامله تا نخستین تیک «—» می‌ماندند.** تبِ تازه‌ساخت
   یا بازیابی‌شده هیچ قیمت اولیه‌ای نداشت.

### اصلاح

- ثبت قلاب با آررو‌فانکشن: `(App.onTickHooks = App.onTickHooks || []).push((symbol, price) => Tabs.onTick(symbol, price))`
  و بدنهٔ `onTick` به سینگلتون اشاره می‌کند (`Tabs.q[symbol]`) — دیگر هیچ وابستگی به `this`.
- **Seed از پاسخ D1:** همان درخواستی که پایهٔ درصد تغییر را می‌گیرد (هر ۵ دقیقه)،
  کلوزِ جدیدترین کندل روزانه را به‌عنوان آخرین قیمت seed می‌کند (`if (bars.length && !Tabs.q[sym])`).
  جهت فلش از کلوز روز قبل (یا open همان کندل در تاریخ کوتاه). اولین تیک واقعی seed را بازنویسی می‌کند.
- نتیجه: بلافاصله بعد از ورود (~۱.۵ ثانیه) هر تب `نماد قیمت ▲/▼ ±x.xx%` نشان می‌دهد؛
  سپس با هر تیک، قیمت و رنگ (سبز/قرمز) به‌روز می‌شود — دقیقاً مثل تب‌های تریدینگ‌ویو.

---

## FIX B — چرا Dock-back «تب جدیدِ» جداشده کار نمی‌کرد؟

### ریشه

طرح راند ۱۲۲ رکورد تب را با یک کلید `localStorage` (`mt5_tab_dockback_*`) منتقل می‌کرد:
solo کلید را می‌نوشت و بلافاصله IPC می‌زد؛ میزبان همین‌که پیام می‌رسید
`localStorage` را برای پیشوند `mt5_tab_dockback_` اسکن می‌کرد. اما **Electron تغییرات
localStorage را بین دو رندررِ در حال اجرا به‌طور قابل‌اعتماد منتشر نمی‌کند** (اصل
`file://` + فلاش دسته‌ای به دیسک). اسکن میزبان خالی برمی‌گشت، `return` بی‌صدا اتفاق
می‌افتاد، ackی ارسال نمی‌شد و پس از ۵ ثانیه تب با پیام «Main window is not available»
در پنجرهٔ جداشده می‌ماند. جهت Undock کار می‌کرد چون پنجرهٔ تازه هنگام بارگذاری،
localStorage را «از نو» می‌خواند (~۱ ثانیه تأخیر طبیعی) — همان ریس آن‌جا هم نهفته بود.

### اصلاح — رکورد داخل خود IPC سفر می‌کند

| مسیر | قبل | اکنون |
|---|---|---|
| Undock | `tabs:undock {soloId, mode}` + کلید `mt5_tab_solo_*` | `tabs:undock {soloId, mode, rec}` → main رکورد را پس از `validDockRec` در `pendingSolo` نگه می‌دارد (کلید localStorage فقط fallback) |
| بوت solo | خواندن کلید `mt5_tab_solo_*` | `tabs:claim {soloId}` — تحویل یک‌باره از حافظهٔ main؛ نبودِ رکورد → همان مسیر قبلی (fallback/adopt) |
| Dock-back | نوشتن `mt5_tab_dockback_*` + IPC | `tabs:dockback {soloId, rec}` — رکورد داخل payload؛ main آن را به پنجرهٔ نوار تب می‌فرستد |
| دریافت میزبان | اسکن localStorage | `_acceptDock(p)` رکورد را از `p.rec` می‌گیرد (`validRec`)، فعالش می‌کند و `dockAck {soloId, ids:[rec.id]}` می‌دهد؛ کلیدهای قدیمی هم best-effort پاک می‌شوند |

### سخت‌سازی‌های تکمیلی (همهٔ حالت‌های Undock)

- **`tabsHostWindow()`**: اگر پنجرهٔ اصلی بسته شده باشد و یک solo خودش را promote کرده
  باشد، درخواست dock-back به همان پنجرهٔ بدون `solo=` مسیریابی می‌شود (قبلاً فقط `mainWindow`).
- **اعتبارسنجی `validDockRec`**: id با `[\w-]{1,64}`، حداکثر ۱۶ پنل، نماد اجباری،
  سقف ۱۲۸KB کل JSON، حفظ `indicators/pineScripts` (type-checked) — همان لایهٔ امنیتی راند ۲۸.
- **بدون نشتی حافظه**: `pendingSolo` هم روی `closed` و هم در شکست ساخت پنجره پاک می‌شود؛
  `tabs:claim` یک‌باره است (ورودی در هر حالت مصرف می‌شود).
- **بستن پنجرهٔ جداشده = رفتن تب (کروم)**: فروشگاه per-solo در `beforeunload` حذف می‌شود.
- رفتارهای درستِ قبلی دست‌نخورده ماندند: rollback کامل در شکست Undock، کم‌رنگ شدن تب
  در مسیر dock-back + تایم‌اوت ۵ ثانیه‌ای، promote خودکار وقتی هیچ پنجرهٔ میزبانی نیست،
  بستن پنجرهٔ مبدأ هنگام خروج آخرین تب.

---

## تست‌ها

- `scripts/test_round123_fixes.mjs` — ۳۵ بررسی: قراردادهای منبع (قلاب آررو، seed،
  payload-based dock-back، اعتبارسنج main، claim یک‌باره، مسیریابی tabsHostWindow) +
  آینه‌های رفتاری (معنای receiver-less، منطق seed، قواعد validator، claim یک‌باره، routing).
- قراردادهای `test_round121_tabs.mjs` (۴۴) و `test_round122_tabs_live_undock.mjs` (۴۸)
  به رفتار تازه ارتقا یافت — هر سه سویییت سبز.
- رگرسیون کامل ۲۳ سویییت + `node --check` روی `tabs.js`، `main.js`، `preload.js`.

## فایل‌های تغییر یافته

| فایل | تغییر |
|---|---|
| `src/renderer/js/chart/tabs.js` | FIX A (قلاب + seed) + FIX B (claim/dockback/accept + beforeunload solo) |
| `main.js` | `validDockRec`، `pendingSolo`، `tabs:claim`، ارسال رکورد در dock-request، `tabsHostWindow` |
| `preload.js` | پل `claimTab` |
| `scripts/test_round123_fixes.mjs` | جدید (۳۵ بررسی) |
| `scripts/test_round121_tabs.mjs` / `test_round122_tabs_live_undock.mjs` | ارتقای قراردادهای stale |
| `package.json` / `CHANGELOG.md` | 1.9.78 + ورودی راند ۱۲۳ |
