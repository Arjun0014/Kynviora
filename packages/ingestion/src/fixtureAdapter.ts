/**
 * Replayable fixture adapter and in-memory transport.
 *
 * Spec references: `RESEARCH.md` R-008, `BLK-004`, `19` (source onboarding acceptance tests).
 *
 * WHY THIS EXISTS
 * `25` and `26` flag Indian regulatory sources as fragmented, and `26` instructs evaluating the
 * exact current pages before adapter implementation. Guessing at a CDSCO schema would produce an
 * adapter that looks finished and works on nothing.
 *
 * Instead, this adapter reads from stored synthetic documents through the same transport
 * interface a live adapter uses. The whole pipeline - origin checks, size limits, checksums,
 * change detection, parse failure, quarantine - is genuinely exercised, and swapping in a real
 * transport is the only change a live adapter needs.
 *
 * Everything here is clearly labelled synthetic and can never be mistaken for a real regulatory
 * action.
 */

import type { DomainError, Instant, Result } from '@kynviora/domain';
import { failure, ok, exposeUntrusted } from '@kynviora/domain';
import type {
  RetrievalLimits,
  RetrievedSource,
  SourceAdapter,
  SourceTransport,
} from './adapter.js';

/** A canned response for the in-memory transport. */
export interface StubResponse {
  readonly body: string;
  readonly contentType?: string;
  readonly versionLabel?: string | null;
  /** When set, the transport fails with this error instead of responding. */
  readonly failWith?: DomainError;
  /** Simulated body size, for exercising the byte cap without allocating a huge string. */
  readonly reportedByteSize?: number;
}

/**
 * In-memory transport.
 *
 * Also models the failure modes `19` requires resilience tests for: timeout, malformed response,
 * and an oversized body.
 */
export function stubTransport(responses: ReadonlyMap<string, StubResponse>): SourceTransport & {
  readonly requestLog: readonly string[];
} {
  const requestLog: string[] = [];

  return {
    requestLog,
    get(uri: string, limits: RetrievalLimits) {
      requestLog.push(uri);

      const response = responses.get(uri);
      if (!response) {
        return Promise.resolve(
          failure<{ body: string; contentType: string; versionLabel: string | null }>(
            'PROVIDER_UNAVAILABLE',
            'No stub response registered for this URI.',
            { reason_code: 'not_found' },
            true,
          ),
        );
      }

      if (response.failWith) {
        return Promise.resolve(
          { ok: false, error: response.failWith } as Result<
            { body: string; contentType: string; versionLabel: string | null },
            DomainError
          >,
        );
      }

      const size = response.reportedByteSize ?? Buffer.byteLength(response.body, 'utf8');
      if (size > limits.maxBytes) {
        return Promise.resolve(
          failure<{ body: string; contentType: string; versionLabel: string | null }>(
            'SOURCE_NOT_AUTHORIZED',
            'Response exceeded the configured byte limit.',
            { reason_code: 'body_too_large', byte_size: size },
          ),
        );
      }

      return Promise.resolve(
        ok({
          body: response.body,
          contentType: response.contentType ?? 'application/json',
          versionLabel: response.versionLabel ?? null,
        }),
      );
    },
  };
}

/**
 * A candidate regulatory action extracted from a source.
 *
 * Deliberately not a `ProductRegulatoryAction`: a candidate has not passed the Citation Gate and
 * must not be structurally interchangeable with a publishable record.
 */
export interface ActionCandidate {
  readonly jurisdiction: string;
  readonly actionKind: string;
  readonly authority: string;
  readonly gtin: string | null;
  readonly batchCodes: readonly string[];
  readonly summary: string;
  readonly publicationDate: string | null;
  readonly sourceUri: string;
  readonly parserVersion: string;
  /** Always false here. Only an independently retrieved official document can set it. */
  readonly verifiedAgainstOfficialSource: false;
}

/**
 * A parsed source document, typed as `unknown` throughout.
 *
 * Deliberately not given an optimistic interface. This is untrusted external input, and any
 * declared shape would be a claim about a document a hostile or merely changed source is under
 * no obligation to honour. Every field is narrowed explicitly below before use.
 */
type FixtureDocument = Readonly<Record<string, unknown>>;

/** Read a property from an unknown object without asserting anything about its type. */
function field(source: FixtureDocument, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
}

/** Narrow to a trimmed non-empty string, or null. */
function stringField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const ACTION_KINDS = ['RECALL', 'WITHDRAWAL', 'MARKETING_PROHIBITION', 'QUALITY_ALERT', 'WARNING'];

/**
 * Build a replayable adapter over synthetic documents.
 *
 * The parser is deliberately strict. `19` requires source onboarding tests to cover empty,
 * malformed and revision cases, and a lenient parser that coerces bad input would hide exactly
 * the schema drift the parse-failure path exists to catch.
 */
export function createFixtureActionAdapter(options: {
  readonly sourceRegistryEntryId: string;
  readonly jurisdiction: string;
  readonly uris: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly parserVersion?: string;
}): SourceAdapter<ActionCandidate> {
  const parserVersion = options.parserVersion ?? 'fixture-1';

  return {
    sourceRegistryEntryId: options.sourceRegistryEntryId,
    parserVersion,
    allowedOrigins: options.allowedOrigins,

    listSourceUris: () => options.uris,

    parse(retrieved: RetrievedSource): Result<readonly ActionCandidate[], DomainError> {
      // exposeUntrusted is correct here: the body is being parsed as inert data, never used to
      // build an instruction.
      const raw = exposeUntrusted(retrieved.body);

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return failure('VALIDATION_FAILED', 'Source document is not valid JSON.', {
          reason_code: 'malformed_json',
          parser_version: parserVersion,
        });
      }

      if (typeof parsed !== 'object' || parsed === null) {
        return failure('VALIDATION_FAILED', 'Source document is not an object.', {
          reason_code: 'not_an_object',
        });
      }

      const document = parsed as FixtureDocument;
      const actions = field(document, 'actions');

      if (actions === undefined) {
        // An empty document is valid and yields no candidates; a *missing* actions key means the
        // structure changed, which needs a human rather than a silent zero-result run.
        return failure('VALIDATION_FAILED', 'Source document has no actions field.', {
          reason_code: 'schema_drift',
          parser_version: parserVersion,
        });
      }

      if (!Array.isArray(actions)) {
        return failure('VALIDATION_FAILED', 'Actions field is not an array.', {
          reason_code: 'schema_drift',
        });
      }

      const candidates: ActionCandidate[] = [];

      for (const rawEntry of actions as readonly unknown[]) {
        if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
          return failure('VALIDATION_FAILED', 'Action entry is not an object.', {
            reason_code: 'malformed_entry',
          });
        }

        const entry = rawEntry as FixtureDocument;

        const rawKind = stringField(field(entry, 'kind'));
        const kind = rawKind === null ? null : rawKind.toUpperCase();
        if (kind === null || !ACTION_KINDS.includes(kind)) {
          return failure('VALIDATION_FAILED', 'Action entry has an unrecognised kind.', {
            reason_code: 'unknown_action_kind',
          });
        }

        const summary = stringField(field(entry, 'summary'));
        if (summary === null) {
          return failure('VALIDATION_FAILED', 'Action entry has no summary.', {
            reason_code: 'missing_summary',
          });
        }

        const authority = stringField(field(entry, 'authority'));
        if (authority === null) {
          return failure('VALIDATION_FAILED', 'Action entry has no authority.', {
            reason_code: 'missing_authority',
          });
        }

        // Malformed values are dropped rather than coerced. A coerced batch code could match the
        // wrong pack; a coerced date could place an action in the wrong period.
        const rawBatchCodes = field(entry, 'batchCodes');
        const batchCodes: string[] =
          Array.isArray(rawBatchCodes) &&
          (rawBatchCodes as readonly unknown[]).every((c) => typeof c === 'string')
            ? (rawBatchCodes as string[])
            : [];

        const rawGtin = field(entry, 'gtin');
        const gtin =
          typeof rawGtin === 'string' && /^\d{8,14}$/.test(rawGtin) ? rawGtin : null;

        const rawDate = field(entry, 'publicationDate');
        const publicationDate =
          typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;

        candidates.push({
          jurisdiction: options.jurisdiction,
          actionKind: kind,
          authority,
          gtin,
          batchCodes,
          summary,
          publicationDate,
          sourceUri: retrieved.canonicalUri,
          parserVersion,
          // Never true from a parser. Only independent retrieval and review can establish it.
          verifiedAgainstOfficialSource: false,
        });
      }

      return ok(candidates);
    },
  };
}

/** A synthetic source document, clearly labelled so it cannot be mistaken for a real action. */
export function syntheticActionDocument(
  actions: readonly {
    kind: string;
    authority: string;
    gtin?: string;
    batchCodes?: readonly string[];
    summary: string;
    publicationDate?: string;
  }[],
): string {
  return JSON.stringify({
    notice: 'SYNTHETIC FIXTURE. Not a real regulatory publication.',
    actions,
  });
}

/** Convenience for tests that need a deterministic instant. */
export function fixtureInstant(iso: string): Instant {
  return iso as Instant;
}
