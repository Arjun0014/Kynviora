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

/** Shape a fixture document must have. Validated before any field is trusted. */
interface FixtureDocument {
  readonly actions?: readonly {
    readonly kind?: unknown;
    readonly authority?: unknown;
    readonly gtin?: unknown;
    readonly batchCodes?: unknown;
    readonly summary?: unknown;
    readonly publicationDate?: unknown;
  }[];
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
      if (document.actions === undefined) {
        // An empty document is valid and yields no candidates; a *missing* actions key means the
        // structure changed, which needs a human rather than a silent zero-result run.
        return failure('VALIDATION_FAILED', 'Source document has no actions field.', {
          reason_code: 'schema_drift',
          parser_version: parserVersion,
        });
      }

      if (!Array.isArray(document.actions)) {
        return failure('VALIDATION_FAILED', 'Actions field is not an array.', {
          reason_code: 'schema_drift',
        });
      }

      const candidates: ActionCandidate[] = [];

      for (const entry of document.actions) {
        if (typeof entry !== 'object' || entry === null) {
          return failure('VALIDATION_FAILED', 'Action entry is not an object.', {
            reason_code: 'malformed_entry',
          });
        }

        const kind = typeof entry.kind === 'string' ? entry.kind.toUpperCase() : null;
        if (kind === null || !ACTION_KINDS.includes(kind)) {
          return failure('VALIDATION_FAILED', 'Action entry has an unrecognised kind.', {
            reason_code: 'unknown_action_kind',
          });
        }

        const summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
        if (summary.length === 0) {
          return failure('VALIDATION_FAILED', 'Action entry has no summary.', {
            reason_code: 'missing_summary',
          });
        }

        const authority = typeof entry.authority === 'string' ? entry.authority.trim() : '';
        if (authority.length === 0) {
          return failure('VALIDATION_FAILED', 'Action entry has no authority.', {
            reason_code: 'missing_authority',
          });
        }

        const batchCodes =
          Array.isArray(entry.batchCodes) &&
          entry.batchCodes.every((c: unknown) => typeof c === 'string')
            ? (entry.batchCodes as string[])
            : [];

        const gtin = typeof entry.gtin === 'string' && /^\d{8,14}$/.test(entry.gtin)
          ? entry.gtin
          : null;

        const publicationDate =
          typeof entry.publicationDate === 'string' &&
          /^\d{4}-\d{2}-\d{2}$/.test(entry.publicationDate)
            ? entry.publicationDate
            : null;

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
