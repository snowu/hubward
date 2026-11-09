# Bus marker + active-lines board — implementation spec

> **Status (2026-11-09): implemented**, in `edfff34` and #48's PR, against
> MapLibre rather than the Leaflet sketched below. Where the app differs from
> this spec, it is on purpose:
>
> - **The line number runs along the body**, flipped so it is never upside
>   down, instead of an upright roof plate (`liveBusIcon()` explains why).
> - **Heading is the route's own direction** where the bus is, every animation
>   frame (`trackBearingAt()`), not the GPS fixes: EMT's fix freezes for
>   minutes and then jumps (see CLAUDE.md, "`DistanceBus` is the only position
>   that moves").
> - **Position is `DistanceBus` along the route**, not a projected fix.
>
> The board is `renderRouteLegend()`. Reduced motion snaps buses to each
> poll. The open questions in §7 are still open.

Design decisions from a mockup session. Everything here is meant to be dropped into the
real app; the mockup's fake map, fake routes and fake ETAs are not part of it.

Two changes:

1. **Bus marker** — top-down bus silhouette in the route colour, rotated to heading, with
   an upright roof plate carrying the line number.
2. **Active lines panel** — the wrapping destination chips become a fixed-column board.

---

## 1. Bus marker

### Why this shape

The old chip told you *which* line and nothing else. A vehicle silhouette rotated to the
real bearing tells you which line, which way it's pointing, and — over successive frames —
whether it's moving or sitting at a stop, without adding any UI.

The body rotates; the number does not. That split is the whole trick. A rotating label is
unreadable at 200°, and a non-rotating marker can't show heading, so they have to be
separate groups in the same SVG.

### Geometry

Drawn nose-up (heading 0 = north = `-y`), in a local coordinate space where 1 unit ≈ 1 CSS
pixel at default zoom. Body is 18×39 with a 23×43 shadow behind it.

```html
<!-- ROTATING GROUP: transform="rotate(${bearing})" -->
<rect x="-11.5" y="-21.5" width="23" height="43" rx="8" fill="#0B0E13" opacity=".55"/>
<path d="M-9 -18 q9 -5 18 0 v33 q-9 4 -18 0 z" fill="${color}" stroke="#0B0E13" stroke-width="1.6"/>
<path d="M-7.4 -16.4 q7.4 -3.6 14.8 0 v4.6 q-7.4 -2.6 -14.8 0 z" fill="#0B0E13" opacity=".55"/>
<rect x="-8.6" y="-7" width="2.6" height="16" rx="1.2" fill="#0B0E13" opacity=".45"/>
<rect x="6"    y="-7" width="2.6" height="16" rx="1.2" fill="#0B0E13" opacity=".45"/>
<rect x="-10.6" y="-10" width="2" height="6" rx="1" fill="#0B0E13"/>
<rect x="8.6"   y="-10" width="2" height="6" rx="1" fill="#0B0E13"/>
<rect x="-10.6" y="7"   width="2" height="6" rx="1" fill="#0B0E13"/>
<rect x="8.6"   y="7"   width="2" height="6" rx="1" fill="#0B0E13"/>

<!-- UPRIGHT GROUP: never rotated -->
<rect x="-13" y="-8" width="26" height="16" rx="5"
      fill="#0B0E13" stroke="${color}" stroke-width="1.6"/>
<text y="4.6" text-anchor="middle" fill="${color}"
      font-weight="800" font-size="13" letter-spacing="-.3">${line}</text>
```

Roof plate sizing by label length — long codes (`SE833`, `NC1`) need the wider plate:

| label length | plate width | plate x | font-size |
|---|---|---|---|
| ≤ 3 (`5`, `43`, `129`) | 26 | −13 | 13 |
| ≥ 4 (`SE833`) | 34 | −17 | 11 |

Total icon box: **44 × 52**, anchor at **(22, 26)** — the centre of the bus, not the nose
and not the bottom edge. Getting the anchor wrong is what makes markers appear to swing
around a pivot when they turn.

### Leaflet integration

```js
L.divIcon({
  className: 'bus-marker',          // must be background:none;border:0
  html: busSvg(line, color, bearing),
  iconSize:   [44, 52],
  iconAnchor: [22, 26],
})
```

Do **not** rebuild the icon on every poll — `divIcon` replacement destroys and recreates the
DOM node and kills any CSS transition. Create once, then on update mutate the two groups:

```js
marker._rotor.setAttribute('transform', `rotate(${bearing})`);
marker.setLatLng(latlng);
```

Keep a reference to the rotating `<g>` when you build the icon.

### Colour and contrast

Route colour fills the body; the roof plate is dark with a coloured stroke and coloured
text, so light route colours (the 70's tan, the 5's green) stay legible without a
per-colour contrast branch. If you ever put the number *on* the body instead, you need this:

```js
const luma = (r*299 + g*587 + b*114) / 1000;   // text = luma > 150 ? '#0E1218' : '#FFF'
```

### Z-order

Buses whose line is selected in the board get `zIndexOffset: 1000` and `scale(1.15)`;
everything else drops to `opacity: .45`. Same for the route polylines: selected goes to
`weight: 3, opacity: .9`, the rest to `opacity: .14`.

---

## 2. Heading

Priority order:

1. Heading/bearing field from the EMT vehicle payload, if present and non-null.
2. `atan2` between the previous and current fix.
3. Last known heading.

Guard rails, all of which matter with real GPS:

- **Below a movement threshold, freeze the heading.** A stationary bus jitters a few metres
  per fix and will spin on the spot. Roughly: if the fix moved less than ~8 m, keep the
  previous bearing.
- **Normalise the turn to the short way round.** `((next - prev + 540) % 360) - 180` gives a
  delta in −180…180; applying that to the previous heading stops a 350° → 10° step from
  animating the long way around.
- **Snap or ease, pick per real data.** The mockup snaps instantly at corners, which looks
  right for clean geometry. If real fixes are noisy, a 150 ms `transition: transform` on the
  rotating group smooths it; if they're clean, snapping reads as more responsive. Try both
  with live data before deciding — this is the one call I'd hold until you see it.

## 3. Movement between polls

EMT updates on the order of every 10–30 s. A marker that teleports once every 20 s looks
broken; one that lerps in a straight line cuts corners through buildings.

Interpolate **along the route shape**, not through the air:

1. Project the previous fix and the current fix onto the line's shape polyline.
2. Walk the polyline between those two projections over the poll interval.
3. Take the heading from the current polyline segment — which is what makes turns look like
   turns, and what the mockup was demonstrating.

Fall back to a straight-line lerp when the projection is far from the shape (detour,
diversion, bad fix). If the vehicle hasn't moved between polls, hold position and heading —
don't animate to the same point.

---

## 4. Active lines board

### The problem being fixed

Chips are sized by their destination text, so 13 lines wrap into 8 ragged rows and consume
most of the screen. Nothing aligns, so the list has to be read one item at a time.

### The rules that matter

- Line number in a **fixed-width, right-aligned, tabular-nums column** (52px). This is the
  whole point: the numbers form a single scannable column.
- Colour as a **4px spine**, not a filled chip — colour identifies, it shouldn't shout.
- Destination in muted uppercase, `text-overflow: ellipsis`, single line.
- Arrival in a **mono** face, right-aligned, fixed min-width so the digits line up.
- Row height 44px (tap target), separated by a 1px inset shadow rather than a border.
- Sort toggle: soonest ↔ line number. Soonest is the default, since the panel is really a
  departure board.
- `Clear all` writes to an undo buffer and shows an undo bar. Thirteen removals are tedious
  to redo by hand.

### CSS

```css
.board{max-height:34vh;overflow-y:auto;overscroll-behavior:contain}
.row{display:flex;align-items:center;gap:10px;height:44px;padding-right:6px}
.row + .row{box-shadow:0 -1px 0 rgba(255,255,255,.05)}
.row[aria-pressed="true"]{background:rgba(91,157,255,.10)}
.spine{width:4px;height:26px;border-radius:99px;flex:none;margin-left:12px}
.num{font-size:19px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums;
     width:52px;text-align:right;flex:none}
.dest{flex:1;min-width:0;font-size:12.5px;letter-spacing:.05em;text-transform:uppercase;
      color:var(--muted);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eta{font-family:'IBM Plex Mono',monospace;font-size:13px;flex:none;text-align:right;min-width:54px}
.eta small{font-size:10px;color:var(--muted);margin-left:2px}
.eta.soon{color:#3ED27F}          /* ≤ 3 min */
.x{width:30px;height:30px;flex:none;display:flex;align-items:center;justify-content:center;
   color:#5C6577;font-size:17px}
```

### Row markup

```html
<div class="row" data-id="${id}" aria-pressed="${selected}">
  <span class="spine" style="background:${color}"></span>
  <span class="num" style="color:${color}">${line}</span>
  <span class="dest">${destination}</span>
  <span class="eta${eta<=3?' soon':''}">${eta}<small>min</small></span>
  <button class="x" aria-label="Stop following ${line}">✕</button>
</div>
```

### Selection is bidirectional

Tapping a row selects the line on the map; tapping a bus selects the row. One `selectedId`
in state, both views read it. Tapping the same target again clears it.

### Empty state

> Nothing followed yet. Tap a bus on the map to follow its line.

---

## 5. Tokens

```
--ink       #0E1218   page
--surface   #161B23   sheet
--surface-2 #1E242E   raised
--hair      rgba(255,255,255,.09)
--text      #EAEDF3
--muted     #8B94A6
--accent    #5B9DFF   selection, live dot ring
soon        #3ED27F
danger      #FF7B7B   clear all
marker ink  #0B0E13   marker strokes and roof plate fill
```

Type: Archivo 500–800 for UI and line numbers, IBM Plex Mono 400–600 for times.

---

## 6. Quality floor

- `prefers-reduced-motion`: no interpolation, snap markers to each fix; no scale transitions.
- Visible keyboard focus on rows, remove buttons, and the sort toggle.
- Board scrolls with `overscroll-behavior: contain` so it doesn't drag the map.
- Marker DOM is reused across polls; removing a followed line removes its marker and polyline.

## 7. Open questions

- Snap vs 150 ms ease on heading — decide against live data.
- Whether the stop dwell is worth surfacing (a doors-open cue) or is just noise.
- Whether the ETA column should be time-to-my-stop or time-to-terminus. The board only works
  as a departure board if it's the former.
