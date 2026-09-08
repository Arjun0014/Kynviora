/**
 * Comparing products a person chose, over what their labels declare.
 *
 * Spec references: `09` (a source fact and a Kynviora conclusion are different things), `02` (no
 * score, no ranking, no aggregate), `23` D-014 (an absence must never render as approval), `11`
 * and DEC-010 (composition is server-side), `13` (a profile ID narrows a result set and never
 * grants access), `08`, `BLK-003`, DEC-162.
 *
 * WHY THIS IS A ROUTE AND NOT A CLIENT-SIDE JOIN
 * The shelf already holds the rows, so a client could in principle do this itself. Two reasons it
 * must not. The declaration has to be **parsed**, and `parseIngredientDeclaration` lives in
 * `@kynviora/catalog`, which the presentation layer deliberately cannot depend on - a screen that
 * parsed a label would be a second parser, disagreeing quietly with the one the safety engine
 * uses. And the shelf list does not carry declarations at all: putting every product's ingredient
 * list on every shelf read to make a comparison possible would be sending a page of label text to
 * draw a list of names.
 *
 * WHAT ROW-LEVEL SECURITY DECIDES HERE
 * The same thing it decides everywhere: a product this caller cannot see does not come back, and
 * the route is not an oracle for whether it exists. The response says **how many** of the chosen
 * products it could answer for, because a comparison of three drawn where four were chosen is a
 * different report and a screen has to be able to say so.
 *
 * WHY EVERY PRODUCT MUST BE THE SAME KIND
 * A medicine's declaration is its excipients and a shampoo's is its formulation. Comparing them
 * produces a table that is technically correct and answers no question anybody asked, and the one
 * reading it invites - "this medicine has fewer ingredients than that toothpaste" - is a
 * comparison between two things that are not comparable. Refused with a sentence rather than
 * drawn.
 */

import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { compareDeclarations } from '@kynviora/catalog';
import {
  domainError,
  err,
  isErr,
  ok,
  type DomainError,
  type ItemVerification,
  type Result,
} from '@kynviora/domain';
import { presentVerification, type StatusPresentation } from '@kynviora/presentation';
import type { RequestContext } from './context.js';

/** How many products may be compared at once, and why there is a ceiling at all. */
const MIN_COMPARED = 2;
/**
 * Four.
 *
 * V3's own tray holds four, and the number is a property of the screen rather than of the data: a
 * matrix with a column per product stops being readable on a phone before it stops being
 * computable, and at font scale 2 it does so sooner. A ceiling refused with a sentence is better
 * than a table nobody can read.
 */
const MAX_COMPARED = 4;

const compareQuerySchema = z.object({
  profileId: z.uuid(),
  /**
   * The products to compare, comma-separated.
   *
   * A string rather than a repeated parameter, because that is what a query string spells reliably
   * across clients. Parsed and validated below rather than by a regex here, so a malformed entry
   * names itself.
   */
  itemIds: z.string().min(1).max(400),
});

function invalid(reason: string, code: string): DomainError {
  return domainError('VALIDATION_FAILED', reason, { reason_code: code });
}

export interface ComparedProductResponse {
  readonly id: string;
  readonly displayName: string;
  readonly brand: string | null;
  /** Three separate axes, never merged (`02`, `08`). */
  readonly identity: StatusPresentation;
  readonly formulation: StatusPresentation;
  readonly batch: StatusPresentation;
  /** Whether a declaration has been recorded at all. */
  readonly hasDeclaration: boolean;
  /** How many terms are on it. A count of what is recorded, never a completeness. */
  readonly declaredTermCount: number;
}

export interface CompareResponse {
  readonly products: readonly ComparedProductResponse[];
  readonly shared: readonly { readonly term: string; readonly cells: readonly string[] }[];
  readonly differing: readonly { readonly term: string; readonly cells: readonly string[] }[];
  readonly declaringCount: number;
  readonly matchedByPrintedTermOnly: boolean;
  /**
   * How many of the chosen products this comparison could not include.
   *
   * Non-zero where a product was deleted or belongs to a profile this caller cannot see. Stated
   * rather than silently dropped: a table of three where four were chosen is a different report.
   */
  readonly notAvailableCount: number;
  readonly serverTime: string;
}

interface CompareRow {
  readonly id: string;
  readonly display_name: string;
  readonly brand: string | null;
  readonly item_kind: string;
  readonly identity_verification: string;
  readonly formulation_verification: string;
  readonly batch_verification: string;
  readonly ingredient_declaration_raw: string | null;
}

export interface CompareRouteDependencies {
  readonly contextFor: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<RequestContext | null>;
  readonly fail: (reply: FastifyReply, error: DomainError, correlationId: string) => FastifyReply;
  /**
   * How a stored verification string is narrowed.
   *
   * Injected rather than imported so this module and `server.ts` narrow identically - a second
   * copy of that rule is how a state one of them treats as unverified becomes confirmed in the
   * other.
   */
  readonly asItemVerification: (value: string) => ItemVerification;
}

/**
 * Split and validate the chosen identifiers.
 *
 * Exported because the rules are the interesting half and they are the same rules whether a route
 * or a test asks: at least two, at most four, no duplicates, every one a UUID.
 */
export function parseComparedIds(raw: string): Result<readonly string[], DomainError> {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');

  if (parts.length < MIN_COMPARED) {
    return err(invalid('Choose at least two products to compare.', 'compare_too_few'));
  }
  if (parts.length > MAX_COMPARED) {
    return err(
      invalid(
        `Kynviora compares up to ${String(MAX_COMPARED)} products at a time.`,
        'compare_too_many',
      ),
    );
  }
  if (new Set(parts).size !== parts.length) {
    // A product compared with itself produces a table of identical columns, which reads as two
    // products that agree about everything.
    return err(invalid('Choose a different product for each column.', 'compare_duplicate'));
  }
  for (const part of parts) {
    if (!z.uuid().safeParse(part).success) {
      return err(invalid('That is not a product Kynviora can compare.', 'compare_id'));
    }
  }
  return ok(parts);
}

export function registerCompareRoutes(app: FastifyInstance, deps: CompareRouteDependencies): void {
  app.get('/v1/compare', async (request, reply) => {
    const ctx = await deps.contextFor(request, reply);
    if (!ctx) return;

    const parsed = compareQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return deps.fail(
        reply,
        invalid('Invalid query parameters.', 'query_schema'),
        ctx.correlationId,
      );
    }

    const parsedIds = parseComparedIds(parsed.data.itemIds);
    if (isErr(parsedIds)) return deps.fail(reply, parsedIds.error, ctx.correlationId);
    const ids = parsedIds.value;

    const result = await ctx.db((db) =>
      db.query<CompareRow>(
        `SELECT id, display_name, brand, item_kind,
                identity_verification, formulation_verification, batch_verification,
                ingredient_declaration_raw
           FROM owned_item
          WHERE id = ANY($1::uuid[]) AND profile_id = $2 AND deleted_at IS NULL`,
        [ids, parsed.data.profileId],
      ),
    );

    // In the order the person chose, not the order the database returned. The columns of a
    // comparison are the columns they picked, and re-ordering them would be this route deciding
    // which product goes first (`02`).
    const byId = new Map(result.rows.map((row) => [row.id, row]));
    const rows = ids.flatMap((id) => {
      const row = byId.get(id);
      return row === undefined ? [] : [row];
    });

    if (rows.length < MIN_COMPARED) {
      // One product is not a comparison, and an empty one is not either. Answered as a refusal
      // rather than as an empty report, because "we could not find them" and "they have nothing in
      // common" are different sentences.
      return deps.fail(
        reply,
        invalid(
          'Kynviora could not find enough of those products to compare.',
          'compare_not_enough',
        ),
        ctx.correlationId,
      );
    }

    const kinds = new Set(rows.map((row) => row.item_kind));
    if (kinds.size > 1) {
      return deps.fail(
        reply,
        invalid(
          'Kynviora compares medicines with medicines and products with products. ' +
            'What is on the two kinds of label is not the same thing.',
          'compare_mixed_kinds',
        ),
        ctx.correlationId,
      );
    }

    const comparison = compareDeclarations(
      rows.map((row) => ({ id: row.id, ingredientDeclarationRaw: row.ingredient_declaration_raw })),
    );
    const declarationById = new Map(
      comparison.products.map((product) => [product.productId, product]),
    );

    const body: CompareResponse = {
      products: rows.map((row) => ({
        id: row.id,
        displayName: row.display_name,
        brand: row.brand,
        identity: presentVerification(
          deps.asItemVerification(row.identity_verification),
          'identity',
        ),
        formulation: presentVerification(
          deps.asItemVerification(row.formulation_verification),
          'formulation',
        ),
        batch: presentVerification(deps.asItemVerification(row.batch_verification), 'batch'),
        hasDeclaration: declarationById.get(row.id)?.hasDeclaration === true,
        declaredTermCount: declarationById.get(row.id)?.declaredTermCount ?? 0,
      })),
      shared: comparison.shared.map((entry) => ({ term: entry.term, cells: [...entry.cells] })),
      differing: comparison.differing.map((entry) => ({
        term: entry.term,
        cells: [...entry.cells],
      })),
      declaringCount: comparison.declaringCount,
      matchedByPrintedTermOnly: comparison.matchedByPrintedTermOnly,
      notAvailableCount: ids.length - rows.length,
      serverTime: ctx.now,
    };

    return reply.status(200).send(body);
  });
}
