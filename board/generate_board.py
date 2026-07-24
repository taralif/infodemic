#!/usr/bin/env python3
"""Infodemic 24x36 wall gameboard — WHITE print version + ticker styles sheet."""
import random
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import letter, landscape

W, H = 24 * 72, 36 * 72
INK = HexColor("#141414"); DIM = HexColor("#6b6b6b"); RULE = HexColor("#c9c9c9"); FAINT = HexColor("#e6e6e6")
RED = HexColor("#c0392b"); AMBER = HexColor("#c9932b"); GREEN = HexColor("#3f9c5f"); GREY = HexColor("#9a9a9a")

c = canvas.Canvas("/sessions/trusting-youthful-mccarthy/mnt/outputs/infodemic-board-24x36.pdf", pagesize=(W, H))
rng = random.Random(42)

# ---- ambient noise network (light grey — decorative, NOT thread hints) ----
margin = 60
pts = [(rng.uniform(margin, W - margin), rng.uniform(300, H - 260)) for _ in range(90)]
c.setStrokeColor(FAINT); c.setLineWidth(0.9)
for p in pts:
    others = sorted(pts, key=lambda q: (q[0]-p[0])**2 + (q[1]-p[1])**2)[1:3]
    for q in others:
        if rng.random() < 0.6:
            c.line(p[0], p[1], q[0], q[1])
for p in pts:
    r = rng.uniform(2, 4.5)
    c.setFillColor(RULE if rng.random() < 0.6 else FAINT)
    c.circle(p[0], p[1], r, fill=1, stroke=0)

# ---- header ----
c.setFillColor(INK)
c.setFont("Times-Bold", 110)
x = W/2 - 480; y = H - 150
for ch in "INFODEMIC":
    c.drawString(x, y, ch)
    x += c.stringWidth(ch, "Times-Bold", 110) + 22
c.setFont("Times-Italic", 26); c.setFillColor(DIM)
c.drawCentredString(W/2, H - 200, "Sixteen stories deep today. Some are true, some are bait, one isn't settled yet.")
c.setFont("Helvetica", 15)
c.drawCentredString(W/2, H - 232, "T H E   F E E D   ·   F E E D   D R O P   # 1")

# ---- 16 card node slots ----
CW, CH = 340, 175
cols_x = [90, 490, 890, 1290]
rows_y = [H - 560, H - 1020, H - 1480, H - 1940]
slots = []
for base_y in rows_y:
    for c_i in range(4):
        slots.append((cols_x[c_i] + rng.uniform(-25, 25), base_y + rng.uniform(-70, 70)))

for i, (sx, sy) in enumerate(slots):
    n = i + 1
    nx, ny = sx + CW/2, sy + CH + 26
    c.setStrokeColor(DIM); c.setLineWidth(1.5)
    c.setFillColor(HexColor("#ffffff")); c.circle(nx, ny, 16, fill=1, stroke=1)
    c.setFillColor(DIM); c.circle(nx, ny, 6, fill=1, stroke=0)
    c.setStrokeColor(DIM); c.setLineWidth(1.6); c.setDash(7, 6)
    c.roundRect(sx, sy, CW, CH, 10, fill=0, stroke=1)
    c.setDash()
    c.setFillColor(INK); c.setFont("Helvetica-Bold", 20)
    c.drawString(sx + 14, sy + CH - 30, f"F·{n}")
    c.setFillColor(DIM); c.setFont("Helvetica", 12)
    c.drawString(sx + 14, sy + 14, "place card here — stickers on the card")

# ---- footer: tug-of-war ticker + legend ----
c.setStrokeColor(RULE); c.setLineWidth(1.5)
c.roundRect(70, 60, W - 140, 180, 14, fill=0, stroke=1)

c.setFont("Helvetica-Bold", 30)
c.setFillColor(RED);   c.drawString(110, 150, "FALSE")
c.setFillColor(GREEN); c.drawRightString(W - 110, 150, "TRUTH")

n_ch = 8
track_half = (W - 2 * 340) / 2 - 60   # room inside the FALSE/TRUTH labels
ch_w = track_half / n_ch
ch_h = 62
y0 = 128
for side in [-1, 1]:
    col = RED if side == -1 else GREEN
    for idx in range(n_ch):
        shade = 0.35 + 0.65 * (idx / (n_ch - 1))
        c.setFillColorRGB(
            col.red * shade + 1 * (1 - shade),
            col.green * shade + 1 * (1 - shade),
            col.blue * shade + 1 * (1 - shade))
        x_base = W/2 + side * (34 + idx * ch_w)
        p = c.beginPath()
        p.moveTo(x_base, y0)
        p.lineTo(x_base + side * ch_w * 0.7, y0 + ch_h/2)
        p.lineTo(x_base, y0 + ch_h)
        p.lineTo(x_base + side * ch_w * 0.25, y0 + ch_h/2)
        p.close()
        c.drawPath(p, fill=1, stroke=0)
c.setFillColor(INK); c.circle(W/2, y0 + ch_h/2, 11, fill=1, stroke=0)
lx = 100
for col, label in [(RED, "MISINFORMATION"), (AMBER, "BIASED-BUT-FACTUAL"), (GREEN, "VERIFIED")]:
    c.setFillColor(col); c.circle(lx, 92, 9, fill=1, stroke=0)
    c.setFillColor(DIM); c.setFont("Helvetica", 13)
    c.drawString(lx + 18, 86, label)
    lx += 24 + c.stringWidth(label, "Helvetica", 13) + 60
c.setFillColor(DIM); c.setFont("Times-Italic", 14)
c.drawRightString(W - 100, 86, "thread discovered? connect the nodes — string, tape, or marker. the board is yours to reorganize.")
c.showPage(); c.save()

# ================= TICKER STYLES SHEET (letter landscape, 3 variants) =================
LW, LH = landscape(letter)
t = canvas.Canvas("/sessions/trusting-youthful-mccarthy/mnt/outputs/ticker-styles.pdf", pagesize=landscape(letter))

def ends(t, y, size=16):
    t.setFont("Helvetica-Bold", size)
    t.setFillColor(RED);   t.drawString(40, y, "FALSE")
    t.setFillColor(GREEN); t.drawRightString(LW - 40, y, "TRUTH")

t.setFillColor(INK); t.setFont("Times-Bold", 22)
t.drawString(40, LH - 50, "Ticker styles — cut out, tape over the board's track, pick a winner")
t.setFillColor(DIM); t.setFont("Helvetica", 11)
t.drawString(40, LH - 68, "All run FALSE (left) to TRUTH (right). Move a sticker, clip, or magnet as the balance shifts.")

# --- Style 1: numbered cells (matches board) ---
y1 = LH - 150
t.setFillColor(DIM); t.setFont("Helvetica-Bold", 11); t.drawString(40, y1 + 52, "STYLE 1 · CELLS")
ends(t, y1 + 14)
cells = 17; cw2 = (LW - 220) / cells
for i in range(cells):
    v = i - 8
    x0 = 110 + i * cw2
    t.setStrokeColor(INK if v == 0 else RULE); t.setLineWidth(1.5)
    t.setFillColor(FAINT if v == 0 else HexColor("#ffffff"))
    t.roundRect(x0, y1, cw2 - 4, 40, 5, fill=1, stroke=1)
    t.setFillColor(DIM); t.setFont("Helvetica-Bold", 10)
    t.drawCentredString(x0 + (cw2 - 4)/2, y1 + 15, f"{v:+d}" if v else "0")

# --- Style 2: thermometer bar with ticks ---
y2 = LH - 290
t.setFillColor(DIM); t.setFont("Helvetica-Bold", 11); t.drawString(40, y2 + 62, "STYLE 2 · THERMOMETER")
ends(t, y2 + 20)
bar_x, bar_w, bar_h = 110, LW - 220, 26
steps = 60
for i in range(steps):
    frac = i / (steps - 1)
    # red -> grey -> green interpolation
    if frac < 0.5:
        f2 = frac / 0.5
        r_ = 0xc0 + (0x9a - 0xc0) * f2; g_ = 0x39 + (0x9a - 0x39) * f2; b_ = 0x2b + (0x9a - 0x2b) * f2
    else:
        f2 = (frac - 0.5) / 0.5
        r_ = 0x9a + (0x3f - 0x9a) * f2; g_ = 0x9a + (0x9c - 0x9a) * f2; b_ = 0x9a + (0x5f - 0x9a) * f2
    t.setFillColorRGB(r_/255, g_/255, b_/255)
    t.rect(bar_x + i * bar_w/steps, y2, bar_w/steps + 0.5, bar_h, fill=1, stroke=0)
t.setStrokeColor(INK); t.setLineWidth(1.2); t.rect(bar_x, y2, bar_w, bar_h, fill=0, stroke=1)
for i in range(17):
    x0 = bar_x + i * bar_w/16
    t.setStrokeColor(HexColor("#ffffff") if 3 < i < 13 else INK); t.setLineWidth(1)
    t.line(x0, y2, x0, y2 - (10 if i % 4 == 0 else 6) + 10)
    t.line(x0, y2, x0, y2 + 4)
t.setStrokeColor(INK); t.setLineWidth(1.5)
t.line(bar_x + bar_w/2, y2 - 8, bar_x + bar_w/2, y2 + bar_h + 8)

# --- Style 3: tug-of-war chevrons ---
y3 = LH - 430
t.setFillColor(DIM); t.setFont("Helvetica-Bold", 11); t.drawString(40, y3 + 62, "STYLE 3 · TUG-OF-WAR")
ends(t, y3 + 20)
n_ch = 8; ch_w = (LW - 260) / (2 * n_ch); ch_h = 34
cx = 110
for side in [-1, 1]:
    for i in range(n_ch):
        idx = (n_ch - 1 - i) if side == -1 else i
        x0 = LW/2 + side * (20 + idx * ch_w) - (ch_w/2 if side == -1 else -0)
        # chevron pointing outward
        col = RED if side == -1 else GREEN
        shade = 0.35 + 0.65 * (idx / (n_ch - 1))
        t.setFillColorRGB(
            (col.red   * shade + 1 * (1 - shade)),
            (col.green * shade + 1 * (1 - shade)),
            (col.blue  * shade + 1 * (1 - shade)))
        p = t.beginPath()
        x_base = LW/2 + side * (24 + idx * ch_w)
        p.moveTo(x_base, y3)
        p.lineTo(x_base + side * ch_w * 0.7, y3 + ch_h/2)
        p.lineTo(x_base, y3 + ch_h)
        p.lineTo(x_base + side * ch_w * 0.25, y3 + ch_h/2)
        p.close()
        t.drawPath(p, fill=1, stroke=0)
t.setFillColor(INK); t.circle(LW/2, y3 + ch_h/2, 8, fill=1, stroke=0)
t.setFillColor(DIM); t.setFont("Helvetica", 9)
t.drawCentredString(LW/2, y3 - 14, "center = contested · each settled claim pulls one chevron toward TRUTH")

t.showPage(); t.save()
print("saved both")
