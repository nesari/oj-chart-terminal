# Tests

## Active suite — `tests/unit/*.mjs`

140 self-contained Node suites. They import real app modules when the logic is
pure, and pin source contracts for renderer behaviour that needs a DOM. No test
framework and no extra dependency:

```bash
npm run test:unit     # runs every suite with a 60s timeout, 4 in parallel
npm run verify        # syntax + imports + Python + unit + offscreen smoke
```

`source-utils.mjs` is the shared reader used by static-pin suites: it returns a
file's text and, for split aggregators (`manager.js`, `tools.js`, `tools2.js`,
`engine.js`), appends the sibling `manager/*.js`, `tools/*.js`, … modules created
by the F4.3 split. Add new suites as `tests/unit/test_<topic>.mjs` and export
nothing — the runner treats a non-zero exit code as a failure.

## Archive — `tests/archive/`

| Path | Contents |
|---|---|
| `archive/e2e/` | 135 Python Playwright harnesses from rounds 31–145. They drive a live app over HTTP and expect a Linux dev host; kept as historical reproduction evidence. |
| `archive/unit-py/` | 45 Python suites from the pre-Node era (Pine corpus, MT5 provider, round-by-round UI probes). Several are Linux-only (`os.setsid`) or use the old `tests/unit` layout. |

The archived suites are **not** part of `npm run verify` and are not maintained.
When a regression matters, port the relevant assertions to an active `.mjs`
suite instead of reviving the old harness.
