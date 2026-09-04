/**
 * The dose-capability judgements, run with nothing attached (DEC-102).
 *
 * The wrong answers these prevent are all one shape: a run that reports a scoped capability while
 * measuring something else. A policy that refuses everybody passes every refusal check and is a
 * total outage of `04` Phase 4.3; a screen that offers the new choice and files it under "viewing"
 * reproduces `DEV-049` under a new name; and a refusal reported with the wrong status code is the
 * API telling a stranger which items exist.
 */

import { describe, expect, it } from 'vitest';
import {
  capabilityOfferedCheck,
  doseControlCheck,
  grantContentsCheck,
  ownerRecordsCheck,
  recorderAdmittedCheck,
  reviewGroupingCheck,
  viewOnlyRefusedCheck,
} from './doseAccess.js';

describe('DOSE-0, the control', () => {
  it('fails when the owner cannot record on their own medicine', () => {
    // Not inconclusive. `has_capability` short-circuits on ownership, so this is the one path
    // migration 0021 could not have changed - and if it did, every refusal below is a policy that
    // refuses everybody rather than a capability doing its job.
    const check = doseControlCheck({ ownerWrite: 404, grantsBefore: 0 });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('refuses everybody');
  });

  it('is inconclusive when a grant from an earlier run is still active', () => {
    const check = doseControlCheck({ ownerWrite: 201, grantsBefore: 1 });
    expect(check.status).toBe('INCONCLUSIVE');
  });

  it('passes when the owner writes and the caregiver holds nothing', () => {
    expect(doseControlCheck({ ownerWrite: 201, grantsBefore: 0 }).status).toBe('PASS');
  });
});

describe('DOSE-1, the choice on the form', () => {
  it('fails when the form offers no way to grant it', () => {
    // The screen half of the split. Without a checkbox the only way to let somebody record a dose
    // is to grant "Edit medicines" as well, which is the over-granting the capability was added
    // to avoid - so a correct policy with no control is not a fix.
    const check = capabilityOfferedCheck({
      reachedForm: true,
      offeredLabels: ['Safety updates', 'Medicines', 'Edit medicines'],
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('over-granting');
  });

  it('fails when the narrow view-only choice disappeared instead', () => {
    // The other direction, and it is a real risk: replacing "Medicines" with "Record doses" would
    // pass a check written only for the new label while taking away the read-only grant.
    const check = capabilityOfferedCheck({
      reachedForm: true,
      offeredLabels: ['Record doses', 'Edit medicines'],
    });
    expect(check.status).toBe('FAIL');
  });

  it('is inconclusive when the form was never reached', () => {
    expect(capabilityOfferedCheck({ reachedForm: false, offeredLabels: null }).status).toBe(
      'INCONCLUSIVE',
    );
  });

  it('passes when both choices are offered separately', () => {
    expect(
      capabilityOfferedCheck({
        reachedForm: true,
        offeredLabels: ['Medicines', 'Record doses', 'Edit medicines'],
      }).status,
    ).toBe('PASS');
  });
});

describe('DOSE-2, where the review screen files it', () => {
  const CHANGE = 'They will be able to change';
  const SEE = 'They will be able to see';
  const SENTENCE =
    'They can record that a medicine was taken, skipped or missed, and add a correction if they ' +
    'get one wrong. Nothing already recorded can be removed.';

  it('fails when the sentence is drawn under "able to see"', () => {
    // `DEV-049` reproduced under a new capability name, which is the specific mistake this check
    // exists for: moving the write to its own capability and still describing it as viewing.
    const check = reviewGroupingCheck({ reachedReview: true, lines: [SEE, SENTENCE] });
    expect(check.status).toBe('FAIL');
  });

  it('fails when the review screen never describes the grant', () => {
    const check = reviewGroupingCheck({ reachedReview: true, lines: [CHANGE] });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('consent');
  });

  it('passes when the sentence follows the "able to change" heading', () => {
    expect(reviewGroupingCheck({ reachedReview: true, lines: [CHANGE, SENTENCE] }).status).toBe(
      'PASS',
    );
  });

  it('passes when both headings are on screen and the sentence is under the right one', () => {
    // The reason this is measured positionally. Both headings are drawn on the same screen when
    // the grant carries a view and a change, so a check for the words alone is answered by
    // whichever heading happens to be present.
    const check = reviewGroupingCheck({
      reachedReview: true,
      lines: [SEE, 'They can see the medicines recorded for this person.', CHANGE, SENTENCE],
    });
    expect(check.status).toBe('PASS');
  });

  it('is inconclusive when the review screen was never reached', () => {
    expect(reviewGroupingCheck({ reachedReview: false, lines: null }).status).toBe('INCONCLUSIVE');
  });
});

describe('DOSE-3, what the invitation carries', () => {
  it('fails when the invitation widened past what was ticked', () => {
    const check = grantContentsCheck({
      capabilities: ['RECORD_DOSES', 'VIEW_MEDICINES'],
      ticked: ['RECORD_DOSES'],
    });
    expect(check.status).toBe('FAIL');
  });

  it('passes when it carries exactly what was ticked, in any order', () => {
    expect(
      grantContentsCheck({
        capabilities: ['RECORD_DOSES', 'VIEW_MEDICINES'],
        ticked: ['VIEW_MEDICINES', 'RECORD_DOSES'],
      }).status,
    ).toBe('PASS');
  });
});

describe('DOSE-4, a view-only caregiver', () => {
  it('fails when the write is admitted', () => {
    // `DEV-049` itself, still open. Worth its own assertion because this is the exact state the
    // whole change is undoing, and a harness that could not tell would be measuring nothing.
    const check = viewOnlyRefusedCheck({ historyRead: 200, historyCount: 3, write: 201 });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('DEV-049');
  });

  it('fails when the read was taken away too', () => {
    // A fix that made the grant useless to the person holding it. The asymmetry between reading
    // and writing is the point of the capability model.
    const check = viewOnlyRefusedCheck({ historyRead: 200, historyCount: 0, write: 404 });
    expect(check.status).toBe('FAIL');
  });

  it('fails when the refusal names itself as a refusal', () => {
    // A 403 confirms the item exists to somebody who may not reach it, which `13` forbids - there
    // is deliberately no outcome in this API meaning "you are not allowed" (trap 89).
    const check = viewOnlyRefusedCheck({ historyRead: 200, historyCount: 3, write: 403 });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('404');
  });

  it('passes when they read the history and the write is a 404', () => {
    expect(viewOnlyRefusedCheck({ historyRead: 200, historyCount: 3, write: 404 }).status).toBe(
      'PASS',
    );
  });
});

describe('DOSE-5, the capability granted', () => {
  it('is inconclusive when the write already worked before it was granted', () => {
    // Granting something to a caller who could already do it measures the grant, not the policy.
    const check = recorderAdmittedCheck({ before: 201, after: 201, granted: true });
    expect(check.status).toBe('INCONCLUSIVE');
  });

  it('fails when the capability grants nothing', () => {
    // The failure mode where DOSE-4 passes for the wrong reason: a policy that refuses every
    // non-owner would report a scoped capability while having removed the feature.
    const check = recorderAdmittedCheck({ before: 404, after: 404, granted: true });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('removed rather');
  });

  it('passes when the same request flips from refused to admitted', () => {
    expect(recorderAdmittedCheck({ before: 404, after: 201, granted: true }).status).toBe('PASS');
  });
});

describe('DOSE-6, the owner on the device', () => {
  it('fails when the control is missing from the owner’s own row', () => {
    // The regression this change could most plausibly cause: the row now withholds the control on
    // a flag, and every way of getting that flag wrong ends with it missing for the one person
    // who was never the subject of the change.
    const check = ownerRecordsCheck({
      driven: true,
      controlPresent: false,
      before: 1,
      after: 1,
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('mayRecordDoses');
  });

  it('fails when the control is drawn and records nothing', () => {
    const check = ownerRecordsCheck({ driven: true, controlPresent: true, before: 2, after: 2 });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('worse than one that is withheld');
  });

  it('is inconclusive when the shelf was never driven', () => {
    // A launch that did not happen must never be described as something a screen did (trap 195).
    const check = ownerRecordsCheck({
      driven: false,
      controlPresent: false,
      before: null,
      after: null,
    });
    expect(check.status).toBe('INCONCLUSIVE');
  });

  it('passes when the control is there and the history grows', () => {
    expect(
      ownerRecordsCheck({ driven: true, controlPresent: true, before: 2, after: 3 }).status,
    ).toBe('PASS');
  });
});
