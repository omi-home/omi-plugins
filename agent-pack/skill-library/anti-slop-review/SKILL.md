---
name: anti-slop-review
description: Use before finalizing a design contract or when reviewing a UI diff, to catch generated-look defaults.
---
# Anti-slop review

A floor against the defaults every model falls into. Check each item; a hit is a finding with the file and line (or the contract item) and the fix.

## Floor (always a defect)

1. Every colour and font goes through a token; no literal colour or `font-family` outside the token block. No pure `#000`/`#fff` outside it.
2. No `transition: all`; never animate `width`, `height`, `top` or `left` (use `transform`, `opacity`).
3. Every animation has a `prefers-reduced-motion: reduce` fallback; content is visible with scripting off (no reveal class that leaves `opacity: 0` without JS).
4. Every interactive element has `:focus-visible`, shown instantly, at 3:1 contrast or better; never an outline removed with nothing in its place.
5. No horizontal scroll at any width 320–1920: `overflow-x: clip` on `html` and `body`, never `100vw`; image grid tracks `minmax(0, 1fr)`; long headings wrap (`overflow-wrap: break-word; min-width: 0`).
6. No card inside a card; no emoji as an icon; no hand-drawn browser or OS window; no purple-to-blue gradient.
7. Never invented metrics, testimonials, logo walls or counts; never a form that shows success with no request behind it.
8. No eyebrow label over a heading, no tracked capitals or small caps on labels, no middle-dot meta strings, no arrow glued to link text, no decorative status dots.
9. Hero headline, one sentence and primary action visible at 1280×800 without scrolling; about 80 words per screen.
10. Container capped and centred: at 1920 the gutters grow, the grids do not gain columns.
11. Text contrast 4.5:1 (large text, icons, field edges 3:1); button text clearly differs from its fill; button labels never wrap.

## Reflexes (a finding unless the contract gives a reason)

Inter/Roboto/system face as display; more than three font families; one accented word in a heading; prose wider than 75ch; three equal icon-over-heading cards; hero → features → call to action → footer; the same gap between every section; the same hover lift on every card; bounce easing on UI state; a framework's default palette; gradient text; glow blobs behind text; an email sign-up as the stock last section; one fact repeated in four sections.

Report only what you can point at. Taste beyond this list is not a finding.

---
Source: Nutlope/hallmark skills/hallmark/SKILL.md ("The Floor") and skills/hallmark/references/gates.md @ 04977e1. MIT License, Copyright (c) 2026 Hallmark contributors. Adapted.
Source: Leonxlnx/taste-skill skills/taste-skill/SKILL.md (section 6, Never) @ f6b7657. MIT License, Copyright (c) 2026 Leonxlnx. Adapted; full notices in THIRD_PARTY_NOTICES.
