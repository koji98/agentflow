# Token Architecture

Use a three-layer system unless the project is so small that a reusable system would be wasteful.

## Layers

### Primitive Tokens

Store raw values with no product meaning.

Examples:
- color ramps
- spacing steps
- type sizes
- radius sizes
- shadow levels
- durations and easing curves

Good names:
- `--color-slate-950`
- `--space-4`
- `--font-size-3`
- `--radius-md`
- `--duration-fast`

### Semantic Tokens

Store role-based aliases that reference primitives.

Examples:
- `--color-bg`
- `--color-fg`
- `--color-primary`
- `--color-border`
- `--color-danger`
- `--surface-elevated`
- `--space-section`

Use the semantic layer for:
- themes
- dark mode
- brand swaps
- contextual surface treatment

### Component Tokens

Store component-specific contracts only when semantics are not enough.

Examples:
- `--button-bg`
- `--button-fg`
- `--input-ring`
- `--card-padding`

Use this layer when:
- the component has a distinct rule that should not leak into every surface
- the component needs a local override with stable naming

If the same component token starts appearing everywhere, push it down a layer.

## Core Categories

Model at least these categories:
- color
- typography
- spacing
- radius
- border width
- shadow
- motion duration
- motion easing

Add z-index, blur, opacity, or data-viz tokens only when the product needs them.

## Color Storage

Prefer variable formats that work cleanly with the stack.

- Use space-separated HSL channels when the stack relies on Tailwind opacity modifiers.
- Use OKLCH or hex for primitives only if the team and tooling support it cleanly.
- Keep semantic usage stable even if primitive storage changes later.

## Example Flow

```css
:root {
  --color-blue-600: 217 91% 60%;
  --color-slate-950: 222 47% 11%;
  --space-4: 1rem;
  --radius-md: 0.75rem;
  --duration-fast: 150ms;

  --color-bg: 0 0% 100%;
  --color-fg: var(--color-slate-950);
  --color-primary: var(--color-blue-600);
  --space-section: calc(var(--space-4) * 2);

  --button-bg: var(--color-primary);
  --button-radius: var(--radius-md);
}
```

## Theme Switching

Theme switching belongs at the semantic layer.

Good:
- light and dark themes override `--color-bg`, `--color-fg`, `--color-border`, and similar semantic roles

Bad:
- dark mode rewriting every component token one by one

## Tailwind and Component Libraries

Map semantic tokens into framework utilities. Example:

```ts
colors: {
  background: "hsl(var(--color-bg))",
  foreground: "hsl(var(--color-fg))",
  primary: "hsl(var(--color-primary))",
  border: "hsl(var(--color-border))",
}
```

Let shared components consume these mapped roles instead of raw literals.

## Done Criteria

- repeated values exist in tokens, not scattered literals
- dark mode or theme switching touches semantic roles first
- shared components read from the system consistently
- the naming scheme is predictable enough to extend without guesswork
