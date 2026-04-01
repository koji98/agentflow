# Implementation Patterns

## Design Brief

Name the chosen direction before coding. Lock:
- target user
- product goal
- tone
- primary aesthetic direction
- one memorable move
- non-negotiable constraints

Keep the brief short enough to hold in working memory while implementing.

## Extension Mode vs Invention Mode

### Extension Mode

Use when the codebase already has:
- tokens or CSS variables
- a component library
- consistent spacing, radius, or shadow rules
- a credible brand or product aesthetic

In this mode:
- inherit the existing system first
- improve hierarchy, motion, or composition without breaking consistency
- introduce new tokens only when the current system has a real gap

### Invention Mode

Use when the surface is greenfield or the current language is weak.

In this mode:
- pick one direction from `aesthetic-directions.md`
- establish type, color, spacing, surfaces, and motion before component tuning
- encode repeated values as variables or tokens immediately

## Design Dimensions

### Typography

- Use type to express the concept, not just to label sections.
- Build visible contrast between display, heading, body, and meta text.
- Use tabular numerals for dashboards, metrics, timers, and price columns.
- Avoid making every heading bold and every paragraph muted. That flattens hierarchy.

### Color and Surfaces

- Build one dominant base and one controlled accent system.
- Let surfaces, borders, and overlays reinforce depth and pacing.
- Prefer variable-driven color usage over raw literals in components.
- Use texture, grain, gradients, or pattern only when it supports the chosen direction.

### Layout and Composition

- Decide where asymmetry, overlap, framing, or density will carry the concept.
- Break the grid intentionally, not accidentally.
- Keep the reading order obvious even when the composition is unconventional.
- On mobile, simplify aggressively while preserving the same idea.

### Motion

- Use transform and opacity for most UI motion.
- Make motion explain hierarchy, entrance order, expansion, or feedback.
- Prefer one meaningful reveal sequence over many unrelated micro-animations.
- Respect reduced motion and keep the interface usable without animation.
- Introduce animation libraries only when the stack already uses them or the choreography genuinely requires them.

### State Design

- Design default, hover, focus-visible, active, selected, disabled, loading, empty, and error states as part of the component.
- Make focus states visible and stylistically integrated instead of hiding them.
- Keep loading and empty states on-theme; do not let them fall back to placeholder-looking defaults.

## Narrow Passes

Use a narrow pass when the user only wants one design dimension improved.

### Typography-Only Pass

- keep layout and palette stable
- improve hierarchy, font choice, scale, and rhythm
- avoid sneaking in a full redesign

### Color-Only Pass

- preserve structure
- normalize palette, surfaces, and contrast
- encode color decisions into tokens or variables

### Motion-Only Pass

- leave the visual language intact
- add entrance, state, and feedback choreography
- avoid changing content density or layout unless motion exposes a structural issue

### Layout-Only Pass

- preserve brand cues and type choices
- rework information hierarchy, spacing, alignment, grouping, and responsive behavior

## Build Order

1. establish tokens or variables
2. shape layout and hierarchy
3. implement core components
4. fill out interaction states
5. add motion and atmosphere
6. test mobile and desktop
7. remove anything that does not strengthen the concept
