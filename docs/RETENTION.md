# Kynviora - Retention and deletion matrix

**Status**: approved for MVP as a product and engineering default (DEC-117). It is **not** a
legal-compliance claim, and it is not a substitute for the privacy review `16` requires before
production. `BLK-005` (source licensing) and the legal review `16` names remain open, and nothing
here closes them.

This document answers the question `DEV-036` said could not be answered: **when somebody asks for
their data to be removed, what happens to each table, and what is kept regardless.**

Spec references: `16` (privacy, consent, retention matrix, deletion enumeration), `14` (least
privilege, append-only audit), `13` (server-authoritative authorization), `07` (domain model).

---

## 1. What "deleted" means here

Deletion is **two events, not one**, and conflating them is how a product ends up telling somebody
their data is gone while it is still being read.

| Phase          | When                                                    | What changes                                                                                                                                       |
| -------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Revocation** | Synchronously, in the request that accepts the deletion | The record becomes **inaccessible** and **all processing stops**. Reads, reminders, alerts, caregiver access, sync and exports all stop seeing it. |
| **Purge**      | Asynchronously, by the deadline in the matrix           | The bytes go.                                                                                                                                      |

**Revocation is the promise; purge is the deadline.** A person who deletes something must never
have to wait for a background job before the thing stops affecting them. That is why every
deletion in this system is a `deleted_at` stamp that every read predicate already filters, rather
than a row disappearing at a time nobody controls.

**How the stamp is written, and why not by the person writing it.** An `UPDATE` whose `WHERE`
clause reads a column requires `SELECT` rights, and Postgres applies the `SELECT` policies to the
**new** row as well as the old. Every read predicate here filters `deleted_at IS NULL`, so the row
a soft delete produces is one the caller may not see - and the statement is refused for the owner
as much as for anybody else (`DEV-057`). The stamp therefore goes through the service role, which
`13` already names for deletion orchestration, via a function that re-checks ownership in the same
statement that writes it. The alternative - letting deleted rows stay readable so the update
passes - would turn revocation from a database guarantee into an application filter, which is the
one thing this section is for.

**What revocation must stop, enumerated** (`16` requires this list, and a deletion path that
silently omits one of these is the failure this section exists to prevent):

| Surface           | How revocation reaches it                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| Ordinary reads    | Every RLS `SELECT` policy on a soft-deletable table carries `deleted_at IS NULL`.                     |
| Caregiver access  | Same policies. A caregiver's capability is checked against a row the policy no longer returns.        |
| Reminders         | The schedule read joins `owned_item` on `deleted_at IS NULL`, so a deleted item plans no alarms.      |
| Alerts            | Assessment and alert reads are profile-scoped and filter the same way.                                |
| Sync / offline    | The projection is rebuilt from reads that already exclude the row; the device drops it on next drain. |
| Exports           | Visit Pack candidate selection reads through the same predicate.                                      |
| Device local data | Cleared on sign-out, authorization loss and account deletion (section 6).                             |

**What this document does not claim.** Backups. This build has no backup system, so there is
nothing to state a restore lifecycle for; when one exists, `16` requires its expiry and restore
behaviour enumerated here before production. Saying "immediate universal erasure" while a backup
exists is the specific claim `16` forbids, and this document does not make it.

---

## 2. Deletion triggers

Five distinct triggers, because they have different scopes and different authorization:

| Trigger                | Scope                                              | Who may                                                      |
| ---------------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| **Item deletion**      | One `owned_item` and everything reachable from it  | **Profile owner only**, with **fresh step-up**               |
| **Profile deletion**   | One `profile` and everything reachable from it     | **Profile owner only**, with **fresh step-up**               |
| **Account deletion**   | The `app_user`, their households, profiles, grants | The account holder, with fresh step-up                       |
| **Consent withdrawal** | Stops a purpose; does not by itself delete records | The person who granted it                                    |
| **Expiry**             | Time-boxed artifacts reaching their deadline       | Nobody - it is automatic and cannot be extended past its cap |

**Caregiver capabilities never authorize deletion.** Not `MANAGE_MEDICINES`, not `MANAGE_SHELF`,
not `MANAGE_CAREGIVERS`, not any future capability. A caregiver may change what a record says; only
the profile owner may make it stop existing. This is deliberate and is enforced by the policy
rather than by the screen: the capabilities are a set of things a caregiver may _do_, and deletion
is a thing only an owner may do, so it is not in the set at all rather than being a member nobody
grants.

**Fresh step-up is required** because `14` names deletion alongside export and caregiver
administration as a high-impact action for which a merely-valid session is not sufficient.

---

## 3. The matrix

Columns: **Owner** is who the data is about and who controls it. **Purpose** is why it is held.
**Trigger** is which deletion event reaches it. **Effect** is what the person sees immediately on
revocation. **Purge** is the outer deadline for the bytes.

### 3.1 Class P - Personal data. Revoked immediately, purged within 30 days.

Every row here becomes inaccessible the moment the deletion is accepted, and stops all processing
at the same moment.

| Table                         | Owner           | Purpose                                                    | Trigger                        | Effect on revocation                                           | Purge |
| ----------------------------- | --------------- | ---------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------- | ----- |
| `app_user`                    | Account holder  | The account                                                | Account                        | Sign-in stops working; every session is invalid                | 30d   |
| `household`                   | Household owner | Grouping for profiles                                      | Account                        | Household and its profiles vanish from every surface           | 30d   |
| `profile`                     | Profile owner   | The person care is recorded about                          | Profile, Account               | Disappears from the switcher; every child read returns nothing | 30d   |
| `owned_item`                  | Profile owner   | A medicine or personal-care product on the shelf           | Item, Profile, Account         | Gone from the Shelf; no detail; no reminders                   | 30d   |
| `medicine_schedule`           | Profile owner   | When a medicine is meant to be taken                       | Item, Profile, Account         | Alarms cancelled on the device at next reconcile               | 30d   |
| `dose_event`                  | Profile owner   | That a dose was taken or missed                            | Item, Profile, Account         | History empty; no longer available to a Visit Pack             | 30d   |
| `refill_estimate`             | Profile owner   | Derived run-out projection                                 | Item, Profile, Account         | No refill line                                                 | 30d   |
| `product_usage_evidence`      | Profile owner   | Which pack this shelf entry actually was                   | Item, Profile, Account         | Trust Passport loses the private linkage                       | 30d   |
| `allergy_record`              | Profile owner   | A recorded allergy or sensitivity                          | Profile, Account               | Not shown; not used by any assessment                          | 30d   |
| `condition_record`            | Profile owner   | A recorded condition (uncollected - `DEV-035`)             | Profile, Account               | Not shown                                                      | 30d   |
| `profile_assessment`          | Profile owner   | The result of applying a rule to this person's item        | Item, Profile, Account         | No assessment; no alert derived from it                        | 30d   |
| `alert_publication`           | Profile owner   | An alert raised for this person                            | Item, Profile, Account         | Alert gone from Safety                                         | 30d   |
| `safety_receipt`              | Profile owner   | That the person was shown an alert                         | Profile, Account               | Gone                                                           | 30d   |
| `review_task`                 | Profile owner   | Something the household was asked to confirm               | Item, Profile, Account         | Task gone from the Review Inbox                                | 30d   |
| `reconciliation`              | Profile owner   | A medicine-list comparison                                 | Profile, Account               | Gone                                                           | 30d   |
| `reconciliation_difference`   | Profile owner   | One difference within a reconciliation                     | Profile, Account               | Gone                                                           | 30d   |
| `caregiver_grant`             | Profile owner   | That somebody has access                                   | Profile, Account               | **Caregiver's very next request returns nothing**              | 30d   |
| `profile_notification_policy` | Profile owner   | Who is told what, and when                                 | Profile, Account               | No delivery decision can select this profile                   | 30d   |
| `notification_preference`     | Recipient       | A recipient's own quiet hours and channels                 | Profile, Account               | No held or sent notification                                   | 30d   |
| `alert_delivery`              | Profile owner   | That a notification was decided and recorded               | Profile, Account               | Gone                                                           | 30d   |
| `notification_revalidation`   | Recipient       | That an opened notification was re-checked                 | Profile, Account               | Gone                                                           | 30d   |
| `notification_digest`         | Recipient       | A day's low-urgency summary, assembled for them            | Profile, Account               | Gone once it summarises nothing                                | 30d   |
| `notification_digest_entry`   | Recipient       | One delivery a digest considered, and what a re-read found | Profile, Account               | Gone with the delivery it references                           | 30d   |
| `evidence_asset`              | Uploading user  | A captured image or document                               | Item, Profile, Account, Expiry | Not readable; not extractable                                  | 30d   |
| `extraction_run`              | Uploading user  | What an extractor made of that asset                       | Item, Profile, Account         | Gone                                                           | 30d   |

### 3.2 Class T - Time-boxed artifacts. Their own deadline, shorter than 30 days.

These expire on their own clock whether or not anybody asks. Expiry is **revocation**; the purge
deadline is measured from it. **None of them may be permanent**, and the maximum is a hard cap
rather than a default a caller may exceed.

| Table                         | Purpose                             | Default | Maximum | Effect at expiry                               | Purge after expiry                                                       |
| ----------------------------- | ----------------------------------- | ------- | ------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| `visit_pack`                  | A share for one appointment         | **72h** | **14d** | Link dead; nothing renders                     | **24h** (manifest and notes)                                             |
| Portable export artifact      | A copy of the person's own records  | -       | **24h** | Artifact unreachable                           | at expiry                                                                |
| `caregiver_invitation`        | An unaccepted offer of access       | **7d**  | **30d** | Cannot be accepted; disappears from both sides | **30d** (the operational row; the access history stays in `audit_event`) |
| `evidence_asset` (unattached) | A capture not yet linked to an item | -       | **7d**  | Not readable                                   | at expiry                                                                |
| `extraction_run` (unattached) | An extraction over one of those     | -       | **7d**  | Gone                                           | at expiry                                                                |

A Visit Pack's **manifest and notes** are purged within 24h of expiry because they are the content;
the row itself is retained to the same 30-day boundary as its profile so that "a pack was created
and has expired" remains answerable without the pack being readable.

### 3.3 Class R - Retained regardless of deletion, on an approved basis.

These two tables **survive item, profile and account deletion**. They are retained for **24 months**
from the row's own timestamp, and are then purged **only** through the age-gated retention path in
section 4.

| Table             | Why it survives                                                                                                          | Retention | Contains                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | --------- | ----------------------------------------------------------- |
| `audit_event`     | `14`: who performed a sensitive action. A deletion that erases the record of itself cannot be investigated.              | 24 months | Actors, targets, versions. **Never health content** (`20`). |
| `consent_receipt` | `16`: consent is a product state with a history. A withdrawal whose receipt is deleted cannot be shown to have happened. | 24 months | Purpose, granted/withdrawn, policy version.                 |

**What a person is told.** That these are kept, why, and for how long. Not that everything was
erased. Claiming otherwise while these rows stand is the exact failure `16` names.

**They are not exempt from de-identification pressure.** `audit_event` stores an actor id and a
target id and no names; `consent_receipt` stores a purpose and a version and no health content.
Neither becomes a back door to the record it refers to, because the record it refers to is gone.

### 3.4 Class S - Shared product and catalog facts.

These are facts about a **product**, not about a person. They may survive a household's deletion
**only once irreversibly de-linked from that household**, and the linkage itself is Class P.

| Table                    | What survives                        | What is purged                                                 |
| ------------------------ | ------------------------------------ | -------------------------------------------------------------- |
| `product_identity`       | The product                          | -                                                              |
| `marketed_formulation`   | The formulation                      | -                                                              |
| `formulation_ingredient` | The ingredient list                  | -                                                              |
| `batch_or_lot`           | The batch                            | -                                                              |
| `normalized_substance`   | The substance                        | -                                                              |
| `substance_alias`        | The alias                            | -                                                              |
| `catalog_conflict`       | The disagreement between two records | -                                                              |
| `field_assertion`        | The asserted field value             | `evidence_asset_id` de-linked (already `ON DELETE SET NULL`)   |
| `product_observation`    | The observation as a catalog fact    | **`contributed_by_user_id` and `evidence_asset_id` de-linked** |

**De-linking is not deletion and must be irreversible.** `product_observation.contributed_by_user_id`
is contributor linkage: personal, and purged. The observation may stay because a product having been
seen in a market is not a fact about the person who saw it. Setting the column to `NULL` is the
whole of the de-link, and there is no other column on that table from which the contributor can be
recovered.

### 3.5 Class E - External regulatory and source material.

**Outside personal-data deletion entirely.** These tables hold no personal data; they hold
snapshots of and derivations from published regulatory sources. They are governed by **licensing**
(`BLK-005`), not by a person's deletion request, and a deletion request neither reaches them nor
should.

`source_registry_entry`, `source_document`, `source_discovery_candidate`, `regulatory_rule_version`,
`product_regulatory_action`, `scientific_opinion_record`, `citation_gate_decision`,
`assessment_rule_version`.

A portable export therefore **references** these rather than redistributing them (section 5).

### 3.6 Class O - Staff and operational.

Not household personal data. Staff identity and reviewer workflow, retained on the operational
basis `13` and `10` describe, out of scope for a household deletion request.

`reviewer`, `publication_control`, `publication_request`, `publication_approval`, `shadow_run`,
`shadow_run_sample`, `replay_run`, `assessment_correction`, `schema_migration`.

**Two of these carry a household linkage and are therefore constrained:**

- `shadow_run_sample.owned_item_id` is a bare `uuid` with **no foreign key**, so it survives an
  item's purge holding a household item's identifier in a staff-readable table. It must be
  de-linked on purge (DEC-117; `DEV-056`).
- `assessment_correction` references `profile_assessment` with `ON DELETE RESTRICT`, so a
  correction **blocks** the purge of the assessment it corrects. Purge order must de-link the
  correction first.

---

## 4. Purging what is append-only, without weakening append-only

`audit_event` and `consent_receipt` are append-only by trigger (DEC-013) and grant no `DELETE` to
any role. That is the invariant that makes them worth having, and a 24-month retention limit needs
a way through it.

**The way through is a third role, not a widened grant.**

```
kynviora_app        ordinary user requests. No DELETE on either table. Unchanged.
kynviora_service    privileged server operations. No DELETE on either table. Unchanged.
kynviora_retention  may DELETE from these two tables, and only rows past the age gate.
```

`kynviora_retention` is `NOLOGIN`, holds no other grant on any table, and is not a member of
either other role. It cannot read a medicine, write an audit event, or delete a row that is not old
enough.

**Two independent gates, both enforced by the database:**

1. **RLS** - `FOR DELETE TO kynviora_retention USING (<timestamp> < now() - interval '24 months')`.
   A row inside the window is filtered, so the `DELETE` affects zero rows rather than failing.
2. **The trigger** - `forbid_mutation` still raises on every `UPDATE`, on every `DELETE` by any
   other role, and on a `DELETE` of a row inside the window even by the retention role. This is the
   backstop for anything that bypasses RLS, including the table owner and a superuser.

Gate 2 is what makes gate 1 more than a policy somebody can drop. A future migration that removed
the RLS policy would still hit the trigger; a future migration that removed the trigger would still
hit RLS. Removing both is a deliberate act that shows up as such in review.

**`UPDATE` is never permitted on these tables by anyone.** Retention is deletion of whole rows past
an age, not editing of history. Corrections supersede; they do not rewrite.

---

## 5. Portable export

A person may take a copy of what is held about them. `16` requires intentional action, a statement
of what is included, re-authentication, expiry, and an audit event that does not duplicate
sensitive content into logs.

**What the export contains**: their own records and the provenance of those records - every Class P
table above, scoped to the profiles they own, with the verification state and the source attribution
each record carries.

**What it does not contain**: the external material itself. Regulatory text, source documents and
scientific opinions are **referenced by identifier, title, publisher and retrieval date** and are
not copied into the artifact. `BLK-005` is open, redistribution terms per source are unreviewed, and
an export that shipped the snapshots would be redistribution decided by an engineer. A person's copy
of their own data is theirs; a regulator's document is not the product's to hand out.

**Lifetime**: 24 hours maximum, from generation. Not extendable.

---

## 6. Device-local data

Cleared **immediately**, without waiting for any server round trip, on:

- sign-out;
- loss of authorization (a caregiver whose grant was revoked, an account whose session was invalidated);
- account deletion.

"Cleared" means the encrypted store's contents and the offline journal, not merely the projection: a
queued write that can no longer be authorized must not sit on the device waiting to be refused.

---

## 7. Thresholds approved alongside this matrix

Not retention, but decided with it and recorded here so the numbers have one home:

| Threshold             | Value                       |
| --------------------- | --------------------------- |
| Recent changes window | 90 days                     |
| Review Inbox windows  | 180d / 14d / 30d            |
| Corroboration         | 3 independent source groups |

**The digest inherits rather than acquires a deadline.** `notification_digest` and
`notification_digest_entry` are a **derived projection of `alert_delivery`** and are purged from
it rather than on a clock of their own: an entry goes with the delivery it references, and the
digest goes once it has no entries left. That is deliberate - the alternative was inventing a
retention period for a summary, which would have been a threshold nobody approved sitting beside
a table of thresholds somebody did.

**Corroboration is never safety or legal truth on its own.** Three independent groups saying the
same thing is a reason to look; it is not a finding, and the Citation Gate remains fail-closed
regardless of how many groups agree.

---

## 8. How the purge is actually run

A deadline nothing enforces is an intention. This section says what enforces the ones above, what
it does when it goes wrong, and where it still falls short.

### 8.1 The worker

`services/worker` runs the sweep on a schedule. Three properties are what make it a deadline
rather than a cron line somebody hopes is still installed:

| Property                   | How                                                                                                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Durable schedule**       | "When is the next sweep due" is computed from `retention_run` in the database, not from a timer. A worker restarted every minute sweeps on schedule; one that was down for a week sweeps the moment it returns.   |
| **No overlap**             | A single-row lease (`retention_lease`), taken by conditional `UPDATE` and released in a `finally`. A worker that was killed holds it only until `expires_at`, so nothing needs unblocking by hand.                |
| **Per-category isolation** | Each of the seven categories runs in its own transaction and gets its own row in `retention_run_category`. One failing does not stop the others, and - the point - does not let the run be recorded as a success. |

**The run's outcome has four values and `PARTIAL` is not `SUCCEEDED`.** A sweep in which one
category raised has not kept the deadline for that category, and a job that reported success
because most of it worked is exactly how a table quietly stops being purged for a year.

**What a run records**: start, end, outcome, duration, categories attempted, categories failed,
rows purged, and per category the step that raised plus its five-character SQLSTATE. **Counts
only.** No driver message is stored, because `detail` on a Postgres error quotes the offending row
verbatim, and a retention job's output outlives the record it is about - it is the last place a
deleted medicine could come back.

**Privilege**: everything runs as `kynviora_retention` and nothing else. The worker gains no reach
into personal data that `0023` did not already give the role, and `kynviora_app` and
`kynviora_service` have no grant on any of the three worker tables.

### 8.2 How it is meant to be deployed, and how it is run today

Two arrangements, and only one of them can touch the development database:

| Arrangement                 | How                                          | When                                                                                                                                                                                  |
| --------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **In-process with the API** | `KYNVIORA_RETENTION=worker`                  | Today. PGlite is a single writer (DEC-037), so this is the only way anything sweeps the local database.                                                                               |
| **Its own process**         | `npm run worker`, against a managed Postgres | When `BLK-001` clears. The entry point exists and refuses a local data directory without an explicit override, because a second process on one PGlite directory overwrites the first. |

**There is no cloud scheduler, and this document does not pretend there is one.** No cron, no
queue, no orchestrator, no deployment. The worker is a long-running process that keeps its own
schedule from its own run history, which is the shape that works with or without one - and if a
scheduler is later put in front of it, the lease and the schedule make a duplicate invocation a
no-op rather than a second sweep.

**A production process must say which of the three is true.** `KYNVIORA_RETENTION` is `worker`,
`external` or `none`, it defaults to `none`, and a process that reaches production having said
nothing **refuses to start**. This is deliberate asymmetry with every other misconfiguration in the
system: a missing authenticator is loud because every request fails, whereas a missing sweep is
silent and stays silent until somebody asks why a table has grown. `KYNVIORA_ALLOW_UNSWEPT_START=1`
starts without retention on purpose, for the cases where that is genuinely right - a read-only
replica, a staging copy, a migration window - none of which should require pretending a sweep is
happening somewhere.

### 8.3 The gap that remains: the sweep interval is the overshoot

Recorded as `DEV-063` rather than left implicit.

Every eligibility floor above sits **exactly on** its deadline: `purge_floor()` is `now() - 30
days`, Visit Pack content becomes purgeable at `expires_at + 24 hours`, and so on. A discrete
sweep therefore purges a row somewhere in `[deadline, deadline + interval]`, and **no finite
interval makes the upper end of that equal the deadline.** Sweeping is discrete; the promise is
not.

So the interval is not a performance setting - it is the size of the gap between what this
document promises and what the system does. It is bounded in the only two ways available without
moving a security boundary:

- the default is **one hour**, so the overshoot is one hour on a thirty-day promise;
- the configured interval is **capped at 24 hours**, the shortest deadline in the matrix, because
  an interval longer than that could more than double the life of the content it governs.

Closing it properly means either a margin built into the floors themselves - purging at
`deadline - interval` so the promise is kept at the deadline rather than shortly after it - or a
continuous sweep. The first changes what the RLS policies admit, which is a change to the
security boundary and wants deciding rather than doing; the second does not exist. Neither is
attempted here, and the arithmetic is written down so that the choice is not made by whoever next
edits a default.

---

## 9. What is implemented, and what is not

Implementation status is tracked in `docs/autonomy/STATUS.md` and the deviations it names. This
document is the target; it does not claim the target has been reached.
