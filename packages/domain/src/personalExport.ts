/**
 * A person's copy of what is held about them (`16` export, DEC-117, `DEV-036`).
 *
 * Spec references: `16` (a person can get a copy of what is held about them; export requires
 * intentional action, shows what will be included, re-authenticates, and creates an audit event
 * without duplicating sensitive content into logs), `14` (re-authentication for high-impact
 * actions), `BLK-005` (source licensing and redistribution unreviewed), `docs/RETENTION.md`
 * section 5.
 *
 * WHAT THIS MODULE IS
 * The **shape** of the copy and the rules about what may be in it. The assembly is a database
 * read and lives in the API; what belongs here is the part that must be identical wherever it is
 * decided - which sections exist, what each one is for, and the two things that must never
 * appear.
 *
 * THE TWO RULES
 *
 * 1. **External source material is referenced, never copied.** A regulatory document, a
 *    scientific opinion and a source snapshot are somebody else's material under terms nobody has
 *    reviewed (`BLK-005`), and an export that shipped them would be redistribution decided by an
 *    engineer. A person's copy of their own record is theirs; a regulator's document is not the
 *    product's to hand out. So each is named - identifier, title, publisher, retrieval date, and
 *    where to get it - and its content is left where it is.
 *
 * 2. **What is missing is listed.** `16` asks the export to show what will be included, and the
 *    harder half of that is what will not. A copy that quietly omits a section is worse than one
 *    that omits it loudly, because a person checks a copy once: an absent section reads as "there
 *    was nothing", and the difference between "nothing was recorded" and "this was not included"
 *    is the whole value of the exercise.
 */

/**
 * The version of this shape.
 *
 * Bumped when a section is added, removed or renamed. It is in the artifact so that a copy taken
 * today can still be read against the shape it was written in - a file somebody keeps for years
 * is the case this exists for, and it is exactly the case where the code that wrote it is gone.
 */
export const PERSONAL_EXPORT_FORMAT_VERSION = '1';

/**
 * How long a stored export artifact may live (`docs/RETENTION.md` section 5).
 *
 * **This build stores none.** The export is assembled per request and written to the response, so
 * there is no object with a lifetime and nothing to expire - which satisfies the cap by
 * construction rather than by a sweep, and is the safer of the two designs: a stored artifact is
 * a complete copy of somebody's health record sitting behind a URL, and `16`'s "secure generated
 * file/link handling" is best served by not generating a link.
 *
 * The constant is here because the cap is a decision (DEC-117) and a future build that does store
 * an artifact must not have to rediscover it.
 */
export const MAX_PERSONAL_EXPORT_ARTIFACT_HOURS = 24;

/**
 * A source the export refers to without reproducing.
 *
 * Every field here is bibliographic. None of it is the source's content, which is the point.
 */
export interface ExportedSourceReference {
  readonly sourceId: string;
  readonly title: string;
  readonly publisher: string;
  /**
   * How to find the material.
   *
   * The source registry records no public URL, and inventing one from a source name would be a
   * link this build has never followed. What it does record is the coverage statement `25` makes
   * every source responsible for, which says what the source is and what it does and does not
   * cover - which is what a reader needs to go and find it.
   */
  readonly locator: string | null;
  /** When Kynviora last retrieved it, so a reader can tell how old the reference is. */
  readonly retrievedAt: string | null;
  /**
   * Why it is a reference rather than a copy.
   *
   * Carried per row rather than said once at the top, because a person reading the file in three
   * years has no other way to find out, and "see section 4" is not a thing a JSON file has.
   */
  readonly reason: string;
}

/** A section deliberately absent, and why. */
export interface ExportedOmission {
  readonly section: string;
  readonly reason: string;
}

export const EXPORT_OMISSION_REASONS = Object.freeze({
  /**
   * `14` gives the app role no grant on `audit_event` at all, and `20` keeps it free of health
   * content. It is a record of who acted, held for a security purpose, and putting it into a
   * user-facing artifact would be publishing a security log on request.
   */
  auditLog:
    'The record of who did what, which Kynviora keeps for security. It contains no health information - only which action was taken, by which account, and when. Ask Kynviora directly if you need it.',
  /**
   * `BLK-005`. Named in the artifact rather than only in a document nobody exports.
   */
  sourceMaterial:
    'Regulatory documents and scientific opinions Kynviora consulted. These are published by other organisations under their own terms, so this copy names them and where to find them rather than reproducing them.',
  /**
   * Shared catalog facts. A product record is not personal data, and including one would make the
   * copy larger without making it more complete about the person.
   */
  sharedCatalog:
    'Kynviora’s product records, which describe products rather than you. Where one of your items is linked to a product record, this copy names the link.',
});

/**
 * The sections a complete export has.
 *
 * Declared as a value rather than only as a type so the assembler and its tests agree about
 * completeness: a section added to the response and not to this list, or the reverse, fails
 * rather than producing a copy that is quietly missing something.
 */
export const PERSONAL_EXPORT_SECTIONS = [
  'account',
  'households',
  'profiles',
  'items',
  'schedules',
  'doseEvents',
  'allergies',
  'conditions',
  'reviewTasks',
  'reconciliations',
  'caregiverAccess',
  'visitPacks',
  'notificationSettings',
  'consentReceipts',
] as const;
export type PersonalExportSection = (typeof PERSONAL_EXPORT_SECTIONS)[number];

export interface PersonalExportManifest {
  readonly formatVersion: string;
  /** The instant the copy describes. Everything in it was true as of this moment. */
  readonly exportedAt: string;
  /** Which sections are present, and how many rows each holds. */
  readonly sections: readonly { readonly section: PersonalExportSection; readonly count: number }[];
  readonly omitted: readonly ExportedOmission[];
  readonly sourcesReferenced: readonly ExportedSourceReference[];
}

/**
 * Build the manifest from what was assembled.
 *
 * Counts rather than content: `16` requires the export to show what it includes, and a count is
 * the form of that a person can check against the sections below it without reading the whole
 * file. `20`'s rule about not duplicating sensitive content into logs applies to this object too,
 * because it is the part a support conversation would quote.
 */
export function personalExportManifest(input: {
  readonly exportedAt: string;
  readonly counts: Readonly<Partial<Record<PersonalExportSection, number>>>;
  readonly sourcesReferenced: readonly ExportedSourceReference[];
}): PersonalExportManifest {
  return {
    formatVersion: PERSONAL_EXPORT_FORMAT_VERSION,
    exportedAt: input.exportedAt,
    // Every section, including the empty ones. A section dropped because it had no rows is
    // indistinguishable from one the assembler forgot, and the person reading the file is the
    // one person who cannot tell the difference.
    sections: PERSONAL_EXPORT_SECTIONS.map((section) => ({
      section,
      count: input.counts[section] ?? 0,
    })),
    omitted: [
      { section: 'auditLog', reason: EXPORT_OMISSION_REASONS.auditLog },
      { section: 'sourceMaterial', reason: EXPORT_OMISSION_REASONS.sourceMaterial },
      { section: 'sharedCatalog', reason: EXPORT_OMISSION_REASONS.sharedCatalog },
    ],
    sourcesReferenced: input.sourcesReferenced,
  };
}

/**
 * The reason attached to every source reference.
 *
 * One sentence, the same on each, because the reason is the same on each and varying it would
 * suggest a distinction that does not exist.
 */
export const SOURCE_REFERENCE_REASON =
  'Published by another organisation. Kynviora records where to find it rather than keeping a copy for you.';
