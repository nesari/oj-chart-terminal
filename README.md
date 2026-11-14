<div align="center">

<img src="src/renderer/assets/logo.png" width="116" alt="OJchart">

# OJchart

**Professional charting for MetaTrader 5 — fast, local, and yours.**
**چارت حرفه‌ای برای متاتریدر ۵ — سریع، محلی و مال خودت.**

[![Version](https://img.shields.io/badge/version-1.9.212-c8a24a?style=flat-square)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6?style=flat-square&logo=windows&logoColor=white)](#-requirements)
[![Electron](https://img.shields.io/badge/Electron-33.4.11-47848F?style=flat-square&logo=electron&logoColor=white)](package.json)
[![Node](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![Python](https://img.shields.io/badge/Python-3.8%2B-3776AB?style=flat-square&logo=python&logoColor=white)](provider/requirements.txt)
[![License](https://img.shields.io/badge/license-MIT-2EA043?style=flat-square)](LICENSE)

[English](#english) · [فارسی](#فارسی)

<img src="docs/screenshot.png" width="100%" alt="OJchart demo chart">

</div>

---

## English

> **Status:** pre-release `1.9.x`. The Windows build is the primary target; macOS/Linux currently run demo mode.

**OJchart** is a lightweight TradingView-style charting terminal built with **Electron** and a **Python WebSocket provider**. It renders live MetaTrader 5 data or a fully local simulated feed, with drawing tools, Pine Script v6, alerts, news, replay and a complete trading stack.

### ✨ Highlights

| | |
|---|---|
| 📊 **Charting** | Seconds-to-months timeframes, 11 chart styles, 55 multi-chart layouts, per-pane resizing, snapshots |
| ✏️ **Drawing** | Full TradingView-style toolbar: trend lines, channels, Fibonacci/Gann, pitchforks, text, measure, magnets |
| 🧠 **Pine Script v6** | Built-in editor and runtime, custom indicators, sub-panes, boxes/lines/labels owned by scripts |
| 🔔 **Alerts & news** | Five price conditions with notifications and sound, economic calendar with impact/currency filters |
| 💼 **Trading** | Order ticket, one-click, SL/TP, partial close, pending orders, strategy tester, bar replay |
| 🎞️ **Workspace** | Saved layouts, autosave, watchlists, per-chart styles, timezone picker, CSV export |
| 🔐 **Private by design** | Local storage only, OS-encrypted credentials, strict CSP, sandboxed renderer, redacted logs |

### 📦 Requirements

- **Windows 10/11** — primary target; real MT5 data needs the Windows-only `MetaTrader5` package.
- **macOS / Linux** — demo mode via `run.sh`; real MT5 data still requires Windows.
- **Node.js 20+** (CI uses 22) and **Python 3.8+** (`python`, `python3` or `py -3` in `PATH`).
- Provider dependencies:

```bash
python -m pip install -r provider/requirements.txt   # websockets
python -m pip install MetaTrader5                    # real MT5 data only
```

### 🚀 Run from source

```bash
npm install
npm start            # Windows: run-demo.bat / run-mt5.bat also work
```

1. On the login screen choose **Demo Server** (instant simulated market) or **MetaTrader 5** (login, password, server, optional terminal path).
   The MT5 card checks for a local terminal (registry, Program Files, broker-branded folders, portable installs). When none is found it shows **Get MetaTrader 5**, **Choose terminal64.exe…**, **Check again** and **Use demo data** instead of failing with an opaque provider error.
2. **Linux sandbox note:** if Chromium's SUID sandbox is blocked (Ubuntu 22.04+/24.04 AppArmor, Docker, WSL), use `./run.sh --no-sandbox`. Only on machines you trust.
3. The first launch downloads Electron through the npmmirror mirror and verifies it against the official checksum (`scripts/verify-electron.js`).

### 🏗️ Build an installer

`electron-builder` is configured in `package.json`:

```bash
npm run dist:win     # dist/OJchart Setup <version>.exe   (NSIS)
npm run dist:mac     # dist/OJchart.dmg
npm run dist:linux   # dist/OJchart.AppImage
```

Builds are **unsigned** by default — Windows SmartScreen / macOS Gatekeeper will warn on first run. For distribution, provide a certificate through `CSC_LINK` / `CSC_KEY_PASSWORD` (see [Code signing](#-code-signing)); macOS notarization additionally reads `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`.

The Python provider ships **outside** the asar archive (`build.asarUnpack`): Python cannot read `app.asar`, so keep that entry when editing the bundler config — otherwise the installed app boots but the provider never starts.

The `.github/workflows/package.yml` workflow builds all three installers on a `v*` tag (or manually via **Actions → Package → Run workflow**), uploads them as artifacts with `SHA256SUMS.txt`, and from ROUND290 also publishes them to a **GitHub Release** together with the auto-update feed — see [Updates](#️-updates). It is separate from the fast `ci.yml` quality gate.

### 🧭 Architecture

```mermaid
flowchart LR
  MT5[MetaTrader 5 terminal] -->|MetaTrader5 API| P[Python provider<br/>ws://127.0.0.1:8777]
  DEMO[Demo engine] --> P
  P -->|WebSocket| F[src/core/feed.js]
  F --> S[src/core/state.js]
  S --> C[Chart panes<br/>src/renderer/js/chart]
  C --> U[Drawings · Pine · Alerts · Trading]
```

- **`src/core/`** — platform-agnostic layer (env, util, logger, errors, indicators, state, timezone, feed, demo-math, session-math + the Pine engine). No `window`/`document`/`electronAPI` references; the only host seam is `core/env.js`.
- **`src/platform/electron/`** — Electron host adapters (log transport, Python detection, provider paths).
- **`src/renderer/`** — the DOM app with a single ES-module entry, `js/app.js`; every cross-file reference is a named import/export.
- **`provider/`** — Python WebSocket servers (`demo.py`, `mt5.py`) sharing `provider_common.py`.
- Data flow: `provider/*.py` → `src/core/feed.js` → `src/core/state.js` → chart panes. Details in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### ✅ Testing & CI

`npm run verify` (= `npm test`) is the quality gate:

1. **`check:syntax`** — parses every `.js`/`.mjs` file as an ES module.
2. **`check:imports`** — resolves every relative import/export to a real file.
3. **`check:py`** — byte-compiles all `provider/*.py`.
4. **`check:electron`** — asserts the pinned Electron matches `node_modules`, that main/preload avoid removed APIs, and that electron-builder supports the runtime.
5. **`test:unit`** — runs the 158 Node suites in `tests/unit/` (chart, drawing, Pine engine, IPC contracts).
6. **`check:mt5`** — drives `provider/mt5.py` against a replayable `MetaTrader5` package (no terminal needed); see [`docs/MT5-HARNESS.md`](docs/MT5-HARNESS.md).
7. **`smoke`** — boots `provider/demo.py`, serves `src/`, logs into the demo server in a hidden **offscreen Electron** window and asserts app visible, login hidden, bars loaded, canvases present, zero console errors and zero failed requests.

CI (`.github/workflows/ci.yml`) runs the full gate on Windows, Linux (under Xvfb) and macOS for every push and pull request, so the real Electron boot is verified on all three desktop targets.

`npm run report:core-coverage` runs the suites under `NODE_V8_COVERAGE` and prints real (approximate) line coverage for `src/core/`; `-- --min 80` turns it into a regression gate (the Windows CI job runs that). Use `--list` to see every module, including the lowest-covered ones (`feed.js`, `demo-math.js`, `indicators.js` at the time of writing).

`npm run report:perf` profiles chart rendering with large datasets: it boots the real renderer against the demo provider, replays 5k/20k/50k synthetic bars through `Manager.setPaneData`, and reports series-write, full-chart paint, overlay repaint, indicator recompute, resident heap and per-frame pan cost. `-- --sizes 1000,100000` changes the dataset sizes, `-- --json` / `-- --out perf.json` give machine-readable output, and `-- --budget 250` fails when write+paint for the largest dataset exceeds 250 ms. It is a measurement tool (not part of `verify`) because absolute timings are machine- and GPU-dependent — the harness runs with hardware acceleration disabled, so treat pan frames as a software-rendering floor.

### 🔐 Security & privacy

- Credentials never enter `localStorage`: MT5 accounts go through the `accounts-save` IPC and are encrypted with OS `safeStorage` (DPAPI on Windows).
- Strict CSP, sandboxed renderer, validated IPC payloads, all web permissions denied.
- Log contexts are auto-redacted (`password`, `token`, … never reach the log).
- Details: [`docs/SECURITY-ROUND81.md`](docs/SECURITY-ROUND81.md).

### 🩺 Diagnostics

- **In-app panel:** right rail → info icon. Live logs with filters, session stats, export to `.log`/`.json`, and a self-test.
- **File logs:** `%APPDATA%/mt5-chart-terminal/logs/app-YYYY-MM-DD.log` on Windows (JSONL, ~2 MB rotation, 7-day retention).
- Provider crash log: `%TEMP%\mt5_provider_crash.log`.

### 🛠️ Troubleshooting

| Symptom | Fix |
|---|---|
| Window opens, never connects | `python -m pip install -r provider/requirements.txt`; make sure port **8777** is free |
| Login says *MetaTrader 5 terminal not found* | Install MT5 from your broker (or the MetaQuotes demo), click **Choose terminal64.exe…**, or switch to **Demo Server**. Live MT5 data needs Windows + a local terminal; **Get MetaTrader 5** opens the official download page. |
| `Python 3 not found` | Install Python 3.8+ and tick “Add python.exe to PATH” (or install the `py` launcher) |
| Blank screen after an update | Run `npm run verify` — it separates syntax/import/provider failures from UI failures |
| Linux sandbox error | `./run.sh --no-sandbox` (trusted machines only) |

### 🔏 Code signing

electron-builder reads signing material from the environment; nothing is stored in the repository.

| Variable | Meaning |
|---|---|
| `CSC_LINK` | Path to `.pfx`/`.p12`, an `https://` URL, or a base64 certificate |
| `CSC_KEY_PASSWORD` | Certificate password |

```powershell
$env:CSC_LINK = 'C:\certs\ojchart.pfx'
$env:CSC_KEY_PASSWORD = 'the-certificate-password'
npm run dist:win
```

```bash
export CSC_LINK=/secure/ojchart.p12
export CSC_KEY_PASSWORD='the-certificate-password'
npm run dist:mac
```

**Never commit certificates, passwords or key material.** `.gitignore` excludes `*.pfx`, `*.p12`, `*.cer`, `*.key` and `*.pem`.

### 🚢 Release checklist

```bash
node scripts/release.mjs --dry-run         # print the plan, write nothing
node scripts/release.mjs                   # patch bump
node scripts/release.mjs --bump minor      # 1.9.212 -> 1.10.0
node scripts/release.mjs --version 2.0.0   # explicit version
node scripts/release.mjs --message "Fix login retry"
```

The script refuses a dirty tree (override: `--allow-dirty`) or an existing tag, runs `npm run verify` (skip: `--no-verify`), then bumps `package.json` + `src/core/logger.js`, updates the split changelog and index, commits `Release x.y.z`, tags `vx.y.z` and builds the platform installer (`--no-build` stops after the tag). Alias: `npm run release -- --bump minor`.

### ⬆️ Updates

From ROUND290 the `Package` workflow publishes a real **GitHub Release** on every `v*` tag — the three installers plus the update feed (`latest.yml`, `latest-mac.yml`, `latest-linux.yml`) and their blockmaps. Before that the installers only existed as 14-day workflow artifacts, so a shipped copy had no way to learn a newer build existed.

The app checks the feed from the **Diagnostics** panel (version chip + `Check`), and downloading/installing always needs an explicit click — `autoDownload` and `autoInstallOnAppQuit` are both permanently `false`. The flow a user sees: *Update available → [Download] → live percentage → [Restart & install]*. A dev build (`npm start`) reports "auto-update is off in this build" instead of failing.

#### How the release process is protected

`npm run check:release` verifies that a release is **deliverable**, and CI runs it automatically after publishing (`Verify the published release` step in `package.yml`). It checks, per platform:

- the feed exists, parses, and its `version` equals `package.json`;
- every `files[].url` in the feed is an **actual attached asset**;
- the declared `size` matches the uploaded asset;
- the installer and its `.blockmap` are attached;
- the release is published, not a draft or prerelease.

This exists because of a real escape: `latest.yml` advertised `OJchart-Setup-1.9.217.exe` while the NSIS artifact was `OJchart Setup 1.9.217.exe` (spaces). The release page looked fine and **every update would have 404'd**. Nothing caught it; it was found by reading the generated YAML by hand. `artifactName` is now pinned per platform so the two agree by construction, and the gate fails the build if they ever drift again.

#### Delivery status

The repository is **public**, so the update chain is live end to end: a shipped build reads the feed anonymously, offers the update, downloads it with progress, and installs on the user's confirmation. Verified with `npm run check:channel` (no credentials, exactly what a shipped app does).

> **Posture change note.** Going public was a deliverability decision, not a code one: `electron-updater` cannot authenticate, and **private repositories also bill Actions minutes** (2,000/month on the free plan) — a single day of iteration used that up and every job started failing with *"The job was not started because recent account payments have failed or your spending limit needs to be increased"*, which reads like a code failure but never starts a runner. Public repositories get unlimited standard-runner minutes.
>
> If the repository is ever made private again, auto-update stops working (the panel then shows *"Update channel unavailable — download from the release page"*) and CI returns to per-minute billing. Nothing else changes — the feed URL lives in the packaged build, not here.
>
> Before any visibility change, run the audit. It also scans the **entire git history**, because a secret committed and later deleted stays public forever:
>
> ```bash
> npm run go-public -- --dry-run   # audit only: secrets (incl. history), .env, fixtures, tokens
> npm run go-public                # audit → flip visibility → prove the channel anonymously
> npm run check:channel            # re-check at any time (exit 0 = a shipped app WILL update)
> ```

### 📚 Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — module boundaries and data flow
- [`docs/README.md`](docs/README.md) — documentation index (living docs + archive)
- [`docs/PINE-ENGINE-PLAN.md`](docs/PINE-ENGINE-PLAN.md) — Pine Script v6 engine
- [`docs/HANDOFF-ROADMAP.md`](docs/HANDOFF-ROADMAP.md) — engineering roadmap
- [`CHANGELOG.md`](CHANGELOG.md) — release history by major line

### ⚖️ Disclaimer

OJchart is an independent project. It is **not affiliated with, endorsed by, or connected to** TradingView, MetaQuotes or any broker. “MetaTrader” and “TradingView” are trademarks of their respective owners. Trading involves risk; this software is provided “as is” under the MIT license.

---

<div align="right" dir="rtl">

## فارسی

> **وضعیت:** پیش‌انتشار `1.9.x`. هدف اصلی ویندوز است؛ macOS و لینوکس فعلاً فقط حالت دمو را اجرا می‌کنند.

**OJchart** یک ترمینال چارت‌ینگ سبک با ظاهر TradingView است که با **Electron** و یک **پرووایدر WebSocket پایتون** ساخته شده. داده‌ی زنده‌ی متاتریدر ۵ یا فید شبیه‌سازی‌شده‌ی کاملاً محلی را رسم می‌کند و ابزار ترسیم، Pine Script v6، هشدارها، اخبار، ریپلی و مجموعه‌ی کامل معاملات را در اختیار می‌گذارد.

### ✨ نگاه کلی

| | |
|---|---|
| 📊 **چارت** | تایم‌فریم ثانیه تا ماه، ۱۱ سبک چارت، ۵۵ چیدمان چندچارت‌ی، تغییر اندازه‌ی مستقل هر پنل، اسکرین‌شات |
| ✏️ **ترسیم** | نوار ابزار کامل TradingView: خط روند، کانال، فیبوناچی/گان، پیچ‌فورک، متن، اندازه‌گیری، مگنت |
| 🧠 **Pine Script v6** | ادیتور و رانتایم داخلی، اندیکاتور سفارشی، زیرپنل، باکس/خط/لیبل متعلق به اسکریپت |
| 🔔 **هشدار و اخبار** | پنج شرط قیمتی با نوتیفیکیشن و صدا، تقویم اقتصادی با فیلتر اهمیت/ارز |
| 💼 **معاملات** | تیکت سفارش، یک‌کلیکی، SL/TP، بستن جزئی، سفارش‌های معلق، استراتژی‌تستر، ریپلی |
| 🎞️ **فضای کاری** | چیدمان‌های ذخیره‌شده، ذخیره‌ی خودکار، واچ‌لیست، سبک هر چارت، انتخاب تایم‌زون، خروجی CSV |
| 🔐 **حریم خصوصی** | ذخیره‌سازی فقط محلی، رمزنگاری اعتبارنامه با OS، CSP سخت‌گیرانه، رندرر sandbox، لاگ‌های پاک‌سازی‌شده |

### 📦 پیش‌نیازها

- **ویندوز ۱۰/۱۱** — هدف اصلی؛ داده‌ی واقعی MT5 به پکیج ویندوزی `MetaTrader5` نیاز دارد.
- **macOS / لینوکس** — حالت دمو با `run.sh`؛ داده‌ی واقعی MT5 همچنان فقط ویندوز.
- **Node.js 20+** (CI روی ۲۲) و **Python 3.8+** (`python`، `python3` یا `py -3` در `PATH`).
- وابستگی پرووایدر:

```bash
python -m pip install -r provider/requirements.txt   # websockets
python -m pip install MetaTrader5                    # فقط برای داده‌ی واقعی MT5
```

### 🚀 اجرا از سورس

```bash
npm install
npm start            # در ویندوز: run-demo.bat یا run-mt5.bat هم کار می‌کند
```

۱. در صفحه‌ی ورود **Demo Server** (بازار شبیه‌سازی‌شده) یا **MetaTrader 5** (لاگین، رمز، سرور و مسیر اختیاری ترمینال) را انتخاب کن.
۲. **نکته‌ی sandbox لینوکس:** اگر sandbox کرومیوم بلاک شده باشد (Ubuntu 22.04+/24.04 با AppArmor، داکر، WSL) از `./run.sh --no-sandbox` استفاده کن؛ فقط روی ماشینی که به آن اعتماد داری.
۳. اجرای اول Electron را از میرور npmmirror دانلود و با checksum رسمی تأیید می‌کند (`scripts/verify-electron.js`).

### 🏗️ ساخت نصب‌کننده

```bash
npm run dist:win     # dist/OJchart Setup <version>.exe   (NSIS)
npm run dist:mac     # dist/OJchart.dmg
npm run dist:linux   # dist/OJchart.AppImage
```

بیلدها به‌صورت پیش‌فرض **امضا نشده‌اند** — ویندوز SmartScreen و macOS Gatekeeper در اجرای اول هشدار می‌دهند. برای توزیع واقعی، گواهی را با `CSC_LINK` / `CSC_KEY_PASSWORD` بده (بخش [امضای کد](#-امضای-کد)). برای notarization مک علاوه بر این `APPLE_ID`، `APPLE_APP_SPECIFIC_PASSWORD` و `APPLE_TEAM_ID` لازم است.

پرووایدر پایتون **بیرون** از آرشیو asar قرار می‌گیرد (`build.asarUnpack`): پایتون نمی‌تواند داخل `app.asar` را بخواند. اگر تنظیمات باندلر را عوض کردی این گزینه را نگه دار، وگرنه اپ نصب می‌شود ولی پرووایدر بالا نمی‌آید.

### 🧭 معماری

- **`src/core/`** — لایه‌ی مستقل از پلتفرم (env، util، logger، errors، indicators، state، timezone، feed، demo-math، session-math و موتور Pine). هیچ ارجاعی به `window`/`document`/`electronAPI` ندارد؛ تنها اتصال میزبان `core/env.js` است.
- **`src/platform/electron/`** — آداپتورهای میزبان Electron (انتقال لاگ، تشخیص پایتون، مسیر پرووایدر).
- **`src/renderer/`** — اپ DOM با یک entry ماژول ES به نام `js/app.js`؛ همه‌ی ارجاعات بین‌فایلی import/export نام‌دار هستند.
- **`provider/`** — سرورهای WebSocket پایتون (`demo.py`، `mt5.py`) با `provider_common.py` مشترک.
- جریان داده: `provider/*.py` → `src/core/feed.js` → `src/core/state.js` → پنل‌های چارت. جزئیات: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### ✅ تست و CI

`npm run verify` (برابر با `npm test`) دروازه‌ی کیفیت است:

۱. **`check:syntax`** — پارس همه‌ی فایل‌های `.js`/`.mjs` به‌عنوان ماژول ES.
۲. **`check:imports`** — حل شدن همه‌ی import/exportهای نسبی به فایل واقعی.
۳. **`check:py`** — کامپایل همه‌ی `provider/*.py`.
۴. **`check:electron`** — تطابق Electron پین‌شده با `node_modules`، نبود APIهای حذف‌شده در main/preload و سازگاری electron-builder با رانتایم.
۵. **`test:unit`** — اجرای ۱۷۹ مجموعه‌ی Node در `tests/unit/` (چارت، ابزار ترسیم، موتور Pine، قراردادهای IPC).
۶. **`check:mt5`** — اجرای `provider/mt5.py` روی پکیج replay‌پذیر `MetaTrader5` (بدون نیاز به ترمینال)؛ [`docs/MT5-HARNESS.md`](docs/MT5-HARNESS.md).
۷. **`smoke`** — اجرای `provider/demo.py`، سرو `src/`، ورود دمو در یک پنجره‌ی **Electron آفسکرین** و بررسی: اپ دیده شود، لاگین مخفی، کندل‌ها لود شوند، canvas موجود باشد، صفر خطای کنسول و صفر درخواست ناموفق.

CI (`.github/workflows/ci.yml`) برای هر push و pull request کل گیت را روی ویندوز، لینوکس (زیر Xvfb) و مک اجرا می‌کند؛ بنابراین بوت واقعی Electron روی هر سه هدف دسکتاپ بررسی می‌شود.

`npm run report:core-coverage` با `NODE_V8_COVERAGE` پوشش تقریبی خط `src/core/` را می‌سنجد (`-- --min 80` برای گیت CI ویندوز). `npm run report:perf` هم رندر چارت با ۵k/۲۰k/۵۰k کندل را پروفایل می‌کند (`-- --sizes`، `--json`، `--out`، `--budget`).

### 🔐 امنیت و حریم خصوصی

- اعتبارنامه‌ها هرگز در `localStorage` نیستند: اکانت‌های MT5 از مسیر IPC `accounts-save` می‌روند و با `safeStorage` سیستم‌عامل (DPAPI در ویندوز) رمز می‌شوند.
- CSP سخت‌گیرانه، رندرر sandbox، اعتبارسنجی همه‌ی پیام‌های IPC و رد کردن همه‌ی مجوزهای وب.
- کانتکست لاگ‌ها خودکار پاک‌سازی می‌شود (`password`، `token` و مشابه آن هرگز ثبت نمی‌شوند).
- جزئیات: [`docs/SECURITY-ROUND81.md`](docs/SECURITY-ROUND81.md).

### 🩺 عیب‌یابی و لاگ

- **پنل داخلی:** ریل راست → آیکون info. لاگ زنده با فیلتر، آمار نشست، خروجی `.log`/`.json` و خودآزمایی.
- **فایل لاگ:** در ویندوز `%APPDATA%/mt5-chart-terminal/logs/app-YYYY-MM-DD.log` (JSONL، چرخش ~۲ مگابایت، نگهداری ۷ روز).
- لاگ کرش پرووایدر: `%TEMP%\mt5_provider_crash.log`.

| مشکل | راه‌حل |
|---|---|
| پنجره باز می‌شود ولی وصل نمی‌شود | `python -m pip install -r provider/requirements.txt` و آزاد بودن پورت **8777** |
| پیام «MetaTrader 5 terminal not found» در لاگین | MT5 را از بروکر (یا دموی MetaQuotes) نصب کنید، **Choose terminal64.exe…** را بزنید، یا به **Demo Server** بروید. داده‌ی زنده فقط با ویندوز + ترمینال محلی کار می‌کند؛ دکمه‌ی **Get MetaTrader 5** صفحه‌ی دانلود رسمی را باز می‌کند. |
| `Python 3 not found` | نصب Python 3.8+ با تیک «Add python.exe to PATH» یا نصب لانچر `py` |
| صفحه‌ی سفید بعد از آپدیت | `npm run verify` — خطای syntax/import/provider را از خطای UI جدا می‌کند |
| خطای sandbox لینوکس | `./run.sh --no-sandbox` (فقط ماشین مورد اعتماد) |

### 🔏 امضای کد

electron-builder مواد امضا را از محیط می‌خواند؛ چیزی در مخزن ذخیره نمی‌شود.

| متغیر | معنی |
|---|---|
| `CSC_LINK` | مسیر `.pfx`/`.p12`، آدرس `https://` یا گواهی base64 |
| `CSC_KEY_PASSWORD` | رمز گواهی |

```powershell
$env:CSC_LINK = 'C:\certs\ojchart.pfx'
$env:CSC_KEY_PASSWORD = 'the-certificate-password'
npm run dist:win
```

```bash
export CSC_LINK=/secure/ojchart.p12
export CSC_KEY_PASSWORD='the-certificate-password'
npm run dist:mac
```

**هرگز گواهی، رمز یا کلید را کامیت نکن.** `.gitignore` پسوندهای `*.pfx`، `*.p12`، `*.cer`، `*.key` و `*.pem` را مستثنا می‌کند.

### 🚢 چک‌لیست انتشار

```bash
node scripts/release.mjs --dry-run         # فقط نمایش برنامه
node scripts/release.mjs                   # افزایش patch
node scripts/release.mjs --bump minor      # 1.9.212 -> 1.10.0
node scripts/release.mjs --version 2.0.0   # نسخه‌ی صریح
node scripts/release.mjs --message "Fix login retry"
```

اسکریپت روی tree کثیف (مگر `--allow-dirty`) یا تگ موجود اجرا نمی‌شود، `npm run verify` را اجرا می‌کند (مگر `--no-verify`)، نسخه را در `package.json` و `src/core/logger.js` می‌نویسد، چنج‌لاگ و ایندکس را به‌روز می‌کند، کامیت `Release x.y.z` و تگ `vx.y.z` می‌سازد و نصب‌کننده‌ی همان پلتفرم را بیلد می‌کند (`--no-build` بعد از تگ متوقف می‌شود). معادل npm: `npm run release -- --bump minor`.

### 📚 مستندات

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — مرز ماژول‌ها و جریان داده
- [`docs/PINE-ENGINE-PLAN.md`](docs/PINE-ENGINE-PLAN.md) — موتور Pine Script v6
- [`docs/HANDOFF-ROADMAP.md`](docs/HANDOFF-ROADMAP.md) — نقشه‌راه مهندسی
- [`CHANGELOG.md`](CHANGELOG.md) — تاریخچه‌ی انتشار

### ⚖️ سلب مسئولیت

OJchart یک پروژه‌ی مستقل است و **هیچ وابستگی، تأیید یا ارتباطی** با TradingView، MetaQuotes یا هیچ کارگزاری ندارد. «MetaTrader» و «TradingView» علائم تجاری صاحبانشان هستند. معامله ریسک دارد؛ این نرم‌افزار «همان‌گونه که هست» و تحت مجوز MIT ارائه می‌شود.

</div>

---

<div align="center">

**© 2026 AHNesari · OJchart**

</div>
