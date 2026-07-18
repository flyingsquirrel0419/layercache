# Layercache 3D Landing Redesign

Date: 2026-07-16 · Status: approved by user ("최선을 다해 3D로 리뉴얼, ㄱㄱ")

## Goal

Replace the default Rspress hero home page of the docs site (`docs-web`) with a
custom-designed 3D landing page. Docs pages keep the Rspress theme, restyled
only via accent tokens so the site reads as one system.

## Subject grounding

layercache is a multi-layer read-through cache (Memory → Redis → Disk) with
stampede prevention. Its world is literally stratified: a request descends
through progressively slower, larger layers; hot data lives near the surface.
The design encodes that directly — **depth = latency, heat = cache hit**.

## v3 structure (final)

The original Rspress home hero is fully restored as the first screen (blue
brand, logo, theme-following light/dark, Get Started / Playground actions,
install tabs via `afterHeroActions`). Below it, the page enters the dark
scroll-driven 3D journey band described in v2, opened by a centered intro
caption ("how a read travels — 100 concurrent requests. One database call.").
The journey no longer forces `rp-dark` or overrides brand colors; the amber /
indigo palette lives only inside the landing band via CSS-module tokens.

## Signature element (v2 — scroll-driven journey)

A full-viewport Three.js scene pinned with `position: sticky` while a 560vh
scroll region drives a camera journey down through the cache strata
(`ScrollJourney.tsx`). Chapters, keyed to scroll progress:

0. Hero — wide view, stack on the right, ambient request rain, headline overlay.
1. L1 Memory (~0.1 ms) — camera levels with L1, hits flare amber, panel appears.
2. L2 Redis (~1 ms) — camera swings to the other side, converging beams show
   the single-flight lease.
3. L3 Disk (~5 ms) — stale-fallback layer, sparse deep beams.
4. Origin (50+ ms) — low angle at the database plane; a stampede of 14 beams
   falls and exactly one reaches origin, on a repeating cycle.
5. Backfill finale — camera pulls up; amber risers climb from origin, flaring
   through each layer on the way back to L1.

Camera path is keyframed (position/look/layer-spread) and smoothed with
exponential damping; the focused layer brightens while others dim. Chapter
panels are DOM overlays (glass cards) toggled by scroll windows; layer labels
are 3D-projected DOM. Live telemetry (requests / hit rate / origin calls)
accumulates from the simulation. Pointer parallax on top. Under
`prefers-reduced-motion` the journey collapses via CSS into a static stacked
page with one rendered frame.

## Tokens

Palette (depth + heat):
- `--void #050810` page background (deep indigo-black)
- `--stratum #0E1526` panel/stratum base
- `--hairline #232E4A` borders and rules
- `--hot #FFB347` cache hit / primary CTA — reserved, the only warm color
- `--ice #7CD7E6` L1 memory highlights and secondary accents
- `--text #E8ECF4`, `--muted #8A93A8`

Type:
- Display: Bricolage Grotesque (headlines only, tight leading)
- Utility: Spline Sans Mono (latency figures, eyebrows, depth ruler, code)
- Body: Rspress default sans

## Page structure

1. **Hero** — headline "100 concurrent requests. One database call. Always." +
   tagline + install command + Get Started / Playground CTAs, 3D canvas
   behind/beside. Canvas is client-only (mounted in `useEffect`), static
   fallback frame under `prefers-reduced-motion`, graceful skip without WebGL.
2. **The read path** — full-width strata bands, one per layer, with real
   latency figures and what happens at that depth (hit, backfill, single-flight
   lease, stale serving). Subtle 3D tilt on scroll.
3. **Capabilities** — the six features from the old home, restyled cards.
4. **Quick start** — real code from README with syntax highlighting.
5. **CTA footer** — install command + docs links.

## Architecture

- `docs-web/theme/index.tsx` exports a fully custom `HomeLayout` (drops
  `BasicHomeLayout`), keeping nav/footer from the theme.
- `docs-web/components/home/` — `HeroScene.tsx` (Three.js, lazy client mount),
  `HomeLanding.tsx` (sections), `home.module.css`.
- `three` promoted from extraneous to a real dependency.
- Docs accent: override Rspress CSS vars (brand color → amber/ice) in a theme
  CSS file.

## Constraints / quality floor

- SSG-safe: no `window`/WebGL access during server render.
- Responsive to mobile (canvas scales down; sections stack).
- `prefers-reduced-motion` respected; keyboard focus visible.
- Verified with `npm run build` and Playwright screenshots.
