/**
 * What the Visit Pack export scenario's evidence means.
 *
 * Spec references: `19` ("Visit Pack export"), `04` Phase 8.3, `13` (export generation is a
 * privileged server-only operation with idempotency on a retryable mutation), `14` (step-up for an
 * export; an export is a copy of somebody's health data leaving the app), `16` ("Kynviora never
 * shares anything on its own"), `21` (no more data retained than is needed), `DEV-040`.
 *
 * Kept apart from the runner so the judgements run in `npm run verify` with nothing attached
 * (DEC-102).
 *
 * WHAT AN EXPORT IS, AND WHY THE INTERESTING CHECK IS A SUBTRACTION
 * A Visit Pack is a copy of a person's medicines that leaves Kynviora and goes to somebody the
 * app knows nothing about. `16` puts the whole weight of that on one promise, which the screen
 * makes twice: nothing is included until the person chooses it. So the check that matters is not
 * "the pack contains what was ticked" - a pack that contained everything would pass that. It is
 * that the pack contains what was ticked **and nothing else**, which only a run that deliberately
 * leaves something out can see.
 *
 * AND WHY THE EXPIRY IS CHECKED AT ALL
 * `21` asks for no more health data retained than is needed, and an export with no expiry is a
 * permanent second copy of a medicine list, held for a conversation that happened once. The route
 * sets one; this measures that it arrived rather than trusting that it did.
 */

import type { Check } from './analysis.js';

/** One entry in a created pack, as the read route reports it. */
export interface PackEntry {
  readonly lines?: readonly string[];
  readonly label?: string;
}

/** A created pack, read back from the server. */
export interface ServerPack {
  readonly id: string;
  readonly generatedAt: string | null;
  readonly expiresAt: string | null;
  readonly entries: readonly PackEntry[];
}

/** Everything one entry says, flattened, so a name can be looked for wherever it is written. */
export function textOf(entry: PackEntry): string {
  return [entry.label ?? '', ...(entry.lines ?? [])].join(' ');
}

// ---------------------------------------------------------------------------
// PACK-0 - the control
// ---------------------------------------------------------------------------

export interface CandidateEvidence {
  /** Names the app offered to include, or `null` where the screen could not be read. */
  readonly offered: readonly string[] | null;
  /** The one the run intends to tick. */
  readonly chosen: string;
  /** One it intends to leave alone, which is what makes "and nothing else" measurable. */
  readonly leftOut: string;
}

export function candidatesCheck(evidence: CandidateEvidence): Check {
  const title = 'There was something to include and something to leave out';
  if (evidence.offered === null) {
    return {
      id: 'PACK-0',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The list of things that could be shared could not be read.',
    };
  }
  const has = (name: string): boolean =>
    evidence.offered?.some((line) => line.includes(name)) ?? false;
  if (!has(evidence.chosen) || !has(evidence.leftOut)) {
    return {
      id: 'PACK-0',
      title,
      status: 'INCONCLUSIVE',
      detail:
        `The screen offered ${String(evidence.offered.length)} line(s) and did not have both ` +
        `${JSON.stringify(evidence.chosen)} and ${JSON.stringify(evidence.leftOut)}. Without ` +
        'something deliberately left out, "and nothing else" cannot be measured.',
    };
  }
  return {
    id: 'PACK-0',
    title,
    status: 'PASS',
    detail:
      `Both ${JSON.stringify(evidence.chosen)} and ${JSON.stringify(evidence.leftOut)} were on ` +
      'offer, so a pack containing one and not the other says something.',
  };
}

// ---------------------------------------------------------------------------
// PACK-1 - the app made an export
// ---------------------------------------------------------------------------

export interface CreationEvidence {
  readonly steps: readonly (readonly [string, boolean])[];
  /** How many `POST /v1/visit-packs` the switch saw, and what they answered. */
  readonly creates: readonly { readonly status: number; readonly key: string | null }[];
}

/**
 * One export, made by the app, under a key.
 *
 * `13` requires an idempotency key on a retryable mutation, and on this route the reason is sharp:
 * a person who taps Create, sees nothing and taps again would otherwise have two copies of their
 * medicines in the world, each with its own expiry, and would know about one.
 */
export function exportCreatedCheck(evidence: CreationEvidence): Check {
  const title = 'The app created one export, under an idempotency key';
  const failed = evidence.steps.find(([, happened]) => !happened);
  if (failed !== undefined) {
    return {
      id: 'PACK-1',
      title,
      status: 'INCONCLUSIVE',
      detail: `Could not ${failed[0]}, so no export was made.`,
    };
  }
  const created = evidence.creates.filter((create) => create.status === 201);
  if (created.length !== 1) {
    return {
      id: 'PACK-1',
      title,
      status: 'FAIL',
      detail:
        `${String(created.length)} export(s) were created where one was asked for. Each is a copy ` +
        'of somebody’s medicines with its own expiry.',
    };
  }
  if ((created[0]?.key ?? null) === null) {
    return {
      id: 'PACK-1',
      title,
      status: 'FAIL',
      detail: 'The export was created with no idempotency key, so a retry would make a second one.',
    };
  }
  return {
    id: 'PACK-1',
    title,
    status: 'PASS',
    detail: 'One export was created, and the request carried an idempotency key.',
  };
}

// ---------------------------------------------------------------------------
// PACK-2 - the export exists and can be read back
// ---------------------------------------------------------------------------

export interface ReadBackEvidence {
  /** The identifier the create answered with, as the switch recorded it. */
  readonly packId: string | null;
  /** Whether reading it back as the person who made it succeeded. */
  readonly readable: boolean;
}

/**
 * The export exists and the person who made it can read it back.
 *
 * The app deliberately shows nothing identifying when it is done - no link, no reference - which is
 * the right design and leaves nothing on the screen to check. There is no route that lists packs
 * either, on purpose: a list of somebody's exports is itself a record of who they have talked to
 * about their health. So the switch records the identifier the create answered with, and this asks
 * whether that identifier names something the owner can actually read.
 *
 * A create that answered with an id nothing can read would mean the pack a person believes they
 * have handed over does not exist, which is the failure they would find out about in the
 * appointment.
 */
export function exportReadableCheck(evidence: ReadBackEvidence): Check {
  const title = 'The export exists and the person who made it can read it back';
  if (evidence.packId === null) {
    return {
      id: 'PACK-2',
      title,
      status: 'FAIL',
      detail:
        'The create answered without naming an export, so there is nothing to read back and ' +
        'nothing the person could hand to anybody.',
    };
  }
  if (!evidence.readable) {
    return {
      id: 'PACK-2',
      title,
      status: 'FAIL',
      detail:
        'The create named an export the owner cannot read. A person believes they have prepared ' +
        'a summary and would find out otherwise at the appointment.',
    };
  }
  return {
    id: 'PACK-2',
    title,
    status: 'PASS',
    detail: 'The create named an export, and the owner can read it back.',
  };
}

// ---------------------------------------------------------------------------
// PACK-3 - what was chosen, and nothing else
// ---------------------------------------------------------------------------

export interface ContentEvidence {
  readonly pack: ServerPack | null;
  readonly chosen: string;
  readonly leftOut: string;
}

/**
 * The subtraction, which is the whole scenario.
 *
 * `16`: "Kynviora never shares anything on its own." A pack holding something nobody ticked is
 * that promise broken in the one place it cannot be taken back - the copy has already gone to
 * whoever the person handed it to.
 */
export function exportContentCheck(evidence: ContentEvidence): Check {
  const title = 'The export holds exactly what was ticked, and nothing that was not';
  if (evidence.pack === null) {
    return {
      id: 'PACK-3',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The export could not be read back.',
    };
  }
  const text = evidence.pack.entries.map(textOf).join(' | ');
  const includesChosen = text.includes(evidence.chosen);
  const includesLeftOut = text.includes(evidence.leftOut);

  if (includesLeftOut) {
    return {
      id: 'PACK-3',
      title,
      status: 'FAIL',
      detail:
        `The export contains ${JSON.stringify(evidence.leftOut)}, which nobody ticked. Spec 16 ` +
        'says Kynviora never shares anything on its own, and this copy has already left.',
    };
  }
  if (!includesChosen) {
    return {
      id: 'PACK-3',
      title,
      status: 'FAIL',
      detail:
        `The export does not contain ${JSON.stringify(evidence.chosen)}, which was ticked. A pack ` +
        'missing what somebody chose is one they will hand over believing it is complete.',
    };
  }
  return {
    id: 'PACK-3',
    title,
    status: 'PASS',
    detail:
      `${String(evidence.pack.entries.length)} entry(s): ${JSON.stringify(evidence.chosen)} is ` +
      `there and ${JSON.stringify(evidence.leftOut)} is not.`,
  };
}

// ---------------------------------------------------------------------------
// PACK-4 - and it does not last for ever
// ---------------------------------------------------------------------------

export function exportExpiryCheck(pack: ServerPack | null): Check {
  const title = 'The export expires';
  if (pack === null) {
    return {
      id: 'PACK-4',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The export could not be read back.',
    };
  }
  if (pack.expiresAt === null || pack.generatedAt === null) {
    return {
      id: 'PACK-4',
      title,
      status: 'FAIL',
      detail:
        'The export carries no expiry. `21` asks for no more health data retained than is needed, ' +
        'and a copy of a medicine list made for one conversation would be kept for ever.',
    };
  }
  const lifetimeMs = Date.parse(pack.expiresAt) - Date.parse(pack.generatedAt);
  if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0) {
    return {
      id: 'PACK-4',
      title,
      status: 'FAIL',
      detail: `The expiry is not after the time it was generated (${pack.expiresAt}).`,
    };
  }
  return {
    id: 'PACK-4',
    title,
    status: 'PASS',
    detail: `It expires ${String(Math.round(lifetimeMs / 86_400_000))} day(s) after it was made.`,
  };
}
