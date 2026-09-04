/**
 * A person's copy of what is held about them (`04` Phase 1.4, `16` export, DEC-117, `DEV-036`).
 *
 *   GET /v1/export   - everything Kynviora holds about this account, as one document
 *
 * Spec references: `16` (export requires intentional action, shows what is included,
 * re-authenticates, and creates an audit event without duplicating sensitive content into logs;
 * a person can get a copy of what is held about them), `14` (high-impact actions need
 * re-authentication), `13` (row-level security decides what a request may read), `BLK-005`,
 * `docs/RETENTION.md` section 5.
 *
 * WHY THERE IS NO ARTIFACT AND NO LINK
 * The approved policy caps a stored export artifact at 24 hours. This build stores none: the copy
 * is assembled per request and written to the response, so there is nothing with a lifetime and
 * nothing to expire. That satisfies the cap by construction rather than by a sweep, and it is the
 * safer of the two designs - a stored artifact is a complete copy of somebody's health record
 * sitting behind a URL, and `16`'s "secure generated file/link handling" is best served by not
 * generating a link. The device saves it; the server never holds it.
 *
 * WHAT DECIDES WHAT IS IN IT
 * Row-level security, and nothing else. Every read here goes through `ctx.db`, so the copy is
 * exactly what this caller may see - which for the household surface means their own profiles and
 * any they hold a grant on. There is no profile parameter and no ownership filter written here:
 * `13` says a profile ID in a request is never proof of access, and the way to honour that is not
 * to take one.
 *
 * That has a consequence worth stating. A caregiver exporting will get what they can see of
 * somebody else's profile, because that is what is held about them *and reachable by them*. The
 * alternative - filtering to owned profiles - would give an owner a copy that omitted a profile
 * they are the subject of, which is the failure this feature exists to prevent.
 *
 * THE COPY IS NOT A VISIT PACK
 * A Visit Pack is a selection, reviewed and confirmed, that leaves the app to be shown to
 * somebody else (`03` group I). This is the whole record, for the person themselves, and it is
 * deliberately not selectable: `16` asks for a copy of what is held, and a copy with a
 * checkbox next to each section is one somebody can accidentally take an incomplete version of.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  SOURCE_REFERENCE_REASON,
  domainError,
  personalExportManifest,
  type DomainError,
  type ExportedSourceReference,
  type PersonalExportSection,
} from '@kynviora/domain';
import type { SourceRegistryEntry } from '@kynviora/regulatory';
import { hasFreshStepUp, type DatabaseConnection, type RequestContext } from './context.js';

export interface PersonalExportRouteDeps {
  readonly contextFor: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<RequestContext | null>;
  readonly fail: (reply: FastifyReply, error: DomainError, correlationId: string) => FastifyReply;
  /** The source registry, for the bibliographic half of a reference. */
  readonly loadSources: () => Promise<ReadonlyMap<string, SourceRegistryEntry>>;
}

type Row = Record<string, unknown>;

/**
 * Read a section, or report it as unavailable rather than failing the whole export.
 *
 * A single failing section must not cost somebody the other thirteen. What it must also not do is
 * pass silently: an empty array where a read failed is indistinguishable from "there was nothing",
 * and that is the specific confusion this whole feature exists to avoid. So a failure is recorded
 * and surfaced in the manifest as a count of `-1`, which no successful read can produce.
 */
async function section(
  db: DatabaseConnection,
  sql: string,
  params: readonly unknown[],
  failures: PersonalExportSection[],
  name: PersonalExportSection,
): Promise<readonly Row[]> {
  try {
    const res = await db.query<Row>(sql, params);
    return res.rows;
  } catch {
    failures.push(name);
    return [];
  }
}

export function registerPersonalExportRoutes(
  app: FastifyInstance,
  deps: PersonalExportRouteDeps,
): void {
  const { contextFor, fail, loadSources } = deps;

  app.get('/v1/export', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    // Before anything is read. `14` treats an export without re-authentication as *the* failure
    // whatever else is wrong with the request, and this is the request that assembles the largest
    // single collection of somebody's health data this system can produce.
    if (!hasFreshStepUp(ctx)) {
      return fail(
        reply,
        domainError('STEP_UP_REQUIRED', 'Confirm your identity before taking a copy.'),
        ctx.correlationId,
      );
    }

    const failures: PersonalExportSection[] = [];

    const data = await ctx.db(async (db) => {
      const read = (name: PersonalExportSection, sql: string, params: readonly unknown[] = []) =>
        section(db, sql, params, failures, name);

      // Order matters only for readability of the file. Every read is independently scoped by
      // row-level security, so none of them depends on the one before having found anything.
      const [
        account,
        households,
        profiles,
        items,
        schedules,
        doseEvents,
        allergies,
        conditions,
        reviewTasks,
        reconciliations,
        caregiverAccess,
        visitPacks,
        notificationSettings,
        consentReceipts,
      ] = await Promise.all([
        read(
          'account',
          `SELECT id, email_normalized, email_verified_at, status, created_at, updated_at
             FROM app_user WHERE deleted_at IS NULL`,
        ),
        read(
          'households',
          `SELECT id, display_name, created_at, updated_at
             FROM household WHERE deleted_at IS NULL`,
        ),
        read(
          'profiles',
          `SELECT id, household_id, display_name, birth_year, age_band, language_tag,
                  is_managed, created_at, updated_at
             FROM profile WHERE deleted_at IS NULL ORDER BY created_at`,
        ),
        read(
          'items',
          `SELECT id, profile_id, item_kind, display_name, brand, manufacturer, market,
                  recorded_gtin, recorded_lot_code, strength_text, dosage_form, directions_text,
                  personal_care_category, ingredient_declaration_raw, label_version_note,
                  -- Provenance, which spec 16 asks for alongside the records themselves: how well
                  -- Kynviora believes it knows each facet, and where the answer came from. A copy
                  -- of a record without this reads as more settled than it is.
                  identity_verification, formulation_verification, batch_verification,
                  product_identity_id, formulation_id, batch_id,
                  lifecycle_state, started_on, stopped_on, expires_on,
                  last_reviewed_at, last_safety_checked_at, notes, version, created_at, updated_at
             FROM owned_item WHERE deleted_at IS NULL ORDER BY created_at`,
        ),
        read(
          'schedules',
          `SELECT s.id, s.owned_item_id, s.schedule_kind, s.times_local, s.days_of_week,
                  s.timezone, s.starts_on, s.ends_on, s.active, s.created_at, s.updated_at
             FROM medicine_schedule s ORDER BY s.created_at`,
        ),
        read(
          'doseEvents',
          `SELECT d.id, d.owned_item_id, d.schedule_id, d.event_kind, d.scheduled_for,
                  d.recorded_at, d.note, d.created_at
             FROM dose_event d ORDER BY d.recorded_at`,
        ),
        read(
          'allergies',
          `SELECT id, profile_id, record_kind, display_term, substance_id, provenance, certainty,
                  noted_on, last_reviewed_at, version, created_at, updated_at
             FROM allergy_record WHERE deleted_at IS NULL ORDER BY created_at`,
        ),
        read(
          'conditions',
          `SELECT id, profile_id, display_term, provenance, certainty, noted_on, last_reviewed_at,
                  created_at, updated_at
             FROM condition_record WHERE deleted_at IS NULL ORDER BY created_at`,
        ),
        read(
          'reviewTasks',
          `SELECT id, profile_id, owned_item_id, task_kind, state, created_at, completed_at
             FROM review_task ORDER BY created_at`,
        ),
        read(
          'reconciliations',
          `SELECT id, profile_id, state, source_kind, source_note, started_at, completed_at,
                  unresolved_count
             FROM reconciliation ORDER BY started_at`,
        ),
        read(
          'caregiverAccess',
          `SELECT id, profile_id, grantee_user_id, granted_by_user_id, capabilities, status,
                  invited_at, accepted_at, expires_at, revoked_at, created_at
             FROM caregiver_grant ORDER BY created_at`,
        ),
        read(
          'visitPacks',
          // The manifest, not the content: a pack is a selection of things that are already in
          // this file, and reproducing them would make the copy larger and no more complete.
          `SELECT id, profile_id, content_digest, generated_at, expires_at, revoked_at
             FROM visit_pack ORDER BY generated_at`,
        ),
        read(
          'notificationSettings',
          `SELECT profile_id, detail_level, created_at, updated_at
             FROM notification_preference ORDER BY created_at`,
        ),
        read(
          'consentReceipts',
          // Retained 24 months past a deletion (DEC-117), and the person's own record of what
          // they agreed to. Both facts are true at once, and this is the one place the second
          // matters more.
          `SELECT id, profile_id, purpose, granted, policy_version, locale, recorded_at
             FROM consent_receipt ORDER BY recorded_at`,
        ),
      ]);

      return {
        account,
        households,
        profiles,
        items,
        schedules,
        doseEvents,
        allergies,
        conditions,
        reviewTasks,
        reconciliations,
        caregiverAccess,
        visitPacks,
        notificationSettings,
        consentReceipts,
      };
    });

    // The bibliographic half of rule 1 (`BLK-005`). Every source the build knows about is named;
    // none of their content is here. Listing all of them rather than only the ones that touched
    // this person's items is deliberate and is the conservative direction: working out which
    // sources influenced which assessment is a derivation, and a derivation that is wrong here
    // omits a reference somebody needed.
    const sources = await loadSources();
    const sourcesReferenced: readonly ExportedSourceReference[] = [...sources.values()].map(
      (entry) => ({
        sourceId: entry.id,
        title: entry.sourceName,
        publisher: entry.organization,
        // No public locator is recorded on a registry entry, and inventing one from the source
        // name would be a URL this build has never fetched. The coverage statement is what `25`
        // makes the registry responsible for saying, and it is what a reader can act on.
        locator: entry.coverageStatement,
        retrievedAt: entry.lastSuccessfulCheckAt,
        reason: SOURCE_REFERENCE_REASON,
      }),
    );

    const counts: Partial<Record<PersonalExportSection, number>> = {};
    for (const [name, rows] of Object.entries(data) as [PersonalExportSection, readonly Row[]][]) {
      // `-1` where the read failed. No successful read can produce it, so a reader can tell a
      // section that was empty from one that did not arrive - which is the difference this
      // feature exists to make visible.
      counts[name] = failures.includes(name) ? -1 : rows.length;
    }

    await ctx.privileged('AUDIT_WRITE', (db) =>
      db.query(
        `INSERT INTO audit_event
           (actor_user_id, actor_role, action, target_kind, target_id, correlation_id, detail)
         VALUES ($1, 'kynviora_service', 'export.personal_data', 'app_user', $1, $2, $3::jsonb)`,
        [
          ctx.principal.userId,
          ctx.correlationId,
          // `16`: an audit event without duplicating sensitive content into logs. Counts and a
          // failure list, never a name, a medicine or a note.
          JSON.stringify({
            profile_count: data.profiles.length,
            item_count: data.items.length,
            failed_sections: failures,
          }),
        ],
      ),
    );

    return reply.status(200).send({
      manifest: personalExportManifest({
        exportedAt: ctx.now,
        counts,
        sourcesReferenced,
      }),
      data,
    });
  });
}
