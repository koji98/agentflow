# Component Contracts

Define component behavior as a contract, not as scattered style guesses.

## Required State Set

Document these when they apply:
- default
- hover
- focus-visible
- active
- disabled
- loading
- invalid
- selected

For disclosure, tabs, menus, accordions, dialogs, and drawers, also define open and closed behavior.

## State Priority

Use a stable priority order so styles do not conflict:
1. disabled
2. loading
3. invalid
4. active
5. focus-visible
6. hover
7. default

## Variants

Define what each variant means before styling it.

Typical variant families:
- primary
- secondary
- tertiary or ghost
- destructive
- success or positive
- inverse

Each variant should answer:
- what role it plays
- where it is allowed
- how emphasis differs from the default action

## Size and Density

Define shared size tiers for interactive components.

Minimum expectations:
- touch-friendly target area on mobile
- stable icon sizing relative to text
- predictable horizontal and vertical padding
- data-dense modes only when the product actually needs them

## Accessibility Rules

- focus-visible treatment must be obvious and styled, not removed
- disabled states must stay readable
- color cannot be the only state indicator
- invalid states need both visual and textual feedback
- icon-only controls need labels

## Component Families

### Buttons

Specify:
- variant meanings
- size tiers
- icon-only behavior
- loading behavior
- disabled behavior

### Inputs and Forms

Specify:
- label treatment
- helper text
- invalid state
- success state if the product uses it
- prefix or suffix affordances
- field grouping and spacing rhythm

### Cards and Panels

Specify:
- default surface elevation
- borders or shadow usage
- padding scale
- interactive vs static cards

### Navigation

Specify:
- active item treatment
- hover and focus treatment
- responsive collapse behavior
- selected and expanded states

### Tables and Dense Data Views

Specify:
- row height tiers
- header hierarchy
- hover and selected rows
- tabular numerals where needed
- empty and loading states

## Contract Smells

Refactor when you see:
- two variants that differ only by arbitrary color choice
- components inventing their own shadows, radii, or spacing
- inconsistent focus styling across families
- data-dense screens using the same spacing as marketing pages
