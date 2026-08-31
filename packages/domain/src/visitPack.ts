/**
 * Visit Pack: a controlled, user-selected handoff to a health professional.
 *
 * Spec references: `04` Phase 8.4, `06` Journey 8, `03` group I, `16` (Export: intentional user
 * action, show what will be included, re-authenticate, expire temporary export objects, audit
 * without duplicating sensitive content), `14` (step-up for exports), `07` (VisitPack is a
 * "generated selection/version snapshot"), `18` (limitation always stated).
 *
 * THE TWO EXIT CRITERIA, ENCODED RATHER THAN PROMISED
 *
 *  1. **Export never happens automatically.** There is no code path that produces a pack from a
 *     profile ID alone. {@link evaluateGeneration} requires an explicit list of selected entity
 *     IDs and refuses an empty one, so "export everything" is not expressible - a caller cannot
 *     omit the selection and get a sensible default, because there is no default.
 *
 *  2. **A user can review exactly what will be shared.** The request carries the digest of the
 *     content the user reviewed. Generation recomputes that digest from live data and refuses if
 *     it differs. A caregiver editing a medicine between the review screen and the Generate
 *     button therefore cannot cause a pack to contain something nobody read - the export fails
 *     and the user reviews again.
 *
 * WHAT A PACK IS NOT
 * `03` group I: "The pack is a communication aid, not a clinician-authenticated medical record."
 * {@link VisitPack} carries a required per-entry caveat and a required pack-level limitation, so
 * a pack that presents unverified user-entered data as though it were a clinical record cannot
 * be constructed.
 */

import type { OwnedItemId, ProfileId, UserId, VisitPackId } from './ids.js';
import type { Instant } from './ports.js';
import type { DomainError, Result } from './result.js';
import { failure, ok } from './result.js';
import type { ItemVerification, ProvenanceKind } from './vocabulary.js';

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * The sections a pack may contain (`03` group I, `04` Phase 8.4).
 *
 * A closed set, because a section a user cannot see on the review screen is a section they
 * cannot consent to sharing.
 */
export const VISIT_PACK_SECTIONS = [
  'CURRENT_MEDICINES',
  'PERSONAL_CARE_ITEMS',
  'ALLERGIES_AND_SENSITIVITIES',
  'UNRESOLVED_SAFETY_ITEMS',
  'RECENT_ITEM_CHANGES',
  'ADHERENCE_AND_REFILL',
  'QUESTIONS_AND_NOTES',
] as const;
export type VisitPackSection = (typeof VISIT_PACK_SECTIONS)[number];

/** Kinds of record a pack entry can be drawn from. */
export const VISIT_PACK_ENTITY_KINDS = [
  'owned_item',
  'allergy_record',
  'alert_publication',
  'refill_estimate',
  'user_note',
] as const;
export type VisitPackEntityKind = (typeof VISIT_PACK_ENTITY_KINDS)[number];

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/**
 * One candidate line-group in a pack.
 *
 * `caveat` is required, not optional. `18` requires the limitation to be stated, and an entry
 * whose provenance is a person typing a name into a phone must not sit on a printed page beside
 * a verified record with nothing distinguishing them.
 */
export interface VisitPackEntry {
  readonly section: VisitPackSection;
  readonly entityKind: VisitPackEntityKind;
  /** Stable ID of the underlying record. `user_note` entries use a synthetic index. */
  readonly entityId: string;
  /** Record version at selection time - the "version snapshot" `07` describes. */
  readonly version: number;
  /** The exact text this entry contributes. Order is meaningful and is part of the digest. */
  readonly lines: readonly string[];
  /** What a reader must not assume about this entry. */
  readonly caveat: string;
}

/**
 * The caveat for an item, derived from how its identity was established.
 *
 * Written as what the reader should *not* assume, because a clinician reading a printed list has
 * no other signal that a line was typed from memory rather than read off a package.
 */
export function itemCaveat(verification: ItemVerification): string {
  switch (verification) {
    case 'CONFIRMED':
      return 'Checked against the package by the person who entered it.';
    case 'PROBABLE':
      return 'Likely correct but not confirmed against the package.';
    case 'PARTIAL':
      return 'Only part of this was confirmed against the package.';
    case 'CONFLICTING':
      return 'Sources disagree about this item. Treat it as unconfirmed.';
    case 'UNVERIFIED':
      return 'Entered by hand and not checked against the package.';
  }
}

/**
 * The caveat for a profile fact, derived from its provenance.
 *
 * Every provenance kind is listed rather than collapsed into a default. The lint rule requires
 * it, and the rule is right here: adding a provenance kind is exactly the moment someone has to
 * decide what a clinician reading a printed page should be told about it. A default would let a
 * new kind inherit "reported by the person" silently, which for a machine-extracted fact would
 * be false.
 */
export function factCaveat(provenance: ProvenanceKind): string {
  switch (provenance) {
    case 'REVIEWER_CONFIRMED':
      return 'Reviewed by a Kynviora reviewer. Not a clinical diagnosis.';
    case 'IMPORTED':
      return 'Imported from another system and not checked here.';
    case 'CAREGIVER_ENTERED':
      return 'Entered by a caregiver, not by the person themselves.';
    case 'USER_CONFIRMED_FROM_PACKAGE':
      return 'Confirmed by the person against the package.';
    case 'PACKAGE_OCR':
    case 'PACKAGE_VISION_MODEL':
      // Unconfirmed machine provenance. It must never read as something a person stated, and it
      // must never read as verified - the whole point of UNCONFIRMED_MACHINE_PROVENANCE.
      return 'Read automatically from a photo and not confirmed by anyone.';
    case 'BARCODE_DECODE':
      return 'Taken from a scanned barcode. It identifies a pack, not a formula.';
    case 'DETERMINISTIC_PARSER':
      return 'Parsed from recorded text without human confirmation.';
    case 'APPROVED_PROVIDER':
      return 'Supplied by a data provider and not checked against the physical product.';
    case 'MANUFACTURER_EVIDENCE':
      return 'Stated by the manufacturer.';
    case 'OFFICIAL_SOURCE':
      return 'Taken from an official source. Not a statement about this person.';
    case 'USER_REPORTED':
      return 'Reported by the person or their caregiver. Not clinically confirmed.';
  }
}

// ---------------------------------------------------------------------------
// Canonical form and digest
// ---------------------------------------------------------------------------

/**
 * Hashing port.
 *
 * The domain performs no I/O and carries no dependencies (DEC-002), and a hash implementation
 * is neither portable nor pure enough to belong here - so it is injected, as the clock and the
 * ID generator are.
 */
export interface ContentDigest {
  /** Stable hash of a canonical string. */
  of(canonical: string): string;
}

/**
 * Canonical serialization of a selection.
 *
 * Deterministic and total: entries are sorted by section order then entity ID, every field that
 * reaches the page is included, and field separators are characters that cannot occur in the
 * content. Two selections producing the same string genuinely render the same pack, which is
 * what makes the digest comparison in {@link evaluateGeneration} mean something.
 */
export function canonicalizeSelection(entries: readonly VisitPackEntry[]): string {
  const sectionOrder = new Map(VISIT_PACK_SECTIONS.map((s, i) => [s, i]));
  const sorted = [...entries].sort((a, b) => {
    const bySection = (sectionOrder.get(a.section) ?? 0) - (sectionOrder.get(b.section) ?? 0);
    if (bySection !== 0) return bySection;
    return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
  });

  // U+001F (unit separator) and U+001E (record separator) cannot appear in content that has
  // been through the untrusted-input sanitiser, so neither can be forged into a field
  // boundary. Written as escapes, never as literals: a raw control character in a source
  // file has corrupted this repository before (STATUS.md, trap 7).
  const FIELD = '\u001F';
  const RECORD = '\u001E';

  return sorted
    .map((e) =>
      [e.section, e.entityKind, e.entityId, String(e.version), ...e.lines, e.caveat].join(FIELD),
    )
    .join(RECORD);
}

export function digestSelection(entries: readonly VisitPackEntry[], digest: ContentDigest): string {
  return digest.of(canonicalizeSelection(entries));
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

/**
 * How long a generated pack stays retrievable.
 *
 * `16` requires temporary export objects to expire. 72 hours covers "generated the night before
 * an appointment" without leaving a shareable view of someone's medicines alive indefinitely.
 * An engineering default, not an approved retention policy (DEV-009).
 */
export const DEFAULT_VISIT_PACK_TTL_HOURS = 72;
export const MAX_VISIT_PACK_TTL_HOURS = 24 * 14;
const MS_PER_HOUR = 60 * 60 * 1000;

export function visitPackExpiryFor(now: Instant, ttlHours: number): Result<Instant, DomainError> {
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > MAX_VISIT_PACK_TTL_HOURS) {
    return failure('VALIDATION_FAILED', 'Visit Pack lifetime out of range.', {
      reason_code: 'visit_pack_ttl_range',
      max_hours: MAX_VISIT_PACK_TTL_HOURS,
    });
  }
  return ok(new Date(Date.parse(now) + ttlHours * MS_PER_HOUR).toISOString() as Instant);
}

/** Whether a pack may still be opened. Evaluated against the clock, never a stored flag. */
export function isVisitPackRetrievable(
  pack: { readonly expiresAt: Instant; readonly revokedAt: Instant | null },
  now: Instant,
): boolean {
  if (pack.revokedAt !== null) return false;
  return Date.parse(pack.expiresAt) > Date.parse(now);
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** What the user chose and confirmed on the review screen. */
export interface GenerationRequest {
  readonly profileId: ProfileId;
  readonly requestedByUserId: UserId;
  /**
   * The exact records the user ticked.
   *
   * No "include everything" flag exists. `04` Phase 8.4 requires that export never happens
   * automatically, and the cheapest way to guarantee that is to make an implicit selection
   * inexpressible.
   */
  readonly selectedEntityIds: readonly string[];
  /** Digest of the content shown on the review screen. */
  readonly reviewedDigest: string;
  readonly reviewedAt: Instant;
  /** Free-text questions the user wants to raise at the visit. Part of the reviewed content. */
  readonly notes: readonly string[];
  readonly ttlHours: number;
}

/** Everything needed to decide, resolved by the caller from live data. */
export interface GenerationContext {
  readonly request: GenerationRequest;
  /** Every entry the user could have selected, built from records they may actually see. */
  readonly available: readonly VisitPackEntry[];
  /** Whether this session completed step-up recently (`14`). */
  readonly stepUpFresh: boolean;
  readonly now: Instant;
  readonly digest: ContentDigest;
}

export interface VisitPackPlan {
  readonly profileId: ProfileId;
  readonly entries: readonly VisitPackEntry[];
  readonly notes: readonly string[];
  readonly contentDigest: string;
  readonly generatedAt: Instant;
  readonly expiresAt: Instant;
  /** Section counts, for the audit record. Counts only - never content. */
  readonly sectionCounts: Readonly<Record<string, number>>;
}

/** Maximum entries in one pack. A pack nobody can read is not a communication aid. */
export const MAX_VISIT_PACK_ENTRIES = 200;

/**
 * Decide whether a Visit Pack may be generated, and with exactly what content.
 *
 * The order of the checks is deliberate. Step-up comes first because it is the cheapest refusal
 * and `14` treats an export without re-authentication as the failure, whatever else is wrong
 * with the request. The digest comparison comes last, because it is only meaningful once the
 * selection has been shown to be well-formed.
 */
export function evaluateGeneration(context: GenerationContext): Result<VisitPackPlan, DomainError> {
  const { request, available, stepUpFresh, now, digest } = context;

  if (!stepUpFresh) {
    return failure('STEP_UP_REQUIRED', 'Confirm your identity before creating an export.');
  }

  if (request.selectedEntityIds.length === 0 && request.notes.length === 0) {
    // An empty pack is not a useful handoff, and accepting one would mean a caller could reach
    // the export path without having chosen anything.
    return failure('VALIDATION_FAILED', 'Choose what to include before creating the pack.', {
      reason_code: 'empty_selection',
    });
  }

  if (request.selectedEntityIds.length > MAX_VISIT_PACK_ENTRIES) {
    return failure('VALIDATION_FAILED', 'Too many items for one pack.', {
      reason_code: 'selection_too_large',
      max_entries: MAX_VISIT_PACK_ENTRIES,
    });
  }

  const byId = new Map(available.map((entry) => [entry.entityId, entry]));
  const selected: VisitPackEntry[] = [];
  for (const id of request.selectedEntityIds) {
    const entry = byId.get(id);
    if (!entry) {
      // Either the record vanished between review and generation, or the client sent an ID the
      // user cannot reach. Both are refused, and neither response says which.
      return failure('VALIDATION_FAILED', 'Something in this selection is no longer available.', {
        reason_code: 'unknown_selection',
      });
    }
    if (selected.some((e) => e.entityId === id)) {
      return failure('VALIDATION_FAILED', 'The same item was selected twice.', {
        reason_code: 'duplicate_selection',
      });
    }
    selected.push(entry);
  }

  if (Date.parse(request.reviewedAt) > Date.parse(now)) {
    return failure('VALIDATION_FAILED', 'Review time is in the future.', {
      reason_code: 'review_time_invalid',
    });
  }

  const noteEntries = request.notes.map((line, index): VisitPackEntry => ({
    section: 'QUESTIONS_AND_NOTES',
    entityKind: 'user_note',
    // Padded so the canonical sort is by position rather than lexicographic on "10" vs "9".
    entityId: `note:${String(index).padStart(4, '0')}`,
    version: 1,
    lines: [line],
    caveat: 'Written by the person or their caregiver.',
  }));

  const entries = [...selected, ...noteEntries];
  const contentDigest = digestSelection(entries, digest);

  if (contentDigest !== request.reviewedDigest) {
    // The exit criterion. Something changed between the review screen and this request, so the
    // pack would contain content nobody read.
    return failure(
      'EXPORT_CONTENT_CHANGED',
      'This information changed since you reviewed it. Check it again before sharing.',
      { reason_code: 'digest_mismatch' },
    );
  }

  const expiry = visitPackExpiryFor(now, request.ttlHours);
  if (!expiry.ok) return expiry;

  const sectionCounts: Record<string, number> = {};
  for (const section of VISIT_PACK_SECTIONS) sectionCounts[section] = 0;
  for (const entry of entries) {
    sectionCounts[entry.section] = (sectionCounts[entry.section] ?? 0) + 1;
  }

  return ok({
    profileId: request.profileId,
    entries,
    notes: request.notes,
    contentDigest,
    generatedAt: now,
    expiresAt: expiry.value,
    sectionCounts,
  });
}

// ---------------------------------------------------------------------------
// Rendering a stored pack
// ---------------------------------------------------------------------------

/**
 * A pack as retrieved.
 *
 * `limitation` is a required field for the same reason `SafetyMessage` has one: a pack that
 * omits what it is not is exactly the over-confident artefact `03` group I warns about.
 */
export interface VisitPack {
  readonly id: VisitPackId;
  readonly profileId: ProfileId;
  readonly generatedAt: Instant;
  readonly expiresAt: Instant;
  readonly entries: readonly VisitPackEntry[];
  readonly limitation: string;
  /**
   * Whether the live records still match what was generated.
   *
   * A pack is a snapshot of a *selection and versions* (`07`), not a copy of the content
   * (DEC-022). Re-reading the records is what avoids storing a second copy of someone's
   * medicines, and this flag is the honest consequence: if the underlying data has moved on, the
   * reader is told rather than shown something silently different from what was generated.
   */
  readonly matchesGeneratedContent: boolean;
}

/** The pack-level limitation. Fixed text, because it must never be weakened per-pack. */
export const VISIT_PACK_LIMITATION =
  'This summary was prepared by a person using Kynviora. It is not a medical record, and no ' +
  'health professional has checked it.';

export function renderVisitPack(input: {
  readonly id: VisitPackId;
  readonly profileId: ProfileId;
  readonly generatedAt: Instant;
  readonly expiresAt: Instant;
  readonly storedDigest: string;
  readonly entries: readonly VisitPackEntry[];
  readonly digest: ContentDigest;
}): VisitPack {
  return {
    id: input.id,
    profileId: input.profileId,
    generatedAt: input.generatedAt,
    expiresAt: input.expiresAt,
    entries: input.entries,
    limitation: VISIT_PACK_LIMITATION,
    matchesGeneratedContent: digestSelection(input.entries, input.digest) === input.storedDigest,
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const VISIT_PACK_AUDIT_ACTIONS = [
  'visitpack.generated',
  'visitpack.viewed',
  'visitpack.revoked',
] as const;
export type VisitPackAuditAction = (typeof VISIT_PACK_AUDIT_ACTIONS)[number];

/**
 * Audit detail for an export.
 *
 * `16`: "create an audit event without duplicating sensitive content into logs". So: how many
 * entries, in which sections, and whether notes were attached - never a medicine name, never a
 * note, never the digest of content that could be checked against a guess.
 */
export function visitPackAuditDetail(plan: {
  readonly sectionCounts: Readonly<Record<string, number>>;
  readonly entries: readonly VisitPackEntry[];
  readonly notes: readonly string[];
}): Readonly<Record<string, string | number | boolean | null>> {
  const detail: Record<string, string | number | boolean | null> = {
    entry_count: plan.entries.length,
    note_count: plan.notes.length,
    // Section names are a closed vocabulary and carry no personal content, but the *counts* are
    // what makes an audit trail useful: "exported 12 medicines" is answerable, "exported which
    // medicines" deliberately is not.
    sections: Object.entries(plan.sectionCounts)
      .filter(([, count]) => count > 0)
      .map(([section]) => section)
      .sort()
      .join(','),
  };
  for (const [section, count] of Object.entries(plan.sectionCounts)) {
    if (count > 0) detail[`count_${section.toLowerCase()}`] = count;
  }
  return detail;
}

/** Item IDs in a pack, for callers that need to re-read the same records. */
export function ownedItemIdsIn(entries: readonly VisitPackEntry[]): readonly OwnedItemId[] {
  return entries.filter((e) => e.entityKind === 'owned_item').map((e) => e.entityId as OwnedItemId);
}
