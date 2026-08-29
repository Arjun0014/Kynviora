/**
 * Source adapter contract and the retrieval pipeline.
 *
 * Spec references: `04` Phase 6.2 and 6.3, `13` "Source ingestion workers", `25` (source
 * onboarding), `15` (external source boundary).
 *
 * THE PIPELINE
 *   approved source -> retrieval -> preservation + checksum -> change detection -> parse ->
 *   candidate extraction -> Citation Gate -> review -> publication
 *
 * This module owns everything up to candidate extraction. It deliberately has **no ability to
 * publish**: `publishRegulatoryRule` does not exist here, and the worker running an adapter holds
 * only the grants in migration `0005`. Spec 13: "never directly send user alerts from parser
 * output."
 *
 * HOSTILE SOURCE ASSUMPTION
 * `15` treats every external source as potentially compromised, spoofed, or serving malformed or
 * malicious content. Retrieval therefore enforces an origin allow-list, a byte cap, a timeout and
 * a content-type check, and every retrieved body is `Untrusted<string>` (DEC-017).
 */

import { createHash } from 'node:crypto';
import type { Instant, Logger, Result, DomainError, Untrusted } from '@kynviora/domain';
import { failure, ok, markUntrusted } from '@kynviora/domain';

/** Limits applied to every retrieval. Spec 13: timeouts, body limits, content-type checks. */
export interface RetrievalLimits {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  /** Permitted content types. A source returning anything else is quarantined, not parsed. */
  readonly allowedContentTypes: readonly string[];
}

/**
 * Conservative defaults.
 *
 * 25MB accommodates a consolidated regulation PDF while still bounding memory; a source
 * legitimately larger than this needs an explicit per-adapter override and a review of why.
 */
export const DEFAULT_RETRIEVAL_LIMITS: RetrievalLimits = Object.freeze({
  maxBytes: 25 * 1024 * 1024,
  timeoutMs: 30_000,
  allowedContentTypes: Object.freeze([
    'text/html',
    'text/plain',
    'text/xml',
    'application/xml',
    'application/json',
    'application/pdf',
  ]),
});

/** What a retrieval produced. The body is quarantined; the checksum is over the raw bytes. */
export interface RetrievedSource {
  readonly canonicalUri: string;
  readonly retrievedAt: Instant;
  readonly contentSha256: string;
  readonly byteSize: number;
  readonly contentType: string;
  /** Untrusted by construction. It may contain instructions aimed at a downstream model. */
  readonly body: Untrusted<string>;
  /** Publisher's own version identifier when the source exposes one (ETag, Last-Modified). */
  readonly sourceVersionLabel: string | null;
}

/**
 * The transport a source adapter fetches through.
 *
 * An interface rather than a direct `fetch` call so the pipeline is testable without network
 * access, and so the origin allow-list is enforced in one place.
 */
export interface SourceTransport {
  get(
    uri: string,
    limits: RetrievalLimits,
  ): Promise<
    Result<{ body: string; contentType: string; versionLabel: string | null }, DomainError>
  >;
}

/**
 * A registered source adapter.
 *
 * `parse` returns **candidates**, never published records. `25` requires each adapter to declare
 * its parser version so a record can be traced to the code that produced it.
 */
export interface SourceAdapter<TCandidate> {
  readonly sourceRegistryEntryId: string;
  readonly parserVersion: string;
  /** URIs this adapter is permitted to fetch. Enforced before any request is made. */
  readonly allowedOrigins: readonly string[];
  readonly limits?: RetrievalLimits;

  /** The document(s) this adapter monitors. */
  listSourceUris(): readonly string[];

  /**
   * Parse retrieved material into structured candidates.
   *
   * Receives `Untrusted<string>`, so an implementation cannot accidentally treat source text as
   * an instruction. Returns candidates for the Citation Gate, never publishable records.
   */
  parse(retrieved: RetrievedSource): Result<readonly TCandidate[], DomainError>;
}

/** Compute the content checksum used for preservation and change detection. */
export function computeContentChecksum(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * Whether a URI is permitted for this adapter.
 *
 * Compares scheme, host and port, and requires the path to sit under an allowed prefix. Bare
 * `startsWith` on the whole URI is not enough: `https://eur-lex.europa.eu.evil.test/` starts with
 * an allowed origin's characters but is a different host entirely.
 */
export function isAllowedOrigin(uri: string, allowedOrigins: readonly string[]): boolean {
  let target: URL;
  try {
    target = new URL(uri);
  } catch {
    return false;
  }

  // Only TLS. Spec 14: HTTPS only with a valid certificate chain.
  if (target.protocol !== 'https:') return false;

  return allowedOrigins.some((allowed) => {
    let base: URL;
    try {
      base = new URL(allowed);
    } catch {
      return false;
    }
    if (base.protocol !== target.protocol) return false;
    if (base.host !== target.host) return false;
    // Path prefix must align on a segment boundary, so /alerts does not authorise /alerts-evil.
    const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
    const targetPath = target.pathname.endsWith('/') ? target.pathname : `${target.pathname}/`;
    return targetPath.startsWith(basePath);
  });
}

/**
 * Retrieve one source document.
 *
 * Enforces the origin allow-list before the transport is touched, then the transport enforces the
 * size and time limits. Every failure mode is a `Result`, because `13` requires ingestion workers
 * to quarantine invalid records rather than throwing them into a retry loop.
 */
export async function retrieveSource(
  uri: string,
  adapter: Pick<SourceAdapter<unknown>, 'allowedOrigins' | 'limits'>,
  transport: SourceTransport,
  now: Instant,
): Promise<Result<RetrievedSource, DomainError>> {
  if (!isAllowedOrigin(uri, adapter.allowedOrigins)) {
    // A source adapter fetching an unexpected origin is either a configuration error or a
    // redirect to somewhere it should not follow. Both warrant a hard stop.
    return failure('SOURCE_NOT_AUTHORIZED', 'URI is outside the adapter allow-list.', {
      reason_code: 'origin_not_allowed',
    });
  }

  const limits = adapter.limits ?? DEFAULT_RETRIEVAL_LIMITS;
  const response = await transport.get(uri, limits);
  if (!response.ok) return response;

  const { body, contentType, versionLabel } = response.value;

  const baseType = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!limits.allowedContentTypes.includes(baseType)) {
    return failure('SOURCE_NOT_AUTHORIZED', 'Source returned an unexpected content type.', {
      reason_code: 'content_type_rejected',
      content_type: baseType,
    });
  }

  const byteSize = Buffer.byteLength(body, 'utf8');
  if (byteSize > limits.maxBytes) {
    return failure('SOURCE_NOT_AUTHORIZED', 'Source body exceeded the configured limit.', {
      reason_code: 'body_too_large',
      byte_size: byteSize,
    });
  }

  return ok({
    canonicalUri: uri,
    retrievedAt: now,
    contentSha256: computeContentChecksum(body),
    byteSize,
    contentType: baseType,
    body: markUntrusted(body),
    sourceVersionLabel: versionLabel,
  });
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

export const CHANGE_OUTCOMES = ['UNCHANGED', 'CHANGED', 'FIRST_OBSERVATION'] as const;
export type ChangeOutcome = (typeof CHANGE_OUTCOMES)[number];

export interface ChangeDetectionResult {
  readonly outcome: ChangeOutcome;
  readonly previousChecksum: string | null;
  readonly currentChecksum: string;
  /**
   * Whether downstream parsing and candidate extraction should run.
   *
   * False for an unchanged source. `17` requires expensive model work to be avoided when the
   * material has not moved, and `20` tracks the resulting research fallback rate.
   */
  readonly shouldReprocess: boolean;
}

/**
 * Compare a retrieval against the last known checksum for the same source document.
 *
 * Checksum equality is the whole test. It is deliberately not a semantic diff: a source that
 * re-serialises identical content with a changed timestamp will register as CHANGED, which is
 * the safe direction - reprocessing costs money, missing an amendment costs correctness.
 */
export function detectChange(
  retrieved: RetrievedSource,
  previousChecksum: string | null,
): ChangeDetectionResult {
  if (previousChecksum === null) {
    return {
      outcome: 'FIRST_OBSERVATION',
      previousChecksum: null,
      currentChecksum: retrieved.contentSha256,
      shouldReprocess: true,
    };
  }

  const changed = previousChecksum !== retrieved.contentSha256;
  return {
    outcome: changed ? 'CHANGED' : 'UNCHANGED',
    previousChecksum,
    currentChecksum: retrieved.contentSha256,
    shouldReprocess: changed,
  };
}

// ---------------------------------------------------------------------------
// Ingestion run
// ---------------------------------------------------------------------------

export interface IngestionOutcome<TCandidate> {
  readonly sourceRegistryEntryId: string;
  readonly uri: string;
  readonly change: ChangeDetectionResult | null;
  readonly candidates: readonly TCandidate[];
  readonly retrieved: RetrievedSource | null;
  readonly error: DomainError | null;
  /** Machine status for the source-health dashboard (`20`). */
  readonly status: 'SUCCEEDED' | 'UNCHANGED' | 'FETCH_FAILED' | 'PARSE_FAILED' | 'QUARANTINED';
}

export interface IngestionDependencies {
  readonly transport: SourceTransport;
  readonly logger: Logger;
  /** Last known checksum for a URI, or null when never seen. */
  lastChecksumFor(uri: string): Promise<string | null>;
  readonly now: Instant;
}

/**
 * Run one adapter over its monitored URIs.
 *
 * Never throws: every failure becomes a per-URI outcome so one bad document cannot stall an
 * entire ingestion cycle, and so the source-health dashboard sees exactly what happened.
 */
export async function runIngestion<TCandidate>(
  adapter: SourceAdapter<TCandidate>,
  deps: IngestionDependencies,
): Promise<readonly IngestionOutcome<TCandidate>[]> {
  const outcomes: IngestionOutcome<TCandidate>[] = [];

  for (const uri of adapter.listSourceUris()) {
    const retrieval = await retrieveSource(uri, adapter, deps.transport, deps.now);

    if (!retrieval.ok) {
      deps.logger.warn('ingestion.fetch_failed', {
        source: adapter.sourceRegistryEntryId,
        code: retrieval.error.code,
        reason: retrieval.error.detail?.reason_code ?? null,
      });
      outcomes.push({
        sourceRegistryEntryId: adapter.sourceRegistryEntryId,
        uri,
        change: null,
        candidates: [],
        retrieved: null,
        error: retrieval.error,
        status: retrieval.error.code === 'SOURCE_NOT_AUTHORIZED' ? 'QUARANTINED' : 'FETCH_FAILED',
      });
      continue;
    }

    const retrieved = retrieval.value;
    const previous = await deps.lastChecksumFor(uri);
    const change = detectChange(retrieved, previous);

    if (!change.shouldReprocess) {
      deps.logger.debug('ingestion.unchanged', { source: adapter.sourceRegistryEntryId });
      outcomes.push({
        sourceRegistryEntryId: adapter.sourceRegistryEntryId,
        uri,
        change,
        candidates: [],
        retrieved,
        error: null,
        status: 'UNCHANGED',
      });
      continue;
    }

    const parsed = adapter.parse(retrieved);
    if (!parsed.ok) {
      // Spec 13: quarantine invalid records. A parse failure must not be retried indefinitely
      // against a source whose structure has genuinely changed - it needs a human.
      deps.logger.error('ingestion.parse_failed', {
        source: adapter.sourceRegistryEntryId,
        parser_version: adapter.parserVersion,
        code: parsed.error.code,
      });
      outcomes.push({
        sourceRegistryEntryId: adapter.sourceRegistryEntryId,
        uri,
        change,
        candidates: [],
        retrieved,
        error: parsed.error,
        status: 'PARSE_FAILED',
      });
      continue;
    }

    deps.logger.info('ingestion.succeeded', {
      source: adapter.sourceRegistryEntryId,
      candidate_count: parsed.value.length,
      outcome: change.outcome,
    });

    outcomes.push({
      sourceRegistryEntryId: adapter.sourceRegistryEntryId,
      uri,
      change,
      candidates: parsed.value,
      retrieved,
      error: null,
      status: 'SUCCEEDED',
    });
  }

  return outcomes;
}
