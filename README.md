# Kynviora

A family safety layer for medicines and personal-care products.

Kynviora knows what a person actually uses, monitors trusted changes around those exact items,
explains personal relevance with visible uncertainty, and helps take the next safe step.

**This is a rebuild in progress.** The source of truth is `KYNVIORA_PROJECT_SPEC/` (27 documents).
Current implementation state, blockers and next steps are in `docs/autonomy/STATUS.md`.

---

## Quick start

```bash
npm install
npm run verify
```

`verify` chains typecheck, mobile typecheck, lint, format check and the full test suite with
`&&`, so no gate can be silently skipped.

Individual gates:

```bash
npm run typecheck
```

```bash
npm test
```

Run the mobile app (requires an Android SDK and a development build - see `BLK-002`):

```bash
npm --prefix apps/mobile run android
```

---

## What this is not

Two things Kynviora deliberately refuses to do, because they shape almost every design decision
in this repository:

- **It does not produce a universal safety score.** Evidence strength and action urgency are
  separate dimensions with separate vocabularies, and there is no function anywhere that converts
  between them. Several tests assert that none exists.
- **It does not treat an absence of findings as reassurance.** "No matched rule" is never rendered
  as approved, legal or safe, and every absence result carries a coverage statement saying what
  was and was not checked.

## Repository layout

```text
KYNVIORA_PROJECT_SPEC/   Source-of-truth specification (27 documents)
docs/autonomy/           Implementation plan, decisions, research, blockers, status
db/                      SQL migrations and the PGlite test harness
packages/
  domain/                Controlled vocabularies, branded IDs, provenance, untrusted quarantine
  catalog/               GTIN, ingredient normalization, fingerprinting, conflict, capture
  regulatory/            Registry records, Citation Gate, Global Regulatory Lens
  safety/                Deterministic rule engine, schedule computation
  ingestion/             Source retrieval, preservation, change detection
  presentation/          Design tokens, status presentation, safety copy
  fixtures/              Synthetic test data and the end-to-end vertical slice
services/api/            Fastify API boundary
apps/mobile/             Expo SDK 57 client
```

## Architecture in one page

**Dependency direction.** `domain` has zero runtime dependencies and performs no I/O. Everything
flows toward it: `domain <- {catalog, regulatory, safety, ingestion, presentation} <- services`.
The mobile app consumes shared packages from source, so a safety vocabulary cannot drift between
client and server.

**Authorization.** Two non-superuser database roles. `kynviora_app` carries user requests under
full row-level security; `kynviora_service` performs privileged operations with separate
credentials. A route handler's only database access is a connection already bound to the app role
with the caller's identity in a request GUC, so RLS applies to every query a handler can make.
Reaching the service role requires an explicit, named reason.

**Determinism.** Time and randomness are injected. A bare `new Date()` is a lint error in
production code, because assessment replay depends on it. Every assessment stores the exact
version of every input it consumed, and `replayAssessment` recomputes and reports which fields
moved.

**AI boundary.** Models propose; sources and deterministic validation prove; rules and review
decide. Untrusted external content is a distinct type that can only reach a model through a
sanitizer that emits an inert, delimited data block. Extraction agents hold no publish authority,
enforced by the grants they run with rather than by convention.

**The Citation Gate** exists at two layers: a pure function whose decisions are testable and
explainable, and CHECK constraints so a direct database write cannot bypass it.

## Testing

Tests run in-process with no external services:

- **Database and authorization tests** execute against real PostgreSQL 18.3 via PGlite. The
  harness asserts the session is the expected non-superuser role before any authorization
  assertion, because superusers bypass row-level security even under `FORCE ROW LEVEL SECURITY` -
  without that guard the whole suite would pass while testing nothing.
- **The vertical slice** (`packages/fixtures/src/verticalSlice.test.ts`) walks the full loop:
  profile, capture, observation, formulation resolution, normalization, regulatory lookup,
  assessment, result.

All test data is synthetic. No real patient or family health information appears anywhere in this
repository, and CI enforces that fixtures stay labelled as such.

## Honest limitations

These are tracked in full in `docs/autonomy/BLOCKERS.md`. The three that matter most to anyone
reading the code:

1. **No regulatory record is published.** Every shipped regulatory fixture is rejected by the
   Citation Gate, because the research behind them came from search-result summaries rather than
   retrieved official documents. A test asserts this. Promoting them would require a retained
   official snapshot with a checksum and a named qualified reviewer.
2. **No safety rule is approved.** The reviewer workflow and approval requirements are
   implemented; no qualified clinical or regulatory reviewer was available. Test helpers that
   simulate approval use the reviewer id `synthetic-test-reviewer` so they can never be mistaken
   for a real approval.
3. **Nothing has run on a device.** The mobile app typechecks against the real Expo SDK 57
   toolchain, but encryption at rest is written and configured rather than demonstrated.

## Licence

UNLICENSED. Not for distribution.

These documents and this code define product and engineering intent. They are not legal advice,
medical advice, regulatory approval, clinical validation, or a claim that Kynviora falls outside
any medical-device or health-software regulation.
