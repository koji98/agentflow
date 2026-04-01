# Common Failures

Use this list to spot recurring frontend problems quickly.

## Generic Aesthetic Defaults

Symptoms:
- purple gradient on white
- interchangeable hero, feature, testimonial, pricing stack
- safe but anonymous typography

Fix:
- derive the palette and type system from product context
- choose one memorable structural move
- remove sections that exist only because templates expect them

## Card Soup

Symptoms:
- every block is the same rounded panel
- no section has stronger hierarchy than the rest

Fix:
- vary density, framing, and background treatment
- let some content breathe and some content compress
- reserve strong containers for high-value groupings

## Dead States

Symptoms:
- beautiful default surface
- broken, missing, or generic loading, empty, error, disabled, and focus states

Fix:
- audit state coverage component by component
- keep feedback on-theme and readable

## Hover-Only Design

Symptoms:
- key actions, labels, or affordances appear only on hover
- interactive cards feel static on touch devices

Fix:
- expose primary affordances without hover
- keep touch and keyboard paths first-class

## Inconsistent System Language

Symptoms:
- multiple radii, shadow models, or border colors with no reason
- one page feels polished while another looks like starter UI

Fix:
- trace the inconsistency back to missing tokens or shared contracts
- normalize the rules at the system layer

## Motion Without Meaning

Symptoms:
- everything animates
- nothing explains state or hierarchy
- page feels slow rather than alive

Fix:
- keep one deliberate entrance sequence
- use motion for focus, continuity, and feedback
- remove decorative movement that adds no clarity

## Poor Density Management

Symptoms:
- marketing pages feel cramped
- expert tools waste space on oversized cards

Fix:
- tune density by product type
- use separate spacing and type expectations for storytelling surfaces versus operational surfaces

## Mobile Afterthoughts

Symptoms:
- layout merely wraps
- sticky bars cover content
- tables or filters become unusable

Fix:
- redesign the mobile hierarchy intentionally
- preserve key actions and scanning paths
- remove or reframe non-essential decoration at small widths

## Token Drift

Symptoms:
- raw literals reappear after a system exists
- components override semantic roles casually

Fix:
- route recurring exceptions back into tokens or component contracts
- remove temporary styling hacks once the system can absorb them
