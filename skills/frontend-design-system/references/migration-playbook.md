# Migration Playbook

Use this when a codebase already exists and the design system must be introduced or repaired.

## 1. Inventory the Current Surface Area

Search for repeated literals and ad hoc styling:
- hex colors
- rgb or hsl literals
- repeated spacing classes
- inconsistent radius and shadow values
- one-off component overrides

Useful searches:

```bash
rg -n "#[0-9A-Fa-f]{3,8}" src
rg -n "rgb\\(|hsl\\(" src
rg -n "rounded-|shadow-|tracking-|leading-" src
```

## 2. Collapse Near-Duplicates

Before naming tokens, reduce accidental variety.

Examples:
- three almost-identical card shadows
- six slightly different neutral borders
- inconsistent button paddings

Normalize the values first, then tokenize.

## 3. Create the Foundation

Establish:
- primitive ramps and scales
- semantic roles
- theme entry points
- motion and radius rules

Do not start by tokenizing every component file individually.

## 4. Update Shared Components First

Refactor the highest-leverage surfaces:
- buttons
- inputs
- cards
- modals
- navigation shells

These components spread the new system across the product fastest.

## 5. Sweep Leaf Components

After the foundation is stable:
- replace local literals with semantic roles
- remove temporary aliases
- keep exceptions explicit and rare

## 6. Validate the System

Check:
- dark mode or alternate themes still work
- focus and invalid states remain visible
- no shared component still depends on accidental literals
- token names are understandable without reading every file

## 7. Remove Dead Paths

Delete:
- unused aliases
- old CSS variables
- duplicate Tailwind extensions
- component-specific hacks that the new contract replaces

## Migration Rule of Thumb

Move from shared foundations outward. A token migration that starts in leaf components usually creates two systems instead of one.
