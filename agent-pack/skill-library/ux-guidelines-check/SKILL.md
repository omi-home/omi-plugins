---
name: ux-guidelines-check
description: Use when designing or checking interaction, touch, forms, states, navigation or UI performance.
---
# UX guidelines check

Work through the categories in priority order; stop at what the change touches. Each miss is a finding naming the screen or file and the fix.

| # | Category | Must have | Avoid |
| --- | --- | --- | --- |
| 1 | Accessibility | text contrast 4.5:1; alt text on meaningful images; every action by keyboard in visual order; labels on icon-only buttons; errors announced (`aria-live` / `role=alert`); meaning never by colour alone | removed focus rings; keyboard traps; placeholder-only inputs |
| 2 | Touch and interaction | targets 44×44 (web minimum 24×24 CSS px with spacing); 8px between targets; loading feedback; buttons disabled while processing; confirm before delete or irreversible actions | hover-only actions; drag as the only way; silent failures |
| 3 | Performance | sized, compressed images (WebP/AVIF); lazy loading below the fold; space reserved for async content (layout shift < 0.1) | layout thrashing; content that jumps |
| 4 | Style | one consistent style for the product type; SVG icons from one set | emoji as icons; mixing flat and skeuomorphic |
| 5 | Layout and responsive | mobile first; `width=device-width, initial-scale=1`; content fits the viewport; z-index from a small scale | horizontal scroll; fixed-px containers; disabled zoom |
| 6 | Typography and colour | body 16px, line height about 1.5; semantic colour tokens | body text under 12px; grey on grey; raw hex in components |
| 7 | Animation | 1–2 animated elements per view; motion that explains a change; `prefers-reduced-motion` honoured; auto-advancing content with pause, stop on hover/focus | one duration for everything; animating width/height; depending on `transitionend` for state |
| 8 | Forms and feedback | visible label per field; a specific error under its field, linked with `aria-describedby`; an error summary that takes focus after a failed submit; loading then success/error after submit; paste and password managers allowed | errors only at the top; blocked paste; no feedback after submit |
| 9 | Navigation | predictable back; deep links for each state worth sharing; bottom nav ≤ 5 items | broken back; overloaded nav |
| 10 | Charts and data | legends, tooltips, accessible colours; a text or table alternative | colour as the only encoding |

Also check: long words and tokens wrap without clipping; essential text is never truncated without a way to see it; sticky headers do not cover the focused element; AI-generated content is labelled as such.

---
Source: nextlevelbuilder/ui-ux-pro-max-skill .claude/skills/ui-ux-pro-max/SKILL.md (rule priorities) and .claude/skills/ui-ux-pro-max/data/ux-guidelines.csv @ 2de1134, distilled to markdown. MIT License, Copyright (c) 2024 Next Level Builder. Adapted; full notice in THIRD_PARTY_NOTICES.
