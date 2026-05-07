# Skill 7 — Drill Me (Layer Isolation)

**When to use**: Before any prompt that asks an AI to modify `TelemetryMathService`, `telemetry-overlay.ts`, or the Go-WASM parser. Run this pattern to prevent cross-layer contamination.

**The problem it solves**: The Math layer and the Canvas presentation layer operate on the same numbers but have strictly different responsibilities. An AI given broad access to both layers in a single prompt will frequently introduce unit conversions in the wrong layer, move noise-floor logic into the draw call, or pull `performance.now()` inside the service — each of which looks architecturally correct but violates an established constraint.

---

## Prompt Template

> Before writing any code, reply with:
> 1. The specific files you will modify (list them explicitly).
> 2. A one-sentence explanation of the change in each file.
> 3. Confirmation that you will NOT touch [the other layer].
>
> Wait for my "Approved" before executing.

---

## Layer Isolation Rules

| If modifying… | Explicitly forbid… |
|---|---|
| `TelemetryMathService` | Any edit to `telemetry-overlay.ts` or the rAF loop |
| `telemetry-overlay.ts` draw methods | Any edit to `TelemetryMathService` math or noise floors |
| Go-WASM parser | Any edit to Angular services or overlay |

---

## Unit Contract Checkpoint

Include in every Math Service prompt:

> Confirm that `TelemetryMathService` will continue to output base physical units (m/s for speed, G for force). Any `× 3.6` or `toFixed()` call belongs in `telemetry-overlay.ts`, not here.
