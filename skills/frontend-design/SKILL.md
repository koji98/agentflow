---
name: frontend-design
description: "Design and implement distinctive, production-grade frontend pages, components, and application surfaces with strong aesthetic direction and ship-ready interaction quality. Use when building or redesigning landing pages, dashboards, marketing sites, app shells, forms, cards, tables, navigation, or other frontend UI where typography, color, layout, motion, and visual polish matter."
---

# Frontend Design

Start by deciding whether to extend an existing visual language or invent a new one. If the codebase already has a credible design system, token set, or recognizable aesthetic, preserve it and push it forward instead of replacing it.

## Workflow

1. Read the context before styling.
- Identify the surface, audience, task, constraints, and current visual language.
- Inspect nearby files for tokens, components, spacing rules, and recurring patterns.
- Decide whether the work is extension, cleanup, or invention.

2. Write a compact design brief before coding.
- Lock five things: audience, tone, primary aesthetic direction, memorable differentiator, and non-negotiable constraints.
- State the chosen direction in plain language before implementation.
- If the request is narrow, isolate that dimension instead of restyling everything. Typical narrow passes are typography-only, color-only, motion-only, and layout-only.

3. Build the visual system before tuning individual components.
- Establish typography, palette, spacing rhythm, surface treatment, borders, shadows, and motion tokens first.
- Prefer CSS variables or existing tokens over one-off values.
- Make one dominant idea obvious. Do not distribute emphasis evenly across every element.

4. Implement the surface with production discipline.
- Make responsive behavior deliberate, not an afterthought.
- Handle empty, loading, error, hover, focus, active, selected, and disabled states.
- Use motion to explain structure or state change, not to decorate randomly.
- Keep the interface functional and legible even when the dramatic styling is stripped away.

5. Polish until the work feels intentional.
- Remove generic defaults and filler sections.
- Tighten hierarchy, alignment, spacing, and copy density.
- Check the surface at mobile and desktop widths before finishing.

## Non-Negotiables

- Commit to a clear aesthetic direction. Bland compromise is worse than bold restraint.
- Match code complexity to the design goal. Refined minimalism needs precision; maximalism needs rigorous systemization.
- Use typography intentionally. Avoid default stacks unless the product already depends on them.
- Use backgrounds, textures, contrast, and composition to build atmosphere.
- Preserve accessibility, keyboard support, and readable contrast while styling.
- Respect existing product patterns unless the task explicitly calls for a new language.

## Avoid

- Generic "AI slop" layouts, especially interchangeable hero, feature-grid, testimonial, and pricing sections.
- Purple-on-white gradients, default glass cards, or familiar SaaS tropes unless the product genuinely calls for them.
- Random mixtures of styles, radii, shadows, and interaction patterns.
- Constant animation. One orchestrated sequence is better than movement everywhere.
- Hardcoding presentational values everywhere when tokens or variables should exist.

## Reference Loading

- Load `references/aesthetic-directions.md` when choosing or sharpening a concept.
- Load `references/implementation-patterns.md` when translating the concept into layout, typography, motion, and state behavior.
- Load `references/delivery-checklist.md` before finalizing.
- Use the companion skill `frontend-design-system` when the real task is reusable tokens, theming, or component contracts.
- Use the companion skill `frontend-polish-review` when the real task is critique, bug-finding, or ship-readiness review.
