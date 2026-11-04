#!/usr/bin/env python3
"""Plot a curve_run CSV as a standalone SVG.

No dependencies: the point is that a run's shape (chamber vs target, and what
the heater was doing while it fell short) is easier to see than to read.

    .venv/bin/python tools/plot_run.py runs/curve-20261103-201045.csv
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

W, H = 960, 580
PAD_L, PAD_R, PAD_T, PAD_B = 64, 64, 44, 48
PLOT_W = W - PAD_L - PAD_R
PLOT_H = 360
DUTY_H = 90


def load(path: Path):
    rows = []
    with path.open() as f:
        for r in csv.DictReader(f):
            rows.append({
                "t": float(r["t"]),
                "target": float(r["target_f"]),
                "chamber": float(r["chamber_f"]),
                "tcmd": float(r["tcmd_f"]) if r.get("tcmd_f") else None,
                "duty": float(r["duty_pct"]) if r.get("duty_pct") else None,
                "pwr": float(r["pwr_w"]) if r.get("pwr_w") else None,
            })
    return rows


def plot(rows, title: str, out: Path) -> None:
    t_max = max(r["t"] for r in rows) or 1.0
    temps = [r["chamber"] for r in rows] + [r["target"] for r in rows]
    tcmds = [r["tcmd"] for r in rows if r["tcmd"] is not None]
    lo = min(temps + tcmds) - 15
    hi = max(temps + tcmds) + 15

    def x(t: float) -> float:
        return PAD_L + (t / t_max) * PLOT_W

    def y(temp: float) -> float:
        return PAD_T + (1 - (temp - lo) / (hi - lo)) * PLOT_H

    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
             f'viewBox="0 0 {W} {H}" font-family="ui-monospace,Menlo,monospace">',
             f'<rect width="{W}" height="{H}" fill="#12141a"/>',
             f'<text x="{PAD_L}" y="26" fill="#e8eaf0" font-size="15">{title}</text>']

    # temperature gridlines every 20 °F
    g = int(lo // 20 * 20) + 20
    while g < hi:
        yy = y(g)
        parts.append(f'<line x1="{PAD_L}" y1="{yy:.1f}" x2="{PAD_L+PLOT_W}" y2="{yy:.1f}" '
                     f'stroke="#262a35" stroke-width="1"/>')
        parts.append(f'<text x="{PAD_L-10}" y="{yy+4:.1f}" fill="#7c8395" font-size="11" '
                     f'text-anchor="end">{g}</text>')
        g += 20

    # Duty gets its OWN band below the temperature plot, with its own axis.
    # Drawing it inside the temperature area let a 97 % duty bar reach the
    # 540 °F gridline, which reads as a temperature spike that never happened.
    duty_top = PAD_T + PLOT_H + 34
    duty_h = DUTY_H
    parts.append(f'<line x1="{PAD_L}" y1="{duty_top:.1f}" x2="{PAD_L+PLOT_W}" '
                 f'y2="{duty_top:.1f}" stroke="#262a35" stroke-width="1"/>')
    for pct in (0, 50, 100):
        yy = duty_top + duty_h - (pct / 100.0) * duty_h
        if pct:
            parts.append(f'<line x1="{PAD_L}" y1="{yy:.1f}" x2="{PAD_L+PLOT_W}" y2="{yy:.1f}" '
                         f'stroke="#1e222c" stroke-width="1"/>')
        parts.append(f'<text x="{PAD_L-10}" y="{yy+4:.1f}" fill="#5b7fa8" font-size="10" '
                     f'text-anchor="end">{pct}%</text>')

    bw = max(2.0, PLOT_W / max(len(rows), 1) * 0.55)
    for r in rows:
        if r["duty"] is None:
            continue
        bh = (r["duty"] / 100.0) * duty_h
        parts.append(f'<rect x="{x(r["t"])-bw/2:.1f}" y="{duty_top+duty_h-bh:.1f}" '
                     f'width="{bw:.1f}" height="{bh:.1f}" fill="#4a83c4" opacity="0.85"/>')
    parts.append(f'<text x="{PAD_L}" y="{duty_top-8:.0f}" fill="#5b7fa8" '
                 f'font-size="10">heater duty</text>')

    def poly(key: str, color: str, dash: str = "", width: float = 2.0) -> None:
        pts = [(x(r["t"]), y(r[key])) for r in rows if r[key] is not None]
        if len(pts) < 2:
            return
        d = " ".join(f"{px:.1f},{py:.1f}" for px, py in pts)
        extra = f' stroke-dasharray="{dash}"' if dash else ""
        parts.append(f'<polyline points="{d}" fill="none" stroke="{color}" '
                     f'stroke-width="{width}"{extra} stroke-linejoin="round"/>')

    poly("tcmd", "#c9a227", "4 4", 1.5)
    poly("target", "#8b93a7", "2 4", 1.5)
    poly("chamber", "#e2603f", "", 2.4)

    # x axis labels
    for frac in (0, 0.25, 0.5, 0.75, 1.0):
        t = t_max * frac
        parts.append(f'<text x="{x(t):.1f}" y="{PAD_T+PLOT_H+18}" fill="#7c8395" '
                     f'font-size="11" text-anchor="middle">{t:.0f}s</text>')

    # legend
    lx = PAD_L
    for label, color, dash in (("chamber", "#e2603f", ""),
                               ("target", "#8b93a7", "2 4"),
                               ("tcmd (device)", "#c9a227", "4 4")):
        extra = f' stroke-dasharray="{dash}"' if dash else ""
        parts.append(f'<line x1="{lx}" y1="{H-18}" x2="{lx+22}" y2="{H-18}" '
                     f'stroke="{color}" stroke-width="2"{extra}/>')
        parts.append(f'<text x="{lx+28}" y="{H-14}" fill="#aab1c0" font-size="11">{label}</text>')
        lx += 150

    parts.append("</svg>")
    out.write_text("\n".join(parts))
    print(f"wrote {out}")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    src = Path(sys.argv[1])
    rows = load(src)
    if not rows:
        print("no rows")
        return 1
    out = src.with_suffix(".svg")
    plot(rows, src.stem, out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
