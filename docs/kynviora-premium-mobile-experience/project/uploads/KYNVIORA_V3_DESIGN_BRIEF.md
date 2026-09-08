# Kynviora V3 — Product Experience Refinement Brief

## Status

This is a refinement of the approved V2 direction, not a restart.

V2 solved the biggest structural problems:
- Today / Shelf / Health / Care / You
- Safety as a cross-cutting lens rather than a permanent primary tab
- My Shelf + Considering
- image-first product tiles
- category grouping
- Compare
- richer product detail
- Agent Jobs / Agent Activity
- contextual agent architecture
- people-first Care direction

Preserve those strengths.

V3 should focus on the parts that still feel weak or under-designed:
1. the always-available Talk to Kynviora interaction
2. Health, which needs a major redesign
3. Care, which needs to become much more visual and human
4. You/settings, which needs proper information architecture
5. the semantic colour / attention / change language across the whole app
6. richer trend, record, change, and comparison visualizations
7. overall glanceability and interaction polish

Do NOT turn this into another full redesign from scratch. Preserve the V2 work that is already strong and create a V3 fork/refinement.

The connected Kynviora repo, current design docs, current V2 artifacts, and safety/accessibility rules remain authoritative for capabilities and constraints.

---

# 1. Product quality target

Kynviora should feel like a world-class health-tech product.

WHOOP remains a quality reference for:
- information hierarchy
- interactive charts
- dense but understandable health data
- touchable/selectable visualization
- polished transitions
- strong dark-mode execution
- glanceability
- detail-on-demand
- visual confidence

Do not copy WHOOP's branding, rings, scores, or proprietary layouts.

Kynviora needs its own visual identity based on:
- exact products
- personal health context
- evidence and provenance
- safety coverage
- longitudinal health records
- caregiving
- comparison
- contextual agent assistance

The app should feel technical because information is expressed intelligently, not because it contains lots of text.

---

# 2. Preserve the V2 navigation

Primary navigation remains:

1. Today
2. Shelf
3. Health
4. Care
5. You

Safety stays cross-cutting:
- Safety Lens on Shelf
- product safety/evidence inside product detail
- relevant changes on Today
- safety/evidence inside Compare
- personalized relevance inside Health
- secondary Coverage / Safety Center for deeper inspection

Do not restore Safety as a primary bottom tab in V3.

---

# 3. Talk to Kynviora — persistent Siri-like control

The V1-style persistent `Talk to Kynviora` control is preferred over a small floating bubble.

## Default state

On normal app screens, place a persistent, premium Talk to Kynviora bar immediately above the primary bottom navigation.

It should feel like a system-level capability of Kynviora, not a chat feature.

Example visual behavior:
- full-width or near-full-width pill/bar
- subtle cyan/teal outline or inner glow
- waveform/listening glyph
- always readable label: `Talk to Kynviora`
- visually quieter when idle
- visually alive when listening

It should remain present across Today / Shelf / Health / Care / You and normal detail screens unless a task such as camera capture, keyboard-heavy input, or a critical confirmation needs the space.

## Tap behavior

Tapping the bar should NOT open a chatbot sheet.

Instead:
1. keep the current screen visible
2. enter listening state in place
3. animate the bar / border / waveform
4. optionally apply a very subtle screen-level listening tint
5. use the current UI context automatically
6. show compact in-context visual feedback only when needed

This should feel closer to Siri / Google voice interaction than to a messaging app.

Possible states:
- Idle
- Listening
- Understanding
- Working
- Needs confirmation
- Done
- Could not complete
- Needs more information

Every state must have text/shape, not colour alone.

## Contextual examples

While viewing a product:
- "What am I looking at?"
- "Tell me more about this."
- "Which ingredient changed?"
- "Why is this marked as incomplete?"
- "Compare this with the other toothpastes I'm considering."

While viewing Shelf:
- "Show only toothpaste."
- "Group these by category."
- "Only show things I'm considering."
- "Select all the shampoos."
- "Compare them."

While viewing Health:
- "Show my blood pressure over the last six months."
- "What changed since my last annual checkup?"
- "Open my latest thyroid results."
- "What records did I add this year?"

While viewing Care:
- "Show me what Anita can change."
- "Take me to Sanjay's permissions."
- "Who can record doses for Mom?"

The visible screen should respond in place when possible.

## Full Elder Mode

Full Elder Mode remains a separate full-screen mode:
- very low density
- huge text
- one task at a time
- very large confirmations
- obvious listening/speaking states
- easy return to normal touch UI

The same typed tool system powers both regular contextual voice and Elder Mode.

---

# 4. Health V3 — complete redesign

The current Health V2 is not acceptable as the primary Health destination.

It behaves too much like a small wearable metrics dashboard and does not represent the full medical/health identity of a person.

Health should answer:

> What does Kynviora actually know about this person, where did it come from, what changed, and how has it evolved over time?

Health must give equal weight to:
- medical records
- lab results
- conditions
- allergies/sensitivities
- medicines
- measurements
- wearable data
- sleep/activity
- clinical documents
- history
- changes between records

Wearable trends are one part of Health, not the whole Health product.

---

# 5. Health information architecture

Explore the strongest interaction model, but conceptually Health needs four major layers:

## A. Overview / Health Profile

The high-level health identity of the selected person.

At a glance, show important structured domains such as:
- Allergies & sensitivities
- Conditions
- Current medicines
- Recent medical records
- Recent labs
- Connected health sources
- Key measurements
- Important recent changes

Do not turn this into a health score.

This page must be understandable in seconds.

Possible top hero:
- selected person's name/avatar
- concise health-context summary
- last-updated/source freshness
- refined interactive body/health-domain visualization if it truly helps

## B. Records

Clinical and personal medical records are first-class.

Possible categories:
- Lab results
- Conditions / diagnoses
- Allergies & sensitivities
- Procedures
- Vaccinations
- Prescriptions / medication records
- Clinical letters
- Imaging reports
- Annual health checkups
- Medical documents
- Imported records
- User-entered health facts
- clinician-entered/provider-imported facts where supported

Records should not look like a file browser.

Use structured summaries first, original source/document second.

## C. Trends

This is where WHOOP-quality data visualization belongs.

Possible metrics:
- heart rate
- resting heart rate
- HRV
- blood pressure
- SpO2
- sleep duration
- sleep stages
- weight
- temperature
- activity/steps
- exercise
- other supported Health Connect / HealthKit observations

Trends must be beautiful, interactive and source-aware.

## D. History / Timeline

A longitudinal health timeline:
- new diagnosis/fact recorded
- medicine started/changed/stopped as recorded
- lab report added
- annual checkup imported
- sensitivity recorded
- measurement source connected
- relevant product/formulation changes
- caregiver-recorded events where appropriate

Allow filters such as:
All / Records / Labs / Medicines / Measurements / Conditions

---

# 6. Health Overview — make the person legible

The Overview should feel like a premium `Health Passport`, not a settings page.

Potential structure:

## Health identity hero
- person
- age/date-of-birth only if actually recorded
- source freshness
- connected sources
- no synthetic health grade

## Key medical context
Compact, visually distinct modules:
- Allergies
- Conditions
- Medicines
- Important sensitivities

These should be tappable and expandable.

## Recent change
A prominent block answering:
`What changed since the last meaningful record?`

Examples:
- 2 new lab values
- 1 result moved outside the source report's reference interval
- medication record updated
- new allergy recorded
- annual health check comparison available

Never infer diagnosis from the change.

## Latest measurements
Use small rich visual components, not plain rows.

## Records preview
Recent labs/checkups/documents with source and date.

## Trends preview
A few meaningful trends, each tappable into a full detail page.

---

# 7. Health Map / anatomical visualization

Explore an interactive human/body visualization, but only if it improves navigation or comprehension.

Do NOT create a glowing sci-fi skeleton merely as decoration.

A useful version could behave like a health-domain map:
- cardiovascular
- respiratory
- metabolic
- sleep/recovery
- allergies/sensitivities
- musculoskeletal
- medication context
- measurements

The body/domain map can show:
- which domains have data
- which have new records
- which have recent updates
- where there are gaps

It must not imply organ health/sickness without evidence.

A user tapping a domain should drill into real records/metrics.

If another visual metaphor is stronger, use that instead.

---

# 8. Lab results — a flagship V3 experience

Lab data should be one of the best-designed areas of Kynviora.

## Latest report

Show:
- provider/source
- date
- report type
- number of structured observations
- original document available
- extraction/provenance state

Then display structured analytes/results.

For each result:
- analyte/test name
- value
- unit
- reference interval if the source provides one
- source flag if the report provides one
- previous comparable result
- delta from previous
- mini trend where useful
- provenance/source

Do not invent normal/abnormal interpretation if the source did not provide it.

If a source report flags a result, show that as:
`Flagged by source report`
not as a Kynviora diagnosis.

## Compare reports

Support:
- latest vs previous
- annual checkup vs previous annual checkup
- selectable older report

Create a visual comparison report:

### Changed
values with meaningful numeric difference

### New
tests present now but not before

### Missing
tests present before but absent now

### Unchanged / similar
collapsed by default

Use aligned rows, delta arrows, mini sparklines, reference bands, and tap-to-open detail.

Do not generate a health score.

---

# 9. Annual health checkups

Make annual/periodic checkups a special longitudinal experience.

Example:

`Annual Health Check — 2026`
compared with
`Annual Health Check — 2025`

Visual summary:
- 32 comparable results
- 5 changed materially by numeric delta
- 2 new measurements
- 1 source-flagged result
- 4 tests not repeated this year

These counts describe the report difference, not health quality.

Sections can include:
- Blood counts
- Thyroid
- Lipids
- Glucose/metabolic
- Liver
- Kidney
- Vitamins/minerals
- Other provider-defined groups

Allow:
- side-by-side
- overlay trends
- open original report
- ask Kynviora about a specific measured change

This should feel closer to an interactive personal health record than a PDF viewer.

---

# 10. Trend visualization — WHOOP-quality bar

The current trend visual language needs a major quality upgrade.

Use the attached WHOOP references as inspiration for polish and interaction density, not metrics or branding.

Every important trend should support:
- 7D / 30D / 3M / 6M / 1Y where appropriate
- interactive scrubbing
- tap/drag to inspect a point
- date/time
- exact value
- source/device
- optional reference band where legitimate
- gaps shown as gaps, never interpolated silently
- multiple source indicators if needed
- comparison with prior period where useful

### Blood pressure
Use paired systolic/diastolic visualization with clear labels.

### Sleep
Use:
- duration
- bedtime/wake time
- stages only if source provides them
- timeline-style stage visualization
- trends over time

### Heart metrics
Use strong line/area visualization and detail drawer.

### Labs
Use sparse longitudinal points with reference interval bands, not a fake continuous line when measurements are months apart.

The visual should match the nature of the data.

---

# 11. "What changed?" becomes a system-wide pattern

Kynviora should become excellent at showing change.

Create a reusable `Change Lens` / `Change Summary` pattern.

Use it for:
- annual health checkups
- lab reports
- formulation changes
- product ingredient changes
- medicine record changes
- caregiver access changes
- connected-source changes
- new regulatory evidence

The pattern should answer:
1. what changed
2. compared with what
3. when
4. source
5. whether action is needed
6. what is unknown

Use visually graded change blocks, diff rows, timeline markers, and before/after comparisons.

Avoid paragraphs when a visual diff is possible.

---

# 12. Care V3 — full visual redesign

Care V2 is directionally better but still too text/settings-like.

Care should feel like a living household/care network.

## Care home

Start with the selected person.

Then show their Care Circle visually:
- family
- caregiver
- visiting carer
- clinician/share destination where appropriate
- pending invitation

Possible card:
- avatar/initial
- name
- relationship/role
- concise permissions
- alert/subscription summary
- expiry state
- last relevant activity

Example:
`Anita · Daughter`
`Can see medicines · record doses`
`Last activity 08:04`

## Visual status

Use icon + label + restrained tint for:
- Active
- Invitation pending
- Expiring
- Access ended
- Needs review

Do not make a giant permissions grid the first screen.

## Person detail

Tap a person to see:
- relationship
- access summary
- what they can see
- what they can change
- alert delivery
- expiry
- recent actions
- manage access

Then detailed permissions can use the matrix.

## Care activity

Create a visually strong timeline:
- dose recorded
- item updated
- permission granted
- invitation accepted
- access revoked
- Visit Pack created/shared

Filter by person/type/date.

## Responsibilities / care coordination

Explore a lightweight visual layer for who is responsible for what where supported:
- medication recording
- appointment preparation
- alerts
- supply/refill checks

Do not invent authority or clinical responsibility.

---

# 13. You V3 — proper settings architecture

You should not show destructive/account-management actions as immediate primary content.

The You home should be clean and structured.

Suggested structure:

## Profile header
- account name/avatar
- signed-in identity
- current household/profile access where useful

## Account Center
Inside:
- email / authentication
- password/recovery
- MFA/security
- sessions/devices
- account deletion

Account deletion belongs here, deep enough that it is intentional but still discoverable.

## Privacy & Data
- consent
- export data
- retention/deletion explanations
- connected sources
- data permissions
- agent activity/transcript controls where appropriate

## Notifications & Reminders
- reminder privacy level
- quiet hours
- alerts
- digest
- delivery preferences

## Accessibility
- text scaling
- motion
- Elder Mode
- voice interaction preferences
- screen-reader relevant settings

## Appearance
- system / light / dark
- visual preferences if supported

## Connections
Future:
- Health Connect
- Apple Health / HealthKit
- wearable/provider connections

## Kynviora Agent
- voice mode
- agent history
- privacy/retention settings
- background jobs/report preferences where appropriate

## Help & Support
- support
- correction/report issue
- app information
- legal/privacy links

The top-level You screen should be a beautifully grouped settings hub, not a long list of raw controls.

---

# 14. Semantic colour / attention language V3

The entire application needs a more deliberate visual attention system.

The goal is to make screens readable at a glance without creating alarm or misleading health judgement.

Separate these concepts:

## Decorative / identity colour
For:
- product/category visual personality
- package-derived tint
- profile/avatar accents

Never use decorative tints as safety meanings.

## Interface colour
For:
- selected tab
- focus
- Talk to Kynviora listening state
- selected filter

Keep a consistent interface hue.

## Semantic state colour
Use restrained tints for:
- informational
- new/changed
- needs input
- attention
- reviewed concern/action
- completed/successful operation
- stale/offline

Every semantic colour must also have:
- icon/shape
- label
- textual meaning

## Change colour
Consider a dedicated visual language for `changed/new since last time` that is distinct from danger.

For example, a cool violet/blue-violet family could indicate `changed/new` if it passes accessibility and does not collide with other semantics.

Do not use red for "new".

## Surface grading

Important cards should not all share identical dark grey surfaces.

Use subtle semantic washes / edge treatments / gradients / elevation differences to guide the eye.

Examples:
- `Needs your input` can have a restrained attention-tinted surface
- `New report ready` can have a change/info tint
- `Agent job running` can have an animated interface tint
- `Reviewed concern` has its own action tone
- ordinary content stays neutral

Keep saturation controlled.

The application should feel alive, not rainbow-coloured.

---

# 15. Motion and micro-interaction

Use subtle motion to reinforce continuity.

Examples:
- Talk bar waveform/listening response
- product tiles smoothly enter selection mode
- Compare tray rises from bottom
- Health chart transitions between ranges
- selected lab result expands into detail
- a changed record animates from previous to current
- agent job moves from running to ready
- Care permission changes animate only after server confirmation

Motion must:
- respect reduced-motion setting
- never be the only carrier of meaning
- never dramatize safety warnings

---

# 16. Today refinements

Keep the V2 Today architecture but make priority clearer.

First viewport should answer:
1. What changed?
2. Does anything need me?
3. Is Kynviora working on something for me?

Suggested order:
- needs input / meaningful change
- ready reports
- agent jobs
- since you last looked
- recent activity

Avoid long explanatory cards.

Use change markers, small timeline elements, compact report tiles, and visually distinct job states.

Agent-generated work should always be attributable:
- requested by user
- started time
- status
- result/report
- what it changed, if anything

---

# 17. Shelf / Considering / Compare — preserve V2, refine

Do not rethink these from scratch.

Preserve:
- image-led product tiles
- My Shelf / Considering
- category grouping
- selection mode
- Compare tray
- saved comparisons
- Safety Lens
- progressive disclosure

Refine:
- stronger real-package imagery
- clearer category sections
- subtle product/category visual tint
- product-level `changed` marker
- formula-change indicator
- better glance-level state treatment
- contextual Talk to Kynviora behavior

Compare should remain infographic-first rather than prose-first.

---

# 18. Product detail refinements

Preserve the V2 detail architecture.

Improve:
- image/product hero
- product-derived decorative tint
- obvious `what changed` block when formulation/batch/record changed
- Health relevance section when verified personal context applies
- Safety/Evidence drill-down
- provenance drawer
- history timeline
- schedule/dose visualization for medicines
- compare action for consumer products

Keep semantic truth separate from decorative product colour.

---

# 19. Personal relevance layer

Health data should make Shelf and Compare smarter.

When Kynviora has verified personal context such as:
- allergy
- sensitivity
- condition
- clinician/user-entered health fact supported by rules

and a product/medicine has confirmed relevant data, the app can show:

`Relevant to your recorded health information`

Then explain:
- which recorded fact
- which product fact
- what rule/evidence connects them
- confidence/provenance
- what remains unknown

The LLM must not invent this relationship.

This layer should be deterministic/reviewed according to Kynviora's existing safety architecture.

---

# 20. Source and provenance everywhere it matters

Every imported or measured health fact should know:
- source
- date/time
- original record/document where applicable
- extraction/import status
- correction/version history

But do not clutter primary screens with provenance paragraphs.

Use:
- compact source chips
- tap-to-open evidence drawers
- source icons
- freshness indicators

Progressive disclosure still applies:
Glance -> Inspect -> Evidence.

---

# 21. Design for future health integrations without pretending they exist

Create future-ready states for:
- Android Health Connect
- Apple Health / HealthKit
- supported wearables
- lab/provider imports
- document uploads

Clearly distinguish:
- connected
- syncing
- stale
- disconnected
- permission removed
- imported once
- manually entered

Do not visually imply a real integration that has not been implemented.

---

# 22. Safety and clinical boundaries remain absolute

Do not introduce:
- health score
- safety score
- diagnosis
- medication recommendation
- "best medicine"
- auto-stop/start medication
- causal interpretation from wearable changes
- all-clear states
- colour-only warnings

For lab/reference data:
- show provider/source reference ranges when available
- distinguish source-provided flags from Kynviora interpretation
- do not label a value medically normal/abnormal unless that is a source fact or an approved deterministic rule allows it

For trends:
- show measurements and changes
- do not claim a medical cause

---

# 23. V3 design deliverables

Preserve V2 artifacts.

Create new V3 artifacts or a clearly versioned V3 branch:

1. `Kynviora V3 Mobile`
2. `Kynviora V3 Design Language`
3. `Kynviora V3 Artboards`

The V3 prototype should especially prove:

## Voice
- persistent Talk bar idle
- listening
- understanding/working
- in-context action
- confirmation
- agent job created
- job ready on Today
- Elder Mode

## Health
- Health overview
- Records hub
- Lab report
- Lab result detail
- latest vs previous lab comparison
- annual checkup comparison
- WHOOP-quality trend detail
- sleep detail
- blood pressure detail
- Health timeline
- connected-source state
- Health relevance shown on a product

## Care
- Care Circle home
- person access detail
- permission editor
- care activity timeline
- invitation pending
- expiring access
- Visit Pack/share entry

## You
- structured You home
- Account Center
- Privacy & Data
- Notifications
- Accessibility
- Connections
- Kynviora Agent settings
- account deletion nested inside Account Center

## Global visual system
- neutral
- new/changed
- informational
- needs input
- attention
- reviewed concern/action
- completed
- stale/offline
- decorative product tint vs semantic state demonstrated side by side

---

# 24. Critical success test

Before polishing, inspect each V3 screen and ask:

### Glance
Can somebody tell what this screen is and what matters in about one second?

### Action
Is the next meaningful action obvious without reading a paragraph?

### Depth
Can deeper information be opened rather than being dumped onto the first surface?

### Truth
Does every visual distinction reflect something Kynviora genuinely knows?

### Change
If something changed, can the user immediately understand what changed and compared with what?

### Source
Can the user inspect where a meaningful health/product fact came from?

### Agent
Can the user operate this screen naturally through Talk to Kynviora without leaving the context?

### Accessibility
Does it remain usable with large text, reduced motion, screen reader, and 48dp+ targets?

If a screen fails these questions, redesign the information architecture rather than adding more cards.

---

# 25. Creative freedom

Think beyond the examples in this brief.

The goal is not to mechanically draw the requested components.

Act as a senior health-product design team and propose stronger:
- data visualizations
- record navigation
- medical-history interactions
- comparison views
- health-domain views
- caregiver representations
- change visualizations
- agent interactions
- settings structures

when they improve comprehension without violating Kynviora's safety/privacy/accessibility rules.

The V3 target is a Kynviora experience that feels alive, intelligent and technically sophisticated while remaining calmer and easier to understand than the current designs.
