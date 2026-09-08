/**
 * The Care Circle: a household read as people, and the four things their access can be.
 *
 * Spec references: `06` Journey 6, `08.2` (a caregiver's capabilities are separately scoped),
 * `16` (a family relationship is not a licence to see everything), `18` (never colour alone; a
 * limitation travels with the fact it qualifies), `02` (no ranking), DEC-142, DEC-159.
 *
 * WHAT V3 CHANGED, AND WHAT IT DID NOT
 * V3's complaint about Care is that it reads as a settings page rather than a household: *do not
 * make a giant permissions grid the first screen*. The fix it asks for is a card per person,
 * carrying who they are, the two grant lines, a status, an expiry, and their last activity - with
 * the matrix one level down and the editor another.
 *
 * DEC-142 already put the three access blocks in the right shape - what they can see, what they
 * can change, what is not shared - and that is unchanged and reused. What is added here is the
 * **status**, and it is the part that was actually missing.
 *
 * THE FOUR STATUSES, AND THE ONE THIS APP COULD NOT SAY
 * V3 names Active, Invitation pending, Expiring, and No expiry set. The first two were already
 * expressible; the last two were not, and the gap mattered:
 *
 *   - **Expiring.** A grant with `expiresAt` in nine days rendered identically to one with a year
 *     left. `08.2` and `16` both rest on an owner being able to see what access exists, and an
 *     expiry nobody is told about is one that lapses in the middle of somebody's week - which for
 *     a caregiver who records doses is a person who stops being reminded of anything.
 *   - **No expiry set.** An indefinite grant is a decision, and it looked exactly like every other
 *     active one. Naming it does not discourage it; it makes it visible, which is what `16` asks
 *     for when it says a relationship is not a licence.
 *
 * EVERY STATUS IS A WORD AND A SHAPE
 * `18`, and here it is load-bearing rather than a formality: `Expiring` and `Active` are both
 * ordinary, unalarming states, so the tint between them is small on purpose. The word is what
 * carries it.
 *
 * NOTHING HERE RANKS
 * `02` forbids it, and a circle sorted by "most urgent" would be sorting people. The order is the
 * server's.
 */

import { ownEntry } from '@kynviora/domain';
import type { CaregiverCapability } from '@kynviora/domain';
import { CAPABILITY_DESCRIPTIONS, type CaregiverAccessState } from './caregiver.js';
import type { IconName } from './status.js';
import type { ThemeToneToken } from './tokens.js';

/**
 * How long before an expiry is worth saying out loud.
 *
 * Thirty days. Long enough that somebody has time to renew a grant before a caregiver stops
 * being able to record a dose; short enough that a grant with a year on it is not permanently
 * wearing a countdown, which would make the word mean nothing by the time it mattered.
 */
export const EXPIRY_NOTICE_DAYS = 30;

const DAY_MS = 86_400_000;

/** The four V3 names, plus the three endings the vocabulary already had. */
export const CARE_CIRCLE_STATUSES = [
  'ACTIVE',
  'INVITED',
  'EXPIRING',
  'NO_EXPIRY',
  'EXPIRED',
  'DECLINED',
  'REVOKED',
] as const;
export type CareCircleStatus = (typeof CARE_CIRCLE_STATUSES)[number];

export interface CareCircleStatusPresentation {
  readonly label: string;
  readonly iconName: IconName;
  readonly tone: ThemeToneToken;
  /** One sentence saying what the status means for this person, in the second person. */
  readonly meaning: string;
}

const STATUS_PRESENTATIONS: Readonly<Record<CareCircleStatus, CareCircleStatusPresentation>> =
  Object.freeze({
    ACTIVE: {
      label: 'Active',
      iconName: 'check-circle',
      // `positive` marks a completed operation and never a product (`18`). An accepted grant is
      // an operation somebody completed; nothing here says anything about a medicine.
      tone: 'positive',
      meaning: 'They can use this access now.',
    },
    INVITED: {
      label: 'Invitation pending',
      iconName: 'clock',
      tone: 'informational',
      meaning:
        'They have been invited and have not accepted yet. They can see nothing until they do.',
    },
    EXPIRING: {
      label: 'Expiring soon',
      iconName: 'clock',
      // `attention` and deliberately not `action`. An expiry is a date arriving, not a concern
      // somebody reviewed, and `23` D-005 keeps those two in different geometry.
      tone: 'attention',
      meaning:
        'This access ends soon. Nothing happens to their records; they simply stop seeing them.',
    },
    NO_EXPIRY: {
      label: 'No end date',
      iconName: 'info-circle',
      tone: 'neutral',
      meaning: 'This access continues until somebody removes it.',
    },
    EXPIRED: {
      label: 'Ended',
      iconName: 'ban',
      tone: 'neutral',
      meaning: 'This access has ended. They can see nothing.',
    },
    DECLINED: {
      label: 'Declined',
      iconName: 'ban',
      tone: 'neutral',
      meaning: 'They chose not to accept this invitation.',
    },
    REVOKED: {
      label: 'Removed',
      iconName: 'ban',
      tone: 'neutral',
      meaning: 'This access was removed. They can see nothing.',
    },
  });

export function careCircleStatusPresentation(
  status: CareCircleStatus,
): CareCircleStatusPresentation {
  // DEC-147.
  return ownEntry(STATUS_PRESENTATIONS, status) ?? STATUS_PRESENTATIONS.EXPIRED;
}

/**
 * Which of the seven a row is in, given the clock.
 *
 * The two derived ones are only reachable from `ACTIVE`: an invitation that expires soon is still
 * an invitation, and saying "expiring" about access nobody has accepted would be describing the
 * end of something that never started.
 *
 * An `expiresAt` already in the past reads as `EXPIRED` even when the server still calls the row
 * active. The server is the authority on what is *admitted* - `has_capability` re-evaluates the
 * expiry per access - and this is a screen refusing to tell somebody that lapsed access is live
 * while a stale list is on it.
 */
export function careCircleStatusFor(
  row: { readonly state: CaregiverAccessState; readonly expiresAt: string | null },
  nowMs: number,
): CareCircleStatus {
  if (row.state !== 'ACTIVE') return row.state;
  if (row.expiresAt === null) return 'NO_EXPIRY';
  const at = Date.parse(row.expiresAt);
  // An unparseable date is not an expiry anybody can act on, and guessing either way would be
  // worse than saying the access is active with no date this build could read.
  if (Number.isNaN(at)) return 'ACTIVE';
  if (at <= nowMs) return 'EXPIRED';
  return at - nowMs <= EXPIRY_NOTICE_DAYS * DAY_MS ? 'EXPIRING' : 'ACTIVE';
}

/**
 * How many whole days remain, or `null`.
 *
 * Rounded **up**, so an expiry nineteen hours away is "1 day" rather than "0 days" - which reads
 * as already gone. `null` where there is no date or it cannot be read; a caller renders that as
 * an absence rather than as zero.
 */
export function daysUntilExpiry(expiresAt: string | null, nowMs: number): number | null {
  if (expiresAt === null) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  if (at <= nowMs) return 0;
  return Math.ceil((at - nowMs) / DAY_MS);
}

export interface CareCircleCardView {
  readonly id: string;
  readonly subject: 'GRANT' | 'INVITATION';
  readonly displayName: string;
  readonly status: CareCircleStatus;
  readonly statusLabel: string;
  readonly statusMeaning: string;
  readonly statusTone: ThemeToneToken;
  readonly statusIcon: IconName;
  /**
   * The short labels of what they can see and what they can change, in the vocabulary's order.
   *
   * Labels rather than the full sentences `summarizeAccess` produces: a card is a glance and the
   * sentences are what the person detail is for. Two lines, never merged - `08.2` scopes viewing
   * and changing separately and a card that ran them together would be describing one permission.
   */
  readonly canSee: readonly string[];
  readonly canChange: readonly string[];
  /** "Ends in 12 days", "No end date", or null where the row has ended already. */
  readonly expirySentence: string | null;
  readonly isSelf: boolean;
  readonly accessibilityLabel: string;
}

function labelsFor(
  capabilities: readonly CaregiverCapability[],
  changing: boolean,
): readonly string[] {
  const granted = new Set(capabilities);
  return (Object.keys(CAPABILITY_DESCRIPTIONS) as CaregiverCapability[])
    .filter(
      (capability) =>
        granted.has(capability) && CAPABILITY_DESCRIPTIONS[capability].allowsChanges === changing,
    )
    .map((capability) => CAPABILITY_DESCRIPTIONS[capability].label);
}

/**
 * One person, as a card.
 *
 * `now` is passed in rather than read, for the reason every clock in this repository is injected:
 * a status computed from ambient time is one that cannot be tested and moves under a device
 * somebody adjusted.
 */
export function careCircleCard(
  row: {
    readonly id: string;
    readonly subject: 'GRANT' | 'INVITATION';
    readonly state: CaregiverAccessState;
    readonly capabilities: readonly CaregiverCapability[];
    readonly displayName: string;
    readonly expiresAt: string | null;
    readonly isSelf: boolean;
  },
  nowMs: number,
): CareCircleCardView {
  const status = careCircleStatusFor(row, nowMs);
  const presentation = careCircleStatusPresentation(status);
  const canSee = labelsFor(row.capabilities, false);
  const canChange = labelsFor(row.capabilities, true);

  const days = daysUntilExpiry(row.expiresAt, nowMs);
  const expirySentence =
    status === 'EXPIRED' || status === 'REVOKED' || status === 'DECLINED'
      ? null
      : row.expiresAt === null
        ? 'No end date'
        : days === null
          ? null
          : `Ends in ${String(days)} ${days === 1 ? 'day' : 'days'}`;

  // Announced in the order `18` asks for: who, then what state, then what that means, then what
  // the access actually covers - so a screen reader user hears the conclusion before the list.
  const parts = [`${row.displayName}. ${presentation.label}. ${presentation.meaning}`];
  if (expirySentence !== null) parts.push(`${expirySentence}.`);
  parts.push(canSee.length === 0 ? 'They can see nothing.' : `Can see: ${canSee.join(', ')}.`);
  parts.push(
    canChange.length === 0
      ? 'They cannot change anything.'
      : `Can change: ${canChange.join(', ')}.`,
  );
  if (row.isSelf) parts.push('This is your own access.');

  return {
    id: row.id,
    subject: row.subject,
    displayName: row.displayName,
    status,
    statusLabel: presentation.label,
    statusMeaning: presentation.meaning,
    statusTone: presentation.tone,
    statusIcon: presentation.iconName,
    canSee,
    canChange,
    expirySentence,
    isSelf: row.isSelf,
    accessibilityLabel: parts.join(' '),
  };
}

/** Whether a status describes access somebody still has. */
export function statusIsCurrent(status: CareCircleStatus): boolean {
  return (
    status === 'ACTIVE' || status === 'INVITED' || status === 'EXPIRING' || status === 'NO_EXPIRY'
  );
}

export interface CareCircleView {
  /** Access somebody still has, in the order the server sent it. */
  readonly current: readonly CareCircleCardView[];
  /**
   * How many rows describe access that has ended.
   *
   * A **count**, not cards, and the reason is a measurement rather than a preference. On a Pixel 7
   * at font scale 2 one circle card is 1,587 pixels - two thirds of the screen - and this
   * development profile has seven revoked grants on it. Drawn as cards they put `Invite someone`
   * roughly eleven thousand pixels below the fold, which is a primary action nobody reaches.
   *
   * It is a count and not an omission: the sentence is on screen in every state, and every one of
   * those rows is still enumerated in the access list directly beneath, which is the surface that
   * exists to show what happened. `18` will not let an absence pass unlabelled, and this is the
   * label.
   */
  readonly endedCount: number;
  /** The sentence stating that count, or `null` where there is nothing to state. */
  readonly endedSentence: string | null;
}

/**
 * The circle, split into who has access and how many no longer do.
 *
 * Not sorted. `02` forbids ranking and a circle ordered by "most urgent" would be ranking people -
 * and the order the list already has is meaningful: invitations first, because they are the thing
 * that just changed.
 */
export function careCircle(
  rows: readonly {
    readonly id: string;
    readonly subject: 'GRANT' | 'INVITATION';
    readonly state: CaregiverAccessState;
    readonly capabilities: readonly CaregiverCapability[];
    readonly displayName: string;
    readonly expiresAt: string | null;
    readonly isSelf: boolean;
  }[],
  nowMs: number,
): CareCircleView {
  const cards = rows.map((row) => careCircleCard(row, nowMs));
  const current = cards.filter((card) => statusIsCurrent(card.status));
  const endedCount = cards.length - current.length;
  return {
    current,
    endedCount,
    endedSentence:
      endedCount === 0
        ? null
        : `${String(endedCount)} ${endedCount === 1 ? 'person no longer has' : 'people no longer have'} access. They are listed below, with what happened.`,
  };
}

/**
 * The sentence the circle prints above itself.
 *
 * `16`'s rule, in the app's own words, on the screen where it decides something. Present in every
 * state including the empty one, for DEC-138's reason: a circle with nobody in it invites the
 * reading that nobody *could* be in it.
 */
export const CARE_CIRCLE_STATEMENT =
  'Everybody here was given access by somebody in this household, and each one can only see what ' +
  'their own access covers. Being family is not access on its own.';
