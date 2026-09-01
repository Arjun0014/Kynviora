/**
 * Recording how a person settled one reconciliation difference.
 *
 * Spec references: `04` Phase 8.5, `09` (Kynviora never decides which conflicting instruction is
 * medically correct), `18` (never present a choice as though one answer were expected), DEC-029,
 * DEC-030, traps 19-21.
 *
 * THE RULE THIS MODULE EXISTS TO KEEP
 * Which value now stands is **stated by a person**. It is never inferred from recency, never
 * defaulted, and never implied by the kind of confirmation: a pharmacist may confirm the older
 * dose, so "a pharmacist confirmed it" does not say which value they confirmed and the screen has
 * to ask. `evaluateResolution` refuses a settling resolution with no side, and this refuses it
 * too - not as a second guarantee, but so the screen can disable a control and say what is still
 * needed rather than hand the user a server error about a decision they thought they had made.
 *
 * There is no `suggestedResolution`, no `preferred`, no `confidence` and no default selection
 * anywhere here. A pre-selected option is a recommendation whatever it is called, and on this
 * screen a recommendation is Kynviora choosing between two medical instructions.
 */

import {
  RECONCILIATION_RESOLUTIONS,
  type AdoptableSide,
  type ReconciliationResolution,
} from '@kynviora/domain';
import { resolutionOption } from '@kynviora/presentation';
import type { DifferenceResolution } from './client.js';

export type ResolutionRefusal =
  | { readonly reason: 'NEEDS_A_SIDE'; readonly message: string }
  | { readonly reason: 'NEEDS_A_NAME'; readonly message: string }
  | { readonly reason: 'UNRESOLVED_CANNOT_ADOPT'; readonly message: string }
  | { readonly reason: 'CONTRADICTS_SIDE'; readonly message: string }
  | { readonly reason: 'UNKNOWN_RESOLUTION'; readonly message: string };

export type ResolutionDraft =
  | { readonly ok: true; readonly body: DifferenceResolution }
  | { readonly ok: false; readonly refusal: ResolutionRefusal };

/**
 * Asked, never assumed.
 *
 * Phrased as a question about the person's own decision rather than about the data, because the
 * data cannot answer it - that is the whole point of Phase 8.5.
 */
export const NEEDS_A_SIDE_MESSAGE = 'Say which version you are going with.';

export const NEEDS_A_NAME_MESSAGE = 'Record who confirmed this.';

export const UNRESOLVED_CANNOT_ADOPT_MESSAGE =
  'Leaving this open means settling on neither version. Kynviora keeps both until you decide.';

export const CONTRADICTS_SIDE_MESSAGE = 'That choice does not match the version selected.';

export function asResolution(raw: string): ReconciliationResolution | null {
  return (RECONCILIATION_RESOLUTIONS as readonly string[]).includes(raw)
    ? (raw as ReconciliationResolution)
    : null;
}

/**
 * Build the resolution body, or say what is still needed.
 *
 * `adopt` is the side the person chose. It is a parameter with no default and no inference: a
 * caller that omitted it for a settling resolution gets a refusal naming the missing choice, which
 * is the only correct behaviour when the system is forbidden from making it.
 */
export function buildResolution(input: {
  readonly resolution: string;
  readonly adopt?: AdoptableSide | null;
  readonly confirmedBy?: string | null;
  readonly note?: string | null;
}): ResolutionDraft {
  const resolution = asResolution(input.resolution);
  if (resolution === null) {
    return {
      ok: false,
      refusal: {
        reason: 'UNKNOWN_RESOLUTION',
        message: 'Kynviora does not recognise that choice on this device.',
      },
    };
  }

  const option = resolutionOption(resolution);
  const adopt = input.adopt ?? null;
  const confirmedBy = input.confirmedBy?.trim() ?? '';
  const note = input.note?.trim() ?? '';

  if (option.needsName && confirmedBy === '') {
    // `04` Phase 8.5: a professional confirmation is only a fact if it names who gave it.
    return { ok: false, refusal: { reason: 'NEEDS_A_NAME', message: NEEDS_A_NAME_MESSAGE } };
  }

  if (!option.settles) {
    if (adopt !== null) {
      // An open difference has not been settled on either value. Letting it carry one would put a
      // decision into the record that nobody made.
      return {
        ok: false,
        refusal: {
          reason: 'UNRESOLVED_CANNOT_ADOPT',
          message: UNRESOLVED_CANNOT_ADOPT_MESSAGE,
        },
      };
    }
  } else if (adopt === null) {
    // The rule. Defaulting to the current list because it is newer would be Kynviora choosing
    // which instruction is correct - and the option's own `fixedSide` is null for exactly the
    // three confirmations where the answer genuinely is not knowable from the choice.
    return { ok: false, refusal: { reason: 'NEEDS_A_SIDE', message: NEEDS_A_SIDE_MESSAGE } };
  }

  // A self-describing resolution must agree with the side it names, or the record would read as
  // "the user kept the previous value" while holding the current one.
  if (option.fixedSide !== null && adopt !== option.fixedSide) {
    return {
      ok: false,
      refusal: { reason: 'CONTRADICTS_SIDE', message: CONTRADICTS_SIDE_MESSAGE },
    };
  }

  return {
    ok: true,
    body: {
      resolution,
      adopt,
      confirmedBy: confirmedBy === '' ? null : confirmedBy,
      note: note === '' ? null : note,
    },
  };
}

/**
 * Whether a resolution can be recorded as it stands.
 *
 * The same code path as {@link buildResolution}, so a control cannot enable something the builder
 * would refuse.
 */
export function canResolve(input: {
  readonly resolution: string;
  readonly adopt?: AdoptableSide | null;
  readonly confirmedBy?: string | null;
}): boolean {
  return buildResolution(input).ok;
}

/**
 * Which side a chosen resolution settles on by itself, or `null` when the person must say.
 *
 * `null` for all three professional confirmations, and that is not an omission: a pharmacist may
 * confirm the older dose (DEC-030). A screen using this to pre-select a side would be inventing
 * the answer it exists to ask for.
 */
export function impliedSide(resolution: string): AdoptableSide | null {
  const narrowed = asResolution(resolution);
  return narrowed === null ? null : resolutionOption(narrowed).fixedSide;
}
