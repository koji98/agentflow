---
name: frontend-polish-review
description: "Critique and refine existing frontend surfaces for visual hierarchy, responsiveness, accessibility, interaction states, motion, and perceived quality. Use when reviewing UI code, shipping a landing page, dashboard, or component, fixing generic or inconsistent frontend aesthetics, or turning a mostly-working interface into something deliberate and production-ready."
---

# Frontend Polish Review

Use this skill to convert a "mostly there" UI into something coherent, accessible, and shippable. Treat review work as problem-finding first, then selective refinement.

## Workflow

1. Establish intent before judging details.
- Identify the surface, target user, product context, and intended quality bar.
- Determine whether the interface is extending an existing system or inventing its own language.

2. Audit the highest-risk areas first.
- Check accessibility and input integrity before visual taste.
- Check responsive structure before decorative polish.
- Check interaction states before motion flourishes.

3. Separate findings from preferences.
- Report objective issues as findings.
- Keep optional stylistic suggestions separate from real defects.
- If asked to review, lead with findings ordered by severity and point to concrete files or lines.

4. Fix the highest-leverage issues first when implementation is requested.
- Start with problems that block use, comprehension, or consistency.
- Repair system-level issues before leaf-node prettification.

5. Re-check the surface after edits.
- Test mobile and desktop widths.
- Verify focus, loading, empty, error, and disabled states.
- Confirm the design still reads as one system.

## Review Priorities

1. Accessibility and input integrity
2. Responsive layout and hierarchy
3. Interaction states and feedback
4. Visual system consistency
5. Motion and perceived performance
6. Memorability and product fit

## Non-Negotiables

- Do not hide focus treatment to make the UI look cleaner.
- Do not excuse confusing layout as a matter of taste.
- Do not recommend a redesign when a smaller structural fix will solve the real issue.
- Do not let loading, empty, or error states remain generic after the main surface has been polished.

## Reference Loading

- Load `references/review-rubric.md` for the ordered audit rubric and severity framing.
- Load `references/common-failures.md` for recurring frontend quality problems and "AI slop" symptoms.
- Use the companion skill `frontend-design` when the task becomes substantive redesign work.
- Use the companion skill `frontend-design-system` when the root problem is missing tokens, themes, or component contracts.
