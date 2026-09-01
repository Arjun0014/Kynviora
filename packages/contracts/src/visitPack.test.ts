import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  MAX_ENTRIES,
  NOTHING_CHOSEN_MESSAGE,
  UNKNOWN_SELECTION_MESSAGE,
  UNRECOGNISED_ENTRY_MESSAGE,
  buildVisitPack,
  contentChanged,
  type DigestFn,
} from './visitPack.js';
import type { VisitPackCandidate } from './client.js';
import { canonicalizeSelection, toNoteEntries } from '@kynviora/domain';
import { findForbiddenClaims } from '@kynviora/presentation';

const PROFILE = '00000000-0000-4000-8000-00000000d020';
const REVIEWED_AT = '2026-09-01T12:00:00.000Z';

/** The same hash the server uses. */
const sha256: DigestFn = (canonical) =>
  Promise.resolve(createHash('sha256').update(canonical).digest('hex'));

const candidate = (overrides: Partial<VisitPackCandidate> = {}): VisitPackCandidate => ({
  section: 'CURRENT_MEDICINES',
  entityKind: 'owned_item',
  entityId: 'i1',
  version: 1,
  lines: ['Synthetic Tablet A 500 mg'],
  caveat: 'Typed by the person, not read from a package.',
  ...overrides,
});

describe('the digest covers exactly what the screen displayed', () => {
  it('matches what the server would compute for the same selection', async () => {
    // DEC-023 is only worth something if both sides hash the same thing. The canonical form is
    // the domain's and is shared verbatim; this asserts the client assembles the same entries.
    const one = candidate();
    const two = candidate({ entityId: 'i2', lines: ['Synthetic Capsule B 20 mg'] });

    const draft = await buildVisitPack(
      {
        profileId: PROFILE,
        candidates: [one, two],
        selectedEntityIds: ['i1', 'i2'],
        reviewedAt: REVIEWED_AT,
      },
      sha256,
    );
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const expected = createHash('sha256')
      .update(canonicalizeSelection([one, two] as never))
      .digest('hex');
    expect(draft.body.reviewedDigest).toBe(expected);
  });

  it('includes the notes, in the server’s own shape', async () => {
    // The digest covers the notes as well as the records. A client that omitted them - or spelled
    // the caveat differently - would compute a digest the server refuses with
    // EXPORT_CONTENT_CHANGED, and the failure would look like the content had changed when it had
    // not. `toNoteEntries` is shared for exactly this reason.
    const one = candidate();
    const draft = await buildVisitPack(
      {
        profileId: PROFILE,
        candidates: [one],
        selectedEntityIds: ['i1'],
        notes: ['Is the rash related?'],
        reviewedAt: REVIEWED_AT,
      },
      sha256,
    );
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const expected = createHash('sha256')
      .update(canonicalizeSelection([one, ...toNoteEntries(['Is the rash related?'])] as never))
      .digest('hex');
    expect(draft.body.reviewedDigest).toBe(expected);
    expect(draft.body.notes).toEqual(['Is the rash related?']);
    expect(draft.entryCount).toBe(2);
  });

  it('changes when the content changes', async () => {
    // The property the whole mechanism rests on: a different line means a different digest, so a
    // record that moved between review and generation cannot pass unnoticed.
    const before = await buildVisitPack(
      {
        profileId: PROFILE,
        candidates: [candidate()],
        selectedEntityIds: ['i1'],
        reviewedAt: REVIEWED_AT,
      },
      sha256,
    );
    const after = await buildVisitPack(
      {
        profileId: PROFILE,
        candidates: [candidate({ lines: ['Synthetic Tablet A 250 mg'] })],
        selectedEntityIds: ['i1'],
        reviewedAt: REVIEWED_AT,
      },
      sha256,
    );
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(before.body.reviewedDigest).not.toBe(after.body.reviewedDigest);
  });

  it('does not depend on the order the user ticked things', async () => {
    // The canonical form sorts. Two people selecting the same records in a different order are
    // sharing the same pack and must produce the same digest.
    const one = candidate();
    const two = candidate({ entityId: 'i2', lines: ['Synthetic Capsule B 20 mg'] });
    const forwards = await buildVisitPack(
      {
        profileId: PROFILE,
        candidates: [one, two],
        selectedEntityIds: ['i1', 'i2'],
        reviewedAt: REVIEWED_AT,
      },
      sha256,
    );
    const backwards = await buildVisitPack(
      {
        profileId: PROFILE,
        candidates: [one, two],
        selectedEntityIds: ['i2', 'i1'],
        reviewedAt: REVIEWED_AT,
      },
      sha256,
    );
    expect(forwards.ok && backwards.ok).toBe(true);
    if (!forwards.ok || !backwards.ok) return;
    expect(forwards.body.reviewedDigest).toBe(backwards.body.reviewedDigest);
  });
});

describe('what it refuses to build', () => {
  it('refuses an empty pack', async () => {
    const draft = await buildVisitPack(
      { profileId: PROFILE, candidates: [], selectedEntityIds: [], reviewedAt: REVIEWED_AT },
      sha256,
    );
    expect(draft.ok).toBe(false);
    if (draft.ok) return;
    expect(draft.refusal.reason).toBe('NOTHING_CHOSEN');
  });

  it('accepts a pack that is only notes', async () => {
    // A list of questions with no records is a legitimate handoff, and the server accepts it.
    const draft = await buildVisitPack(
      {
        profileId: PROFILE,
        candidates: [],
        selectedEntityIds: [],
        notes: ['Is the rash related?'],
        reviewedAt: REVIEWED_AT,
      },
      sha256,
    );
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.body.selectedEntityIds).toEqual([]);
  });

  it('drops blank notes rather than hashing them', async () => {
    const draft = await buildVisitPack(
      {
        profileId: PROFILE,
        candidates: [candidate()],
        selectedEntityIds: ['i1'],
        notes: ['  ', ''],
        reviewedAt: REVIEWED_AT,
      },
      sha256,
    );
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.body).not.toHaveProperty('notes');
  });

  it('refuses a selection larger than one pack holds', async () => {
    const draft = await buildVisitPack(
      {
        profileId: PROFILE,
        candidates: [],
        selectedEntityIds: Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => `i${String(i)}`),
        reviewedAt: REVIEWED_AT,
      },
      sha256,
    );
    expect(draft.ok).toBe(false);
    if (draft.ok) return;
    expect(draft.refusal.reason).toBe('TOO_MANY');
  });

  it('refuses an ID that is not in the list it was given', async () => {
    // Refused here so the user is told to look again, rather than being handed a server error
    // about a digest they never saw.
    const draft = await buildVisitPack(
      {
        profileId: PROFILE,
        candidates: [candidate()],
        selectedEntityIds: ['i1', 'i-does-not-exist'],
        reviewedAt: REVIEWED_AT,
      },
      sha256,
    );
    expect(draft.ok).toBe(false);
    if (draft.ok) return;
    expect(draft.refusal.reason).toBe('UNKNOWN_SELECTION');
  });

  it('refuses an entry it cannot canonicalise, rather than coercing it', async () => {
    // The canonical form includes the section, the entity kind and the caveat verbatim, so a
    // substituted default produces a digest that differs from the server's - and the user would
    // be told the content had changed when nothing had.
    for (const broken of [
      candidate({ section: 'SOMETHING_NEWER' }),
      candidate({ entityKind: 'something_newer' }),
      candidate({ caveat: null }),
    ]) {
      const draft = await buildVisitPack(
        {
          profileId: PROFILE,
          candidates: [broken],
          selectedEntityIds: ['i1'],
          reviewedAt: REVIEWED_AT,
        },
        sha256,
      );
      expect(draft.ok).toBe(false);
      if (draft.ok) continue;
      expect(draft.refusal.reason).toBe('UNRECOGNISED_ENTRY');
    }
  });

  it('ignores a duplicate tick rather than refusing', () => {
    // The server refuses a duplicate; the screen should not be able to produce one in the first
    // place, and a double tap is not worth an error.
    return buildVisitPack(
      {
        profileId: PROFILE,
        candidates: [candidate()],
        selectedEntityIds: ['i1', 'i1'],
        reviewedAt: REVIEWED_AT,
      },
      sha256,
    ).then((draft) => {
      expect(draft.ok).toBe(true);
      if (!draft.ok) return;
      expect(draft.body.selectedEntityIds).toEqual(['i1']);
    });
  });
});

describe('content that moved', () => {
  it('is recognisable, because it is not a mistake', () => {
    // The one refusal on this path where the correct response is to show the new list rather
    // than retry the same request.
    expect(contentChanged({ kind: 'REFUSED', code: 'EXPORT_CONTENT_CHANGED' })).toBe(true);
    expect(contentChanged({ kind: 'REFUSED', code: 'VALIDATION_FAILED' })).toBe(false);
    expect(contentChanged({ kind: 'OFFLINE' })).toBe(false);
  });
});

describe('the words', () => {
  it('make no forbidden claim and do not blame', () => {
    for (const text of [
      NOTHING_CHOSEN_MESSAGE,
      UNKNOWN_SELECTION_MESSAGE,
      UNRECOGNISED_ENTRY_MESSAGE,
    ]) {
      expect(findForbiddenClaims(text)).toEqual([]);
      expect(text.toLowerCase()).not.toMatch(/you (failed|forgot|did not)|invalid|error/);
    }
  });
});
