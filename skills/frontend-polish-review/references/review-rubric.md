# Review Rubric

Use this order when auditing frontend quality.

## Severity Framing

- P0: blocks use, breaks accessibility, or causes destructive confusion
- P1: materially harms task success, clarity, or responsive correctness
- P2: noticeably weakens polish, consistency, or trust
- P3: optional refinement with limited user impact

## 1. Accessibility and Input Integrity

Check:
- visible focus states
- keyboard reachability
- readable contrast
- labeled controls
- error recovery paths
- non-color-only feedback

Typical findings:
- focus ring removed
- icon-only controls without labels
- invalid state visible only by color
- modals or menus that trap or lose focus incorrectly

## 2. Responsive Layout and Hierarchy

Check:
- mobile layout decisions, not just wrapped desktop layout
- no clipped or overflowing content
- obvious primary action
- readable content density
- stable spacing rhythm

Typical findings:
- dashboard collapses into card soup on mobile
- primary call to action visually competes with secondary actions
- line lengths or gaps become extreme at large widths

## 3. Interaction States and Feedback

Check:
- hover, focus-visible, active, selected, disabled, loading, empty, and error states
- button and form feedback on async actions
- obvious affordance for interactive cards or rows

Typical findings:
- polished default state but unstyled loading and empty states
- hover-only disclosure on touch surfaces
- destructive actions lack distinct feedback

## 4. Visual System Consistency

Check:
- consistent token usage
- stable radius, shadow, and border language
- coherent typography scale
- surfaces and overlays belonging to the same system

Typical findings:
- one component family uses different radii or elevation logic
- raw literals compete with token-based styles
- unrelated pages look like separate products

## 5. Motion and Perceived Performance

Check:
- motion explains state or hierarchy
- reduced-motion support where needed
- no janky layout-affecting transitions
- loading states reduce perceived waiting

Typical findings:
- motion everywhere but no meaningful choreography
- transition on layout properties causes visible jank
- long empty delay with no skeleton or progress treatment

## 6. Memorability and Product Fit

Check:
- surface feels specific to the product context
- design direction is coherent
- visual choices support trust, energy, density, or calm as required

Typical findings:
- interchangeable generic SaaS styling
- palette and type pairing say nothing about the product
- all sections carry equal visual weight, so nothing is memorable

## Reporting Rule

Lead with the highest-severity issues that a user would actually feel. Do not bury structural problems under optional aesthetic commentary.
