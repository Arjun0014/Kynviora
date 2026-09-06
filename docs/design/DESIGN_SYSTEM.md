# Kynviora - Design System

Status: product/design source of truth for the app's visual and interaction layer.
Owner of the values: `packages/presentation/src/tokens.ts`. **On conflict, the code wins** - this
document explains the decisions, it does not hold them.

Spec precedence is unchanged. `18_ACCESSIBILITY_AND_CONTENT_DESIGN.md`,
`06_USER_JOURNEYS_AND_INFORMATION_ARCHITECTURE.md` and
`02_DIFFERENTIATION_AND_PRODUCT_PRINCIPLES.md` are binding; nothing here relaxes them.

---

## 1. What this is for

Kynviora is a family safety layer for medicines and personal-care products. Its primary user is
often an older adult, and the thing on the screen is frequently the most consequential sentence
they will read that day.

The quality bar is a premium consumer health product. The **method** is borrowed from that class
of product; the **content rules** are Kynviora's own and they win every time the two disagree.

| Borrowed                                       | Not borrowed                                |
| ---------------------------------------------- | ------------------------------------------- |
| Hierarchy carried by type, not by decoration   | A single score that summarises everything   |
| Dark surfaces built as a real elevation ladder | Ranking what needs attention                |
| Colour used sparingly and meaning something    | Red as the way to say "important"           |
| Data as the hero of a card                     | Counting things on a badge                  |
| Motion for continuity, not for delight         | Animating a safety statement into view      |
| Progressive disclosure of detail               | Hiding the limitation behind the disclosure |

The five rules below come out of `02` and `18` and are the ones a designer will most want to
break:

1. **No universal safe/unsafe score, and nothing that reads like one.** Not a colour, not a ring,
   not a number, not a sort order.
2. **Evidence level and action urgency are separate dimensions** and are never merged into one
   visual.
3. **Absence of a matched rule is never approval.** An item with nothing known about it still
   gets a line, because leaving the row out is the quietest way to render an absence as safety.
4. **Meaning is never carried by colour alone.** Every tone has a label and a shape beside it.
5. **One primary action on a high-impact screen.** If two things look equally pressable on a
   safety screen, one of them is wrong.

---

## 2. Information architecture

`06` fixes five primary destinations. This is not a layout choice and cannot be renegotiated to
free a slot.

| Destination | The question it answers                                           | Never                           |
| ----------- | ----------------------------------------------------------------- | ------------------------------- |
| **Today**   | What is worth my attention today, and what can I prepare?         | A due-medicine list (see below) |
| **Shelf**   | What do we have, and how well does Kynviora know each thing?      | A ranking of items by risk      |
| **Safety**  | Is there a reviewed, relevant concern, and what is the next step? | A clearance, a count, a score   |
| **Care**    | Who is in this household, who may see what, what can I share?     | A silent-owner caregiver view   |
| **You**     | Account, privacy, consent, accessibility, notifications, export   | A place safety copy also lives  |

Adding an item and scanning are **actions available from Today and Shelf**, not a sixth
destination.

**Dose reminders are deliberately not on Today.** The reminder that matters arrives on the lock
screen whether or not the app is open; a second list inside the app disagrees with it the moment
one is stale, and the one somebody acts on at 8am is the notification. Setting the times and
recording what happened both live on the medicine's own row on the Shelf.

### Depth

Three levels, and the third is always optional:

```
destination  ->  a card, complete enough to act on
                 ->  a detail screen, which is where the evidence and the limitations are
                     ->  a source, a receipt, a version - reached deliberately, never automatically
```

A person must be able to finish the common journeys without reaching level three. A person must
never be able to reach a conclusion at level one that level three would contradict.

---

## 3. Typography

The scale is in `FONT_SIZE`; the **roles** are in `TYPE_ROLE`, and a screen uses a role rather
than a size. A role carries weight and leading with its size, because those three together are
what makes a heading read as a heading - and separating them is how a "title" ends up bold in one
file and regular in the next.

| Role        | Size | Weight | Leading | Used for                                              |
| ----------- | ---- | ------ | ------- | ----------------------------------------------------- |
| `display`   | 34   | 700    | tight   | One per screen at most: the thing the screen is about |
| `heading`   | 28   | 700    | tight   | The screen's own name, announced as a header          |
| `title`     | 22   | 600    | tight   | A card's subject - a medicine, a person               |
| `bodyLarge` | 19   | 400    | relaxed | A sentence that must be read rather than scanned      |
| `body`      | 17   | 400    | normal  | Everything a person reads                             |
| `label`     | 17   | 600    | tight   | A control's own text; a field's name                  |
| `caption`   | 14   | 400    | relaxed | A qualification, a date, a limitation                 |
| `overline`  | 14   | 600    | tight   | A short section marker, tracked out                   |

**Body is 17sp, not 14-16.** `01` and `18` name older adults as a primary audience, and a larger
default reduces how often somebody has to reach for system scaling to read safety content at all.

**A label is body-sized.** A control's text and a sentence are the same size on purpose: a control
that shrank its own name to look like a control is the wrong trade for this audience.

**Scaling.** Every role goes through `typeStyle(role, systemFontScale)`, which applies the system
scale, clamps at `MAX_SUPPORTED_FONT_SCALE` (2.0) and scales letter-spacing with the text. It
never scales _below_ 1: a system set smaller must not shrink a sentence about a medicine.

**Clamping is a graceful degradation, not a refusal.** Past 2x the layouts have not been measured,
and `18` makes a clipped primary action in a critical journey a release gate. Rendering a little
smaller than requested is better than clipping. The one place the app departs from the global
scale is the tab bar, and DEC-103 says why.

### Copy

Safety copy follows `18`'s eight-part structure and the forbidden-claim list is enforced by test
in `packages/presentation/src/copy.ts`. Design does not get to shorten a sentence past its
limitation.

---

## 4. Spacing and shape

**Spacing** is a 4dp base with a 2x step at the top: `xxs 2, xs 4, sm 8, md 12, lg 16, xl 24,
xxl 32, xxxl 48`. Named, never numeric, so a layout cannot quietly drift to an arbitrary value.

Vertical rhythm is generous and horizontal rhythm is tight. A screen is a column of cards with
`lg` between them and `lg` around the whole; inside a card, `sm` between the lines of one idea and
`md` between two ideas.

**Radius** is a ladder - `sm 8, md 12, lg 16, xl 24, pill 999` - because a radius is how a surface
says how big it is. A chip and a full-bleed sheet drawn at the same radius read as the same kind of
object. `pill` is for a control whose shape is its affordance and is never applied to a container.

**Touch targets** are at least 48dp, enforced by `minHeight`/`minWidth` rather than a fixed height
so the target grows with the font scale instead of clipping its own label. This is measured on a
device by `npm run verify:device:a11y`, not asserted in a style.

---

## 5. Surfaces, elevation and colour

### The elevation ladder

Four levels, in both themes:

| Level     | What it is                                      |
| --------- | ----------------------------------------------- |
| `sunken`  | An inset well: a text field, a read-only block  |
| `canvas`  | The ground a screen is painted on               |
| `surface` | A card                                          |
| `raised`  | A sheet or dialog - one step nearer than a card |

**On light, a sheet and a card are both white and a shadow separates them.** That is what a shadow
is for, and it is legible on a pale ground.

**On dark, a shadow is invisible, so the ladder is the colours themselves.** `canvas`, `surface`
and `raised` are three different near-blacks rather than one lifted three times. A test asserts
that the dark ladder is four distinct colours and that every adjacent pair in _either_ theme
differs in background or in border.

### Semantic tones

Seven pairs, unchanged in name and meaning since the first build, because
`packages/presentation/src/status.ts` and `screenState.ts` map a state onto one of them - a tone
renamed here would be a safety statement rendered in the wrong colour, decided in a file that has
never heard of safety.

| Tone            | Says                                                  |
| --------------- | ----------------------------------------------------- |
| `surface`       | Ordinary content                                      |
| `surfaceMuted`  | Secondary content, a quiet container                  |
| `neutral`       | A state with no valence                               |
| `informational` | A fact, a limitation, a coverage statement            |
| `attention`     | Something to look at, on the person's own schedule    |
| `action`        | A reviewed concern with a bounded next step           |
| `positive`      | A thing that completed - never "this product is safe" |

They are **deliberately desaturated**. `02` and `18` require a calm product that does not optimise
for alarm, and a saturated red on a safety screen does exactly that. `positive` is the most
dangerous of the seven and is used for _completion_, never for a judgement about a product.

Every pair meets 4.5:1 in **both** themes, asserted by test over the real token values.

### The accent, and why it has no hue

The primary action is **contrast, not colour**: near-black on light, near-white on dark.

`18` reserves hue for state. An accent that happened to be green or amber would be a fourth thing
on a screen already using green and amber to say something about a medicine, and the person would
have to learn which greens mean something. So every hue on a Kynviora screen means something, and
the one control that has to be unmistakable is unmistakable by contrast.

### The one interface hue

`selection` - a teal - is the only colour about the interface rather than about a product. It
carries the focus ring, the selected tab, the chosen filter, and the listening state in Voice
Mode. It is deliberately not `informational`: "this is the tab you are on" and "here is a fact
about your medicine" must not be the same colour, or the second stops being noticeable.

`line.focus` meets 3:1 against both grounds in both themes (WCAG 1.4.11), and a focus ring is
never the only indication of anything.

### Light and dark policy

**Both themes are first class, and the default is the system's.** Three states -
`FOLLOW_SYSTEM` (default), `LIGHT`, `DARK` - offered under You -> Accessibility. `FOLLOW_SYSTEM`
is a genuinely different state from having chosen whichever theme the system currently is:
somebody following the system in September is still following it in October when their phone
switches itself at dusk.

**The dark ground is `#0E1116`, not black**, for two reasons that point the same way. An elevation
ladder needs somewhere below the first step, and on black a card can only ever be lighter, so
"further away" stops being expressible. And pure white on pure black is the highest-glare pairing
a screen can produce - halation, which is worse with the lens changes and astigmatism that are
ordinary after sixty, and this app's primary audience is older adults.

The seven tone pairs are inverted in **role**, not in value: `attention` is still amber and
`action` is still red, because somebody who has learned one theme has learned both.

---

## 6. Iconography

Icons stand in for a real set and are chosen so each is distinguishable **by shape**, which is
what makes a status readable in greyscale and to somebody who cannot distinguish the tones.

Rules:

- An icon never appears without its label. `18` forbids meaning carried by an icon alone.
- An icon that duplicates the label is hidden from screen readers, so nothing announces a
  meaningless symbol.
- The tab bar carries an icon **and** a text label, always. An icon-only tab bar is unusable for
  the primary audience.
- No icon is red-only, and no icon changes meaning with its colour.

---

## 7. Components

Every component below lives in `apps/mobile/src/components/` and takes a **presentation** rather
than a colour and a string, so a caller cannot construct one that carries meaning by colour alone.

| Component       | Responsibility                                                              |
| --------------- | --------------------------------------------------------------------------- |
| `Screen`        | The frame: heading, introduction, safe area, pull-to-refresh                |
| `Card`          | One idea, on one surface, with an optional tone                             |
| `PrimaryButton` | An action, at 48dp minimum, growing with the font scale                     |
| `StatusChip`    | One status, from a `StatusPresentation` - icon, label, optional description |
| `ScreenState`   | Loading / empty / offline / error / authorization lost, announced politely  |
| `FieldRow`      | A labelled value, with an explicit empty state rather than a blank          |
| `SectionHeader` | An `overline` and an optional one-line explanation                          |

### Cards

A card is one idea. If a card needs a scrollbar or a second heading, it is two cards.

A card carries, in this order: its subject (`title`), the statuses that qualify the subject, the
lines that say what is outstanding, and then its actions. The actions are last because a person
reads the subject before deciding what to do about it.

**A card never aggregates its own statuses into one badge.** Three chips - identity, formulation,
batch - are three separate statements, and a single "verified" badge would be the aggregate trust
score `02` forbids with the number left off.

### Charts and data display

Kynviora has no dashboards and will not grow one. What it has is: a dose history, a schedule, and
an evidence timeline. The rules for all three:

- **A number is a `display` role with a `caption` label beneath it**, never a number floating in a
  ring.
- **A history is a list before it is a chart.** The list is the record; a chart is a summary of
  it, and a summary that cannot be read back to a clinician is not worth the pixels.
- **No trend line implies a cause.** A run of taken doses is a record of what was recorded, and
  the caption says so.
- **No axis starts anywhere but zero**, and no chart is drawn without its units.
- Colour in a chart follows the same rule as everywhere: a series is distinguished by position and
  label first, and by tone second.

---

## 8. Motion and haptics

**Motion is for continuity - saying where a thing came from - and never for delight.** Nothing in
this app animates a safety statement into view: a sentence about a medicine is on screen or it is
not.

Durations: `instant 0, quick 120, standard 200, deliberate 320`. Every animation goes through
`motionDuration(token, reduceMotion)`, so honouring the system's reduce-motion setting is one
decision rather than forty. It collapses to **zero**, not to something short: `18` treats motion
sensitivity as an accessibility setting rather than a preference, and a reduced animation that
still moves still triggers.

**Haptics are named by intent, not by pattern**: `selection`, `confirm`, `warn`, `failure`. A
component asking for `confirm` does not know which motor pattern that is on which platform, which
is `12`'s adapter rule applied to touch.

There is no haptic that fires as the _report_ of anything. A buzz that is the only report of a
refusal is a report nobody who cannot feel it receives - `18`'s single-channel rule, applied to
touch. Every haptic accompanies a sentence; none of them is the sentence.

---

## 9. Screen states

`06` requires every critical route to define: loading, empty, success, partial/insufficient data,
offline, permission denied, recoverable error, authorization lost, stale data, and
corrected/superseded where applicable.

Design rules for the ones that are usually got wrong:

- **Empty is not failure.** An empty shelf and an empty safety inbox say what would be here and
  what to do, and neither implies anything about safety.
- **Partial is visible as partial.** A silently shorter list is the failure the state exists to
  prevent.
- **Offline shows the content and says when it was last true.** `03` group J: medicines,
  schedules, the shelf and synced alerts are readable with no signal. Local content arrives as
  `STALE`, never as `READY`.
- **Authorization lost is not the user's mistake** and is worded as such.
- **Permission denied is a supported state**, not an error screen. `18` requires it.
- A refused write says what the server said, or the state's own copy - never a guess. `14` keeps
  the reason out of the authorization responses on purpose.

---

## 10. Accessibility for older adults

This is a product requirement, not a theme (`18`). The whole list is in the spec; what follows is
what the design system is responsible for.

- **48dp minimum** on every control, growing with the font scale rather than clipping.
- **System font scaling to 2x** without clipping critical content or actions. Measured on a device
  at scale 1 and 2 by `npm run verify:device:a11y`, over every destination and every sheet.
- **Never colour alone.** Every tone has a label and a shape.
- **One primary action** on a high-impact safety screen.
- **No swipe-only or long-press-only core action.** Everything reachable by a plain tap.
- **A control is reachable, not merely present.** A save button below the fold with no way to
  scroll to it is a control nobody can use; a control seen only as a sliver counts as unreachable.
- **Names, not positions.** Every control has a name a screen reader announces; nothing is
  identified only by where it sits.
- **Announcements are polite**, not assertive: a status change must not interrupt what somebody is
  already doing.
- **Familiar words first**, with the precise term available at the next level of disclosure.
- **Permission denial is a supported state** with a way forward that does not require the
  permission.

### Progressive disclosure, and its one hard rule

Detail is layered - a card, then a detail screen, then the source. **A limitation never moves
down a layer.** If a fact is qualified, the qualification travels with it at every level. The
common failure is a summary card that states a conclusion whose caveat lives two taps away.

---

## 11. Screen hierarchy per destination

### Today

```
heading      Today
context      the profile this is about
cards        review tasks - what would make what Kynviora can say more exact
actions      prepare a summary for an appointment; check a list against my shelf
footer       a partial-list note, where the client dropped a row it did not recognise
```

No count badge, no ranking, no "needs attention" header. A review task has no urgency in the
database, none in the API payload and none in the presentation tones, and a badge here would
reintroduce one at the only layer where nobody would notice.

### Shelf

```
heading      Shelf
intro        what this list is, and what the statuses mean
actions      add a medicine; add a personal-care product
filters      not yet confirmed; not yet looked at  (narrow, never rank)
cards        one per item: name, brand, three status chips, what is outstanding, actions
footer       "this is the first page" where there is more
```

### Item detail

```
heading      the item's name
statuses     identity / formulation / batch, as three separate statements
fields       what is recorded, and explicitly what is not
limitations  what Kynviora cannot say about this item and why
actions      edit; record a dose; set the times; delete
```

### Safety

```
heading      Safety
coverage     what is and is not being watched, stated up front
cards        one line per item, always - an absence of a matched rule is never approval
filters      narrow, never rank; a filter matching nothing still says so
```

### Care

```
heading      Care
people       profiles in this household, and who is being looked at
access       caregivers, what each may do, and how to take it back
sharing      Visit Pack
history      an audit somebody can actually read
```

### You

```
heading      You
account      who is signed in
accessibility appearance, text size guidance, motion
privacy      consent, what is kept, what leaves
notifications what arrives, when, and how much it says
data         export, deletion
```

---

## 12. Responsive and cross-platform

The app targets Android and iOS from one codebase. Android is the currently verified platform;
**no claim is made about iOS rendering, because nothing here has been run on it.**

Rules that keep that honest:

- **Layout is intrinsic, not measured.** Sizes come from content and from the font scale, so a
  layout that works on a 412dp phone works on a 320dp one and on a 700dp foldable without a
  breakpoint. There is no width breakpoint in this app and none is needed at its current density.
- **Safe areas are handled by the frame**, once, in `Screen`. A per-screen inset is how a notch
  eats a heading on exactly one device.
- **Nothing platform-specific in a screen.** Camera, notifications, secure storage, haptics and
  the share sheet all sit behind adapters (`12`). A screen that branched on `Platform.OS` would be
  two designs maintained as one file.
- **Elevation states its distance once** - `ELEVATION` carries both an Android `elevation` and the
  shadow iOS draws for the same step.
- **The tab bar is five destinations on both platforms.** Not a Material bottom bar on one and a
  UITabBar on the other with different contents.

---

## 13. What is deliberately not in this system

- **A dashboard.** Nothing here summarises a person's health into a view.
- **A score, a ring, a gauge, or a grade.** For any subject, at any scope.
- **Streaks, badges, or anything that rewards compliance.** Recording a dose is a record, not an
  achievement, and a missed one is not a failure to be shamed for.
- **A colour that means "fine".** `positive` marks completion of a step, never a judgement about a
  product.
- **Red as the way to say important.** `18` forbids red as the only explanation of urgency.
- **A count of what needs attention.** `02`.

---

## 14. Where the values live

| Concern                                    | File                                       |
| ------------------------------------------ | ------------------------------------------ |
| Every token, both themes, contrast helpers | `packages/presentation/src/tokens.ts`      |
| Status -> tone, icon, label                | `packages/presentation/src/status.ts`      |
| Screen state -> tone, copy, retry          | `packages/presentation/src/screenState.ts` |
| Forbidden claims, safety copy structure    | `packages/presentation/src/copy.ts`        |
| Theme resolution, reduce-motion            | `apps/mobile/src/theme/ThemeProvider.tsx`  |
| Haptics behind an adapter                  | `apps/mobile/src/platform/haptics.ts`      |
| Shared components                          | `apps/mobile/src/components/`              |

Assertions that keep this document from becoming fiction:

```bash
npm test -- packages/presentation
npm run verify:device:a11y
```
