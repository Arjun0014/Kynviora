# Accessibility and Content Design

Status: Product/UX acceptance policy
Last reviewed: 2026-08-20

## Principle

Senior accessibility is part of the product definition, not a theme or later optimization.
Every feature must work for users with larger text, reduced dexterity, lower vision, screen
readers, cognitive load, and intermittent connectivity.

## Visual requirements

- Body text must be comfortably readable at default settings.
- Support system font scaling without clipping critical content/actions.
- Primary touch targets should be at least 48 x 48 density-independent pixels where practical.
- Maintain sufficient contrast in light/dark themes.
- Never communicate evidence, urgency, verification, or success through color alone.
- Pair color with text label and icon where useful.
- One clear primary action on high-impact safety screens.
- Avoid dense data tables on small screens when progressive disclosure is clearer.
- Keep profile identity visible on medicine/product/safety screens.

## Interaction requirements

- Core tasks cannot require swipe-only or long-press-only gestures.
- Preserve capture/form progress across interruption when feasible.
- Confirm destructive/sensitive actions.
- Make permission denial a supported state, not an error dead end.
- Restore focus after dialogs/navigation.
- Announce meaningful status changes politely to screen readers.
- Avoid short countdowns/memory-dependent actions.
- Support external keyboard/switch navigation where platform behavior permits.

## Screen-reader requirements

- Every actionable control has a meaningful accessible name/role/state.
- Decorative images are not announced.
- Product photos have useful context where needed, not verbose OCR dumps.
- Alert severity/evidence/match status is announced in logical order.
- Complex cards expose a concise summary plus clear navigation to detail.
- Test real TalkBack behavior, not just static lint checks.

## Cognitive accessibility

- Use familiar words first, technical terms second.
- Explain one idea per sentence when safety-critical.
- Break capture/verification into confirmable steps.
- Clearly separate facts from recommendations/limitations.
- Do not shame missed medicines.
- Do not use fear-driven notification copy.
- Reuse consistent status vocabulary.
- Show what the user can do next.

## Safety copy structure

For a material alert, prefer:

1. What happened.
2. Which person/item this applies to.
3. How exact the match is.
4. What Kynviora recommends doing next within its approved role.
5. Why it was flagged.
6. Evidence/source/date.
7. Important limitation or what not to infer.
8. Correction/report action.

## Controlled language examples

Prefer:

- "This batch matches the batch listed in the official notice."
- "Your product label contains an ingredient that matches a sensitivity recorded for Priya."
- "Kynviora could not verify the current formula. Check the ingredient label before relying on this result."
- "No current matched alert was found in Kynviora's monitored sources. This does not guarantee the product is safe for everyone."

Avoid:

- "This product is safe."
- "This medicine is dangerous."
- "AI detected a harmful ingredient."
- "Stop taking this medicine now" unless an approved jurisdiction-specific official instruction
  is being presented under reviewed policy and appropriate professional/emergency direction.

## Evidence language

Users should not need to understand scientific grading systems to act. Show plain labels with
optional deeper explanation.

Example:

- Official action.
- Established guidance.
- Strong reviewed evidence.
- Limited evidence.
- Emerging signal.
- Insufficient information.

Do not use a percentage confidence if the number is not empirically calibrated and meaningful.

## Verification language

Keep identity/formula/batch certainty distinct:

- Product identity confirmed.
- Product identity probable.
- Formula confirmed from this label.
- Formula not verified.
- Batch confirmed.
- Batch not entered.

## Notification content

Default lock-screen safety notification should be generic, for example:

"Kynviora has an important update."

Detailed medicine/product/profile information appears only after authenticated app open.

Medicine reminder privacy settings may allow more detail only through explicit user choice and
platform-appropriate disclosure.

## Localization

Indian-language expansion should begin with user research and terminology review. Critical
health/safety language should not rely on raw machine translation alone.

Maintain:

- controlled terminology glossary;
- approved translation per safety template;
- locale-aware dates/times/numbers;
- screen-reader pronunciation review for key terms;
- fallback to plain understandable English where a technical translation is unclear and the
  user has chosen English support.

## Accessibility test matrix

At minimum test:

- default Android font;
- largest supported font size;
- TalkBack;
- bold/high-contrast/reduced-motion settings where relevant;
- portrait small phone;
- large phone/tablet adaptation;
- keyboard/switch basic navigation;
- low bandwidth/offline;
- interrupted camera/permission flows;
- one-handed use where practical.

## Release gate

A high-impact feature is not done if its safety state is inaccessible, clipped, ambiguous,
color-dependent, or unusable with TalkBack/large text.
