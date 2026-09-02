/**
 * Mapping a term somebody typed about themselves onto a canonical substance.
 *
 * Spec references: `04` Phase 5.2 (canonical ingredient/substance normalization; a human review
 * queue for material unresolved mappings), `04` Phase 1.3, `08` ("crowd observations never create
 * or modify a canonical substance"), `15` A11, `10`, DEC-093, DEC-098.
 *
 * WHY THIS EXISTS AT ALL
 * `evaluateIngredientSensitivity` filters profile facts to those carrying a canonical key, so an
 * unmapped allergy is invisible to the one rule that would use it. `allergy_record.substance_id`
 * has been nullable since migration `0004` and nothing had ever set it, which made every recorded
 * allergy in this build unmatched by construction (DEC-093). The normalization engine that would
 * map it has existed since Stage 5 and was only ever pointed at ingredient declarations.
 *
 * THE SAME FUNCTION AS THE ONE BEHIND A LABEL
 * `resolveRecordedTerm` and `normalizeIngredients` both go through `resolveLookupKey`, which is
 * the point rather than tidiness: the rule intersects a declaration's canonical keys with a
 * profile fact's, so two resolvers that agreed today would eventually produce a rule that fires on
 * one spelling of a substance and not on another.
 *
 * NOTHING HERE WRITES TO THE VOCABULARY
 * The lookup is a SELECT against `substance_alias`. A household typing a word is not the catalog
 * learning a substance (`08`, `15` A11), and there is no branch below that inserts an alias, a
 * substance, or anything else. An unrecognised term stays unrecognised, and that is reported
 * rather than papered over.
 *
 * ONLY AN ALIAS RESOLVES, NOT A DISPLAY NAME
 * The lookup reads `substance_alias` and nothing else - not `preferred_name`, not `inci_name`.
 * `08` makes an alias a reviewed artifact carrying its own provenance and its own exact-versus-
 * ambiguous state; a string comparison against a display column is none of those things, and it
 * would let a rule fire on a match nobody reviewed. The practical consequence today is that
 * almost nothing resolves, because the vocabulary needs a licensed source (`BLK-003`) - which is a
 * seeding problem with a name, not a reason to lower the bar for what counts as a match.
 */

import {
  aliasResolverFrom,
  ingredientLookupKey,
  resolveRecordedTerm,
  type SubstanceResolution,
} from '@kynviora/catalog';
import { markUntrusted } from '@kynviora/domain';
import type { RequestContext } from './context.js';

interface AliasRow {
  readonly alias_normalized: string;
  readonly substance_id: string;
  readonly canonical_key: string;
}

/**
 * Resolve one recorded term against the seeded vocabulary.
 *
 * Read on the caller's own connection. `alias_read` and `substance_read` admit any authenticated
 * user because these tables hold product knowledge and never personal health context, so there is
 * nothing here that needs the service role - and running it privileged would be a privilege this
 * operation does not need.
 *
 * `REJECTED` aliases are excluded in SQL rather than filtered afterwards. A rejected mapping is one
 * a reviewer looked at and refused; counting it towards ambiguity would let a refused mapping block
 * a good one, which is the opposite of what refusing it meant.
 */
export async function resolveTermForProfile(
  ctx: RequestContext,
  term: string,
): Promise<SubstanceResolution> {
  const key = ingredientLookupKey(term);
  // An empty key is a term with no letters or digits in it at all. There is nothing to look up and
  // no row could match, so this saves a query rather than changing an answer.
  if (key === '') return { substanceId: null, canonicalKey: null, mappingState: 'UNRESOLVED' };

  const rows = await ctx.db((db) =>
    db.query<AliasRow>(
      `SELECT sa.alias_normalized, sa.substance_id, ns.canonical_key
         FROM substance_alias sa
         JOIN normalized_substance ns ON ns.id = sa.substance_id
        WHERE sa.alias_normalized = $1
          AND sa.mapping_state <> 'REJECTED'`,
      [key],
    ),
  );

  // Distinct by substance, because two aliases pointing at the same substance is one answer and
  // not an ambiguity. Ambiguity is a term that means two different things, which is what the
  // person can act on by being more specific.
  const bySubstance = new Map(
    rows.rows.map((row) => [
      row.substance_id,
      { substanceId: row.substance_id, canonicalKey: row.canonical_key },
    ]),
  );

  return resolveRecordedTerm(
    // Free text a person typed. It reaches the engine quarantined for the same reason an OCR'd
    // declaration does - the engine casefolds and strips it to a lookup key and never interprets it.
    markUntrusted(term),
    aliasResolverFrom(new Map([[key, [...bySubstance.values()]]])),
  );
}
