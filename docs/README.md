# Documentation

This folder keeps the **living** documents at the root and everything historical under
`archive/`. Regression evidence (round reports, audits, screenshots) is preserved but is not
part of the product surface.

## Living documents

| File | Purpose |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Module boundaries, data flow, test seams |
| [`HANDOFF-ROADMAP.md`](HANDOFF-ROADMAP.md) | Engineering roadmap F0–F7 and definition of done |
| [`PINE-ENGINE-PLAN.md`](PINE-ENGINE-PLAN.md) | Pine Script v6 engine design |
| [`PINE-COMPLIANCE-PLAN.md`](PINE-COMPLIANCE-PLAN.md) | Pine v6 compatibility matrix |
| [`SECURITY-ROUND81.md`](SECURITY-ROUND81.md) | Security model and hardening notes |
| [`screenshot.png`](screenshot.png) | Product screenshot used by the README |

## Archive

| Path | Contents |
|---|---|
| [`archive/rounds/`](archive/rounds/) | Per-round bugfix/feature reports (chronological evidence) |
| [`archive/audits/`](archive/audits/) | UI, UX, theme, icon, overlay and performance audits |
| [`archive/architecture/`](archive/architecture/) | Superseded phase documents (ES modules, core split) |
| [`archive/planning/`](archive/planning/) | Original development plan (.docx) |
| [`archive/screenshots/`](archive/screenshots/) | Round screenshot sets (legacy, round130–134) |

## Notes

- Round documents and the changelog sometimes link to the **old** paths (e.g.
  `docs/UI-ROUND96.md`). Those files now live under `archive/audits/`; the git history still
  contains the originals.
- New documents belong in the root only while they describe the current product. Once a round
  is closed, its report moves to `archive/rounds/`.
