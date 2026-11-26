# Cadence Audit — <yyyy-mm-dd>

## Summary

- **Static audit** (`tools/analysis/reports/cadence-audit.json`):
  - Aligned (< 80 ms max drift): __/__ = __ %  (prev: __ %  Δ __ pp)
  - Numbers: __/__ = __ %
  - Techniques: __/__ = __ %
  - Unavailable: __
- **Live spot-check** (`tools/analysis/monitor/<name>/cadence-report.json`):
  - Session: `<name>` · duration __ min · vocab flips: __
  - Aligned (< 80 ms live): __/__ = __ %
  - Kyle-verified drifty combos:
    - `<cueId>` — heard __ ms __ (early|late) — matches audit? __

## Top-25 static offenders (worst |maxAbsDriftMs|)

| cueId | vocab | cadence | maxAbsDriftMs | source | notes |
|---|---|---|---|---|---|
| … | … | … | … | wordMarks / envelope / whisper | … |

## Shifts applied this round

| cueId | shiftMs | rationale | pre-drift | post-drift |
|---|---|---|---|---|
| … | … | Kyle-heard + audit-confirmed / audit-only / live-only | … | … |

## Gates

- `npx tsc --noEmit` — 
- `npx jest src/domain/programs/__tests__/mapCallShifts.test.ts` — 
- `npx jest src/audio` — 

## Follow-ups

- (open drift patterns needing re-render rather than shift)
- (metric refinement candidates surfaced this round)
- (per-clip anomalies worth investigating)
