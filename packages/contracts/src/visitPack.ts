/**
 * Choosing what goes in a Visit Pack, and quoting exactly what was reviewed.
 *
 * Spec references: `04` Phase 8.4, `14` (step-up for exports), `16` (sharing is deliberate and
 * scoped), DEC-022 (a pack stores a manifest and a digest, never a copy), DEC-023 (generation
 * quotes the digest of the content the user reviewed and is refused if recomputing it differs).
 *
 * THE DIGEST IS THE WHOLE POINT
 * DEC-023 is what makes "a user can review exactly what will be shared" a property of the system
 * rather than a claim about the client. The server rebuilds the selection from live records,
 * recomputes the digest, and refuses with `EXPORT_CONTENT_CHANGED` if it differs from the one the
 * request quoted. So this module hashes **the entries the screen actually displayed** - the ones
 * that came back from `GET /v1/visit-packs/candidates` - and never re-fetches to "make sure". A
 * client that refreshed before hashing would quote a digest of content the user never saw, and
 * the refusal that exists to catch exactly that would stop firing.
 *
 * WHY THE HASH IS INJECTED
 * SHA-256 is asynchronous on every platform this runs on and comes from a different module on
 * each - `expo-crypto` on a device, `node:crypto` in a test. The canonical form is the domain's,
 * shared verbatim, so the two sides cannot disagree about what is being hashed; only the hashing
 * is a port.
 */

import {
  VISIT_PACK_ENTITY_KINDS,
  VISIT_PACK_SECTIONS,
  canonicalizeSelection,
  toNoteEntries,
  type VisitPackEntry,
} from '@kynviora/domain';
import type { VisitPackCandidate, VisitPackGeneration } from './client.js';

/** Hash a canonical string to lowercase hex. Asynchronous because every platform's is. */
export type DigestFn = (canonical: string) => Promise<string>;

export type VisitPackRefusal =
  | { readonly reason: 'NOTHING_CHOSEN'; readonly message: string }
  | { readonly reason: 'TOO_MANY'; readonly message: string }
  | { readonly reason: 'UNKNOWN_SELECTION'; readonly message: string }
  /** A candidate this client cannot canonicalise the same way the server does. */
  | { readonly reason: 'UNRECOGNISED_ENTRY'; readonly message: string };

export type VisitPackDraft =
  | { readonly ok: true; readonly body: VisitPackGeneration; readonly entryCount: number }
  | { readonly ok: false; readonly refusal: VisitPackRefusal };

/** Mirrors `MAX_VISIT_PACK_ENTRIES` on the server, so the screen refuses before the request does. */
export const MAX_ENTRIES = 200;

export const NOTHING_CHOSEN_MESSAGE =
  'Choose what to include before creating the pack. You can also add a note instead.';

export const TOO_MANY_MESSAGE =
  'That is more than one pack can hold. Choose the things this visit is about.';

export const UNKNOWN_SELECTION_MESSAGE =
  'Something in this selection is no longer available. Check the list again before sharing.';

export const UNRECOGNISED_ENTRY_MESSAGE =
  'Kynviora could not prepare part of this list on this device. Update the app, then try again.';

/**
 * A candidate as it came back, in the shape the canonical form expects - or `null`.
 *
 * `null` rather than a coerced value, and this is the important part. The canonical form includes
 * the section, the entity kind and the caveat verbatim, so substituting a default for any of them
 * produces a digest that differs from the server's. The user would then be told the content had
 * changed when nothing had, and `EXPORT_CONTENT_CHANGED` - the refusal that makes DEC-023 mean
 * anything - would start firing for a reason it was not built to report.
 */
function toEntry(candidate: VisitPackCandidate): VisitPackEntry | null {
  const section = (VISIT_PACK_SECTIONS as readonly string[]).includes(candidate.section)
    ? (candidate.section as VisitPackEntry['section'])
    : null;
  const entityKind = (VISIT_PACK_ENTITY_KINDS as readonly string[]).includes(candidate.entityKind)
    ? (candidate.entityKind as VisitPackEntry['entityKind'])
    : null;

  if (section === null || entityKind === null || candidate.caveat === null) return null;

  return {
    section,
    entityKind,
    entityId: candidate.entityId,
    version: candidate.version,
    lines: candidate.lines,
    caveat: candidate.caveat,
  };
}

/**
 * Build the generation request from what the screen displayed.
 *
 * `candidates` must be the entries the user was actually looking at. `reviewedAt` is the server
 * time from that same response: it says "the content as of this moment is what I reviewed", which
 * is the claim the digest backs up.
 */
export async function buildVisitPack(
  input: {
    readonly profileId: string;
    readonly candidates: readonly VisitPackCandidate[];
    readonly selectedEntityIds: readonly string[];
    readonly notes?: readonly string[];
    readonly reviewedAt: string;
    readonly ttlHours?: number;
  },
  digest: DigestFn,
): Promise<VisitPackDraft> {
  const notes = (input.notes ?? []).map((note) => note.trim()).filter((note) => note !== '');

  if (input.selectedEntityIds.length === 0 && notes.length === 0) {
    // An empty pack is not a useful handoff, and the server refuses it too.
    return { ok: false, refusal: { reason: 'NOTHING_CHOSEN', message: NOTHING_CHOSEN_MESSAGE } };
  }

  if (input.selectedEntityIds.length > MAX_ENTRIES) {
    return { ok: false, refusal: { reason: 'TOO_MANY', message: TOO_MANY_MESSAGE } };
  }

  const byId = new Map(input.candidates.map((candidate) => [candidate.entityId, candidate]));

  const selected: VisitPackEntry[] = [];
  for (const id of input.selectedEntityIds) {
    const candidate = byId.get(id);
    if (candidate === undefined) {
      // The screen offered something that is not in the list it was given. Refused here so the
      // user is told to look again rather than being handed a server error about a digest.
      return {
        ok: false,
        refusal: { reason: 'UNKNOWN_SELECTION', message: UNKNOWN_SELECTION_MESSAGE },
      };
    }
    if (selected.some((entry) => entry.entityId === id)) continue;

    const entry = toEntry(candidate);
    if (entry === null) {
      return {
        ok: false,
        refusal: { reason: 'UNRECOGNISED_ENTRY', message: UNRECOGNISED_ENTRY_MESSAGE },
      };
    }
    selected.push(entry);
  }

  // Selected records first, then the notes - the same order the server builds, because the
  // canonical form sorts by section and ID but the note IDs are positional and must line up.
  const entries = [...selected, ...toNoteEntries(notes)];
  const reviewedDigest = await digest(canonicalizeSelection(entries));

  return {
    ok: true,
    entryCount: entries.length,
    body: {
      profileId: input.profileId,
      selectedEntityIds: selected.map((entry) => entry.entityId),
      reviewedDigest,
      reviewedAt: input.reviewedAt,
      ...(notes.length === 0 ? {} : { notes }),
      ...(input.ttlHours === undefined ? {} : { ttlHours: input.ttlHours }),
    },
  };
}

/**
 * Whether an outcome means the content moved between review and generation.
 *
 * Worth naming, because it is the one refusal on this path that is not a mistake: the records
 * genuinely changed, and the correct response is to show the user the new list rather than to
 * retry the same request.
 */
export function contentChanged(outcome: {
  readonly kind: string;
  readonly code?: string;
}): boolean {
  return outcome.kind === 'REFUSED' && outcome.code === 'EXPORT_CONTENT_CHANGED';
}
