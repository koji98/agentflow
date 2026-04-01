---
name: frontend-design-system
description: "Define or refactor frontend design systems using design tokens, theme variables, state and variant contracts, and component specifications. Use when creating CSS variable systems, token JSON, Tailwind or shadcn themes, dark mode foundations, component APIs, or when migrating hardcoded visual values into a reusable frontend system."
---

# Frontend Design System

Start with the smallest durable system that can support the product. The goal is not to produce more tokens; the goal is to make visual decisions reusable, explainable, and safe to extend.

## Workflow

1. Audit the current source of truth.
- Identify brand constraints, existing CSS variables, Tailwind config, component library usage, and repeated visual values.
- Decide whether the system is greenfield, a cleanup, or a migration.

2. Model the system from the bottom up.
- Define primitives for raw values such as color ramps, spacing, typography, radius, shadows, and motion.
- Define semantic tokens for roles such as background, foreground, primary, accent, border, success, warning, and error.
- Define component tokens only when shared semantics are not enough.

3. Define component contracts.
- Specify states, variants, sizes, density, and interaction rules for core components.
- Make default, hover, focus-visible, active, disabled, loading, invalid, and selected states explicit.
- Capture accessibility requirements as part of the contract, not as a later patch.

4. Map the system into the stack.
- Wire tokens into CSS variables, Tailwind, shadcn, or the existing styling layer.
- Keep theme switching and dark mode at the semantic layer.
- Prefer incremental adoption over big-bang rewrites.

5. Migrate and validate.
- Replace hardcoded visual values in shared components first.
- Sweep leaf components after the foundation is stable.
- Remove dead aliases and near-duplicate tokens as the migration settles.

## Non-Negotiables

- Do not start at component overrides if palette, spacing, type, and motion primitives are still unclear.
- Keep semantic tokens role-based. They should describe purpose, not a specific hue or component.
- Use component tokens sparingly. If multiple components need the same rule, push it down to the semantic or primitive layer.
- Define state priority explicitly so interactions do not fight each other.
- Keep the system compatible with the surrounding codebase. A perfect token taxonomy is useless if the team cannot apply it.

## Avoid

- Flat token sets where every component owns its own color and spacing values.
- Raw hex, pixel, or shadow literals scattered through shared components.
- Mixing semantic roles and component names in the same token family.
- Rebuilding the whole system just to support one surface-level redesign.

## Reference Loading

- Load `references/token-architecture.md` when creating or restructuring tokens.
- Load `references/component-contracts.md` when defining states, variants, sizes, and interaction rules.
- Load `references/migration-playbook.md` when converting an existing frontend to the new system.
- Use the companion skill `frontend-design` when the work is mainly about aesthetic direction rather than reusable infrastructure.
