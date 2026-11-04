#!/usr/bin/env python3
"""Tests for the plateau diagnosis, which needs no hardware.

The 488 °F plateau is the app's one open question, and the verdict is only as
good as the rule that produces it. These cases pin the rule: the historical
observation must land on "firmware ceiling", a power-starved run must land on
"power limited", and missing telemetry must refuse to guess.

    .venv/bin/python tools/test_curve_run.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from curve_run import SETTLE_F, diagnose_plateau, parse_steps

FAILED = 0
PASSED = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global FAILED, PASSED
    if cond:
        PASSED += 1
        print(f"  ok   {name}")
    else:
        FAILED += 1
        print(f"  FAIL {name}{f' — {detail}' if detail else ''}")


def rows_at(chamber_f: float, target_f: float, duty, pwr=None, n: int = 10):
    """A flat run: n samples all sitting at chamber_f, short of target_f."""
    return [(float(i), target_f, chamber_f, duty, pwr) for i in range(n)]


def verdict(lines: list[str]) -> str:
    """Classify the diagnosis. The verdict word can sit on a continuation line."""
    for i, line in enumerate(lines):
        if "VERDICT" not in line:
            continue
        block = " ".join(lines[i:i + 3])
        if "POWER" in block:
            return "power"
        if "FIRMWARE" in block:
            return "firmware"
        if "inconclusive" in block:
            return "inconclusive"
    return "none"


print("\nstep parsing")

check("absolute steps parse", parse_steps(["470:15"], None) == [(470.0, 15.0)])
check("relative steps stack on the previous target",
      parse_steps(["470:15", "+10:15", "+10:10"], 470) ==
      [(470.0, 15.0), (480.0, 15.0), (490.0, 10.0)])
check("a relative first step stacks on the profile",
      parse_steps(["+0:15", "+18:15"], 455) == [(455.0, 15.0), (473.0, 15.0)])
check("negative deltas parse too",
      parse_steps(["500:10", "-20:10"], 500) == [(500.0, 10.0), (480.0, 10.0)])
check("hold defaults to 10 s", parse_steps(["470"], None) == [(470.0, 10.0)])

print("\nlive setpoint")

source = (Path(__file__).parent / "curve_run.py").read_text()
curve_loop = source.split("# ---- the curve: hold each step", 1)[-1]

check("the curve loop sets the live target, not an offset-only nudge",
      "set_live_target(" in curve_loop)
check("the curve loop does NOT pin the target relative to the chamber",
      "cf + 40.0" not in curve_loop,
      "a warm-up ramp expression leaked into the hold loop and would climb forever")
check("the live target is the step target itself",
      "set_live_target(lx, target)" in curve_loop)

print("\nplateau diagnosis")

# The actual observation from the handoff: plateau 488 °F, tcmd 537 °F,
# heater at 12% duty / 5.6 W. It had stopped driving, so: firmware ceiling.
lines = diagnose_plateau(rows_at(488, 537, 12, 5.6), 10.0, 9.0)
check("historical 488 °F / 12% duty reads as firmware ceiling",
      verdict(lines) == "firmware", verdict(lines))
check("historical run reports the peak",
      any("488" in ln for ln in lines), str(lines))

# A unit that is genuinely power-starved keeps the heater at high duty and
# still cannot reach the target.
lines = diagnose_plateau(rows_at(486, 530, 45, 34.0), 8.0, 7.0)
check("high duty short of target reads as power limited",
      verdict(lines) == "power", verdict(lines))

# The ambiguous band must not be resolved by guessing.
lines = diagnose_plateau(rows_at(490, 530, 20, 15.0), 100.0, 99.0)
check("mid-band duty refuses to guess",
      verdict(lines) == "inconclusive", verdict(lines))

# A healthy run where every step met its target is not a plateau at all.
lines = diagnose_plateau(rows_at(481, 480, 18, 12.0), 100.0, 99.0)
check("met targets reports no plateau",
      any("no plateau" in ln for ln in lines), str(lines))

# Without duty we cannot distinguish the two causes, and must say so.
lines = diagnose_plateau(rows_at(488, 537, None), 10.0, 9.0)
check("missing duty refuses to diagnose",
      any("duty unreadable" in ln for ln in lines), str(lines))

# An empty run is not an error.
lines = diagnose_plateau([], 100.0, 99.0)
check("empty run is handled", any("no samples" in ln for ln in lines), str(lines))

# Battery is reported when known, and omitted when not.
lines = diagnose_plateau(rows_at(488, 537, 12, 5.6), 100.0, 98.5)
check("battery range is reported",
      any("100.0%" in ln and "98.5%" in ln for ln in lines), str(lines))
lines = diagnose_plateau(rows_at(488, 537, 12, 5.6), None, None)
check("battery omitted when unknown",
      not any("battery" in ln for ln in lines), str(lines))

# Samples that dip well below the peak are not part of the plateau, so a
# run that climbs and then sags must judge only the samples at the top.
mixed = rows_at(430, 500, 60, 38.0, n=5) + rows_at(488, 500, 10, 5.0, n=5)
lines = diagnose_plateau(mixed, 100.0, 99.0)
check("only samples near the peak count",
      verdict(lines) == "firmware", verdict(lines))

# Regression: an early step can overshoot ABOVE what a later, hotter step
# manages. Judging by the global peak then hides the plateau entirely.
# The 480 step overshooting to 501 °F must not mask a later 520 °F step that
# stalled at 495 with the heater idle.
overshoot = (rows_at(501, 480, 10, 5.2, n=4)
             + rows_at(495, 520, 11, 5.6, n=4))
lines = diagnose_plateau(overshoot, 71.0, 59.5)
check("earlier overshoot does not hide a later plateau",
      verdict(lines) == "firmware", verdict(lines))
check("later step is reported short",
      any("short 25" in ln for ln in lines), str(lines))

# A small shortfall inside the settle band is not a plateau, even if a
# previous step peaked higher.
lines = diagnose_plateau(rows_at(501, 480, 10, 5.2, n=4)
                         + rows_at(495, 500, 11, 5.6, n=4), 71.0, 59.5)
check("a shortfall inside the settle band is not a plateau",
      verdict(lines) == "none", verdict(lines))

# The settle band must be wider than the plateau tolerance used to find the
# top, or a settled run would be misread as a plateau.
check("settle band is meaningful", SETTLE_F > 2.0, str(SETTLE_F))

print(f"\ncurve_run: {PASSED} passed, {FAILED} failed\n")
sys.exit(1 if FAILED else 0)
