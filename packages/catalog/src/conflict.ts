/**
 * Formulation conflict and change detection.
 *
 * Spec references: `04` Phase 3.6 and 5.3, `08` "Formulation conflict and change detection",
 * `06` Journey 5 and 11, `24` (capture/Living Catalog done criteria).
 *
 * THE CORE GUARANTEE
 * `24`: "Same-barcode/different-formula creates conflict/new formulation, not overwrite."
 * `08`: "do not overwrite the old formulation."
 *
 * This module is a pure decision function. It takes an existing formulation and a newly observed
 * one and returns *what should happen*, never performing the mutation itself. Keeping it pure is
 * what makes the guarantee testable: there is no code path here capable of overwriting anything.
 */

import type { Instant } from '@kynviora/domain';
import { compareInstants } from '@kynviora/domain';
import type { Fingerprint } from './fingerprint.js';
import { sameApparentFormulation, isCrossVersionComparison } from './fingerprint.js';
import type { NormalizedIngredient } from './ingredients.js';

/** What the catalog should do with a new observation. */
export const RESOLUTION_ACTIONS = [
  /** Fingerprints match: link the observation to the existing formulation. The cheap path. */
  'REUSE_EXISTING',
  /** No existing formulation for this identity/market: create the first candidate. */
  'CREATE_FIRST_CANDIDATE',
  /** Materially different from an existing formulation: create a conflict for review. */
  'CREATE_CONFLICT',
  /** Cannot be compared safely; requires re-extraction or user confirmation. */
  'REQUIRE_REVERIFICATION',
] as const;
export type ResolutionAction = (typeof RESOLUTION_ACTIONS)[number];

/** Categories of material change, mirroring the `catalog_conflict.conflict_kind` CHECK. */
export const CONFLICT_KINDS = [
  'INGREDIENT_DECLARATION_CHANGED',
  'STRENGTH_CHANGED',
  'DOSAGE_FORM_CHANGED',
  'MANUFACTURER_CHANGED',
  'PROVIDER_DISAGREEMENT',
  'EXTRACTION_DISAGREEMENT',
] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

/** A single difference between two ingredient declarations. */
export interface IngredientDiffEntry {
  readonly changeKind: 'ADDED' | 'REMOVED' | 'MOVED' | 'CONCENTRATION_CHANGED';
  readonly term: string;
  readonly previousPosition: number | null;
  readonly newPosition: number | null;
  readonly previousConcentrationPercent?: number | null;
  readonly newConcentrationPercent?: number | null;
}

export interface IngredientDiff {
  readonly entries: readonly IngredientDiffEntry[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly reordered: readonly string[];
  /** True when anything at all differs, including a pure reordering. */
  readonly hasChanges: boolean;
  /**
   * True when the change is material enough to warrant a new formulation version.
   *
   * A pure reordering counts as material: INCI order encodes relative concentration, so moving
   * an ingredient is a genuine formulation difference, not a labelling tidy-up.
   */
  readonly isMaterial: boolean;
}

/**
 * Compare two ordered ingredient declarations.
 *
 * Presented as an explicit, human-readable diff because `05` (Formula Change Watch) and `07.4`
 * (Evidence and Regulatory Diff) require showing *what changed* without characterising the
 * change as good or bad. This function deliberately makes no safety judgement.
 */
export function diffIngredients(
  previous: readonly NormalizedIngredient[],
  next: readonly NormalizedIngredient[],
): IngredientDiff {
  const keyOf = (i: NormalizedIngredient): string => i.canonicalKey ?? `raw:${i.lookupKey}`;

  const prevByKey = new Map(previous.map((i) => [keyOf(i), i]));
  const nextByKey = new Map(next.map((i) => [keyOf(i), i]));

  const entries: IngredientDiffEntry[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const reordered: string[] = [];

  for (const [key, item] of nextByKey) {
    if (!prevByKey.has(key)) {
      added.push(item.rawTerm);
      entries.push({
        changeKind: 'ADDED',
        term: item.rawTerm,
        previousPosition: null,
        newPosition: item.position,
      });
    }
  }

  for (const [key, item] of prevByKey) {
    if (!nextByKey.has(key)) {
      removed.push(item.rawTerm);
      entries.push({
        changeKind: 'REMOVED',
        term: item.rawTerm,
        previousPosition: item.position,
        newPosition: null,
      });
    }
  }

  for (const [key, prevItem] of prevByKey) {
    const nextItem = nextByKey.get(key);
    if (!nextItem) continue;

    if (prevItem.position !== nextItem.position) {
      reordered.push(nextItem.rawTerm);
      entries.push({
        changeKind: 'MOVED',
        term: nextItem.rawTerm,
        previousPosition: prevItem.position,
        newPosition: nextItem.position,
      });
    }

    if (prevItem.disclosedConcentrationPercent !== nextItem.disclosedConcentrationPercent) {
      entries.push({
        changeKind: 'CONCENTRATION_CHANGED',
        term: nextItem.rawTerm,
        previousPosition: prevItem.position,
        newPosition: nextItem.position,
        previousConcentrationPercent: prevItem.disclosedConcentrationPercent,
        newConcentrationPercent: nextItem.disclosedConcentrationPercent,
      });
    }
  }

  const hasChanges = entries.length > 0;

  return {
    entries,
    added,
    removed,
    reordered,
    hasChanges,
    // Every detected difference is material. Ingredient presence obviously so; order because it
    // encodes relative concentration; disclosed concentration because it is exactly the datum a
    // concentration-limited regulatory rule needs.
    isMaterial: hasChanges,
  };
}

export interface ExistingFormulationSnapshot {
  readonly formulationId: string;
  readonly fingerprint: Fingerprint;
  readonly ingredients: readonly NormalizedIngredient[];
  readonly manufacturerKey: string | null;
  readonly strengthText: string | null;
  readonly dosageForm: string | null;
  readonly firstObservedAt: Instant;
  readonly lastObservedAt: Instant;
}

export interface ObservedFormulationCandidate {
  readonly fingerprint: Fingerprint;
  readonly ingredients: readonly NormalizedIngredient[];
  readonly manufacturerKey: string | null;
  readonly strengthText: string | null;
  readonly dosageForm: string | null;
  readonly observedAt: Instant;
  /**
   * Whether the independent extraction mechanisms agreed on the source fields.
   *
   * `17` requires disagreement to trigger re-extraction or user confirmation rather than being
   * resolved by picking the higher-confidence model output.
   */
  readonly extractionAgreed: boolean;
  /** Whether the material fields were confirmed by the user or a reviewer. */
  readonly humanConfirmed: boolean;
}

export interface ConflictDecision {
  readonly action: ResolutionAction;
  readonly conflictKinds: readonly ConflictKind[];
  readonly ingredientDiff: IngredientDiff | null;
  readonly affectedFields: readonly string[];
  /** Non-sensitive machine reason, safe for logs and operator dashboards. */
  readonly reasonCode: string;
  /**
   * Whether the existing formulation's `last_observed_at` should advance.
   *
   * Only true on a genuine reuse. A conflicting observation must not touch the existing record,
   * because doing so would make a superseded formula look freshly confirmed.
   */
  readonly advancesLastObserved: boolean;
}

/**
 * Decide what to do with a newly observed formulation.
 *
 * @param existing - candidate formulations already known for this product identity and market.
 */
export function resolveFormulationObservation(
  existing: readonly ExistingFormulationSnapshot[],
  candidate: ObservedFormulationCandidate,
): ConflictDecision {
  // Extraction disagreement is checked before any comparison. Comparing an unreliable reading
  // against the catalog could either fabricate a conflict or, worse, produce a false reuse.
  if (!candidate.extractionAgreed && !candidate.humanConfirmed) {
    return {
      action: 'REQUIRE_REVERIFICATION',
      conflictKinds: ['EXTRACTION_DISAGREEMENT'],
      ingredientDiff: null,
      affectedFields: [],
      reasonCode: 'extraction_disagreement_unconfirmed',
      advancesLastObserved: false,
    };
  }

  if (existing.length === 0) {
    return {
      action: 'CREATE_FIRST_CANDIDATE',
      conflictKinds: [],
      ingredientDiff: null,
      affectedFields: [],
      reasonCode: 'no_existing_formulation',
      advancesLastObserved: false,
    };
  }

  // Exact fingerprint match against any known formulation is the cheap reuse path that makes the
  // catalog economically viable (`08` cost model).
  const match = existing.find((e) => sameApparentFormulation(e.fingerprint, candidate.fingerprint));
  if (match) {
    // A fingerprint match is a candidate signal, not proof (`08`, DEC-015), so material scalar
    // fields are cross-checked before reuse rather than trusted implicitly.
    //
    // This matters most for a *degraded* fingerprint. Spec 08: "A result missing material
    // strength/form information is not an exact medicine match." When structured strength could
    // not be extracted, two packs of different strengths can legitimately produce the same hash,
    // and a blind reuse would silently attach a user to the wrong formulation - the more
    // dangerous direction of error.
    const scalarConflicts = compareScalarFields(match, candidate);

    if (scalarConflicts.kinds.length === 0) {
      return {
        action: 'REUSE_EXISTING',
        conflictKinds: [],
        ingredientDiff: null,
        affectedFields: [],
        reasonCode:
          match.fingerprint.degraded || candidate.fingerprint.degraded
            ? 'fingerprint_match_degraded_scalars_agree'
            : 'fingerprint_match',
        advancesLastObserved: true,
      };
    }

    return {
      action: 'CREATE_CONFLICT',
      conflictKinds: scalarConflicts.kinds,
      ingredientDiff: diffIngredients(match.ingredients, candidate.ingredients),
      affectedFields: scalarConflicts.fields,
      reasonCode: 'fingerprint_match_but_scalar_fields_differ',
      advancesLastObserved: false,
    };
  }

  // Compare against the most recently observed formulation, which is the one a user is most
  // likely to be holding a successor to.
  const mostRecent = [...existing].sort((a, b) =>
    compareInstants(b.lastObservedAt, a.lastObservedAt),
  )[0]!;

  // If every comparison is cross-version, the algorithm changed rather than the product. Treat
  // it as needing reverification instead of manufacturing a formulation change for every item.
  if (existing.every((e) => isCrossVersionComparison(e.fingerprint, candidate.fingerprint))) {
    return {
      action: 'REQUIRE_REVERIFICATION',
      conflictKinds: [],
      ingredientDiff: null,
      affectedFields: [],
      reasonCode: 'fingerprint_version_mismatch',
      advancesLastObserved: false,
    };
  }

  const scalar = compareScalarFields(mostRecent, candidate);
  const conflictKinds: ConflictKind[] = [...scalar.kinds];
  const affectedFields: string[] = [...scalar.fields];

  const ingredientDiff = diffIngredients(mostRecent.ingredients, candidate.ingredients);
  if (ingredientDiff.isMaterial) {
    conflictKinds.unshift('INGREDIENT_DECLARATION_CHANGED');
    affectedFields.unshift('formulation.ingredientDeclaration');
  }

  // Fingerprints differ, so something material differs by construction. If the field-level
  // comparison found nothing, the difference lies in a field the diff does not enumerate
  // (product use type, market context). Flag it for review rather than silently reusing - a
  // silent reuse here would be exactly the overwrite the spec forbids.
  if (conflictKinds.length === 0) {
    return {
      action: 'CREATE_CONFLICT',
      conflictKinds: ['PROVIDER_DISAGREEMENT'],
      ingredientDiff,
      affectedFields: ['formulation.fingerprint'],
      reasonCode: 'fingerprint_differs_without_identified_field',
      advancesLastObserved: false,
    };
  }

  return {
    action: 'CREATE_CONFLICT',
    conflictKinds,
    ingredientDiff,
    affectedFields,
    reasonCode: 'material_formulation_difference',
    advancesLastObserved: false,
  };
}

/**
 * Compare the material scalar fields two formulations carry outside the ingredient list.
 *
 * Used both as a cross-check on a fingerprint match and as part of the full comparison, so a
 * difference in strength, dosage form or manufacturer is caught on either path.
 */
function compareScalarFields(
  existing: ExistingFormulationSnapshot,
  candidate: ObservedFormulationCandidate,
): { kinds: ConflictKind[]; fields: string[] } {
  const kinds: ConflictKind[] = [];
  const fields: string[] = [];

  if (normalizeOrNull(existing.strengthText) !== normalizeOrNull(candidate.strengthText)) {
    kinds.push('STRENGTH_CHANGED');
    fields.push('formulation.strength');
  }

  if (normalizeOrNull(existing.dosageForm) !== normalizeOrNull(candidate.dosageForm)) {
    kinds.push('DOSAGE_FORM_CHANGED');
    fields.push('formulation.dosageForm');
  }

  if (normalizeOrNull(existing.manufacturerKey) !== normalizeOrNull(candidate.manufacturerKey)) {
    kinds.push('MANUFACTURER_CHANGED');
    fields.push('identity.manufacturer');
  }

  return { kinds, fields };
}

function normalizeOrNull(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.toLowerCase().replace(/\s+/g, ' ').trim();
  return normalized.length === 0 ? null : normalized;
}
