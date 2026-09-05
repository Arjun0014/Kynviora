import { describe, it, expect } from 'vitest';
import {
  dataRemovedCheck,
  deletionCompletedCheck,
  deletionRecordCheck,
  deletionWarningCheck,
  identityRemovedCheck,
  wrongPasswordDeletionCheck,
  type AccountRows,
} from './deleteAccount.js';
import { overallStatus } from './analysis.js';

/**
 * The account-deletion scenario's judgements, with no device attached (`DEV-062`).
 *
 * Spec references: `16`, `14`, `12`, `18`, DEC-102, DEC-117, DEC-120, DEC-125.
 *
 * WHY THESE ARE TESTED SEPARATELY FROM THE RUN
 * DEC-102's rule, and on this scenario it is not a formality. Two of the six checks assert that
 * **nothing changed** - which is exactly the shape that passes trivially when the evidence is
 * missing, and this is the one action in the app that cannot be undone. Each check is therefore
 * driven here with its evidence absent and has to answer `INCONCLUSIVE` rather than `PASS`.
 */

const SUBMIT = 'Sign in';
const REFUSAL = 'We could not delete your account';
const ITEM = 'Synthetic Tablet A';
const DELETE_SUBMIT = 'Delete my account';
const EMAIL = 'kynviora-delete-001@kynviora.test';

const LIVE: AccountRows = { accountStamped: false, profilesLive: 2, profilesStamped: 0 };
const CLOSED: AccountRows = { accountStamped: true, profilesLive: 0, profilesStamped: 2 };

describe('DEL-1 - what the screen says before it does anything', () => {
  const mustName = ['Everyone you have set up', 'Every dose you have recorded'];
  const retention = 'A record that an account was closed, and when.';
  const base = { mustName, retentionSentence: retention, submitLabel: DELETE_SUBMIT };

  it('passes when every consequence and the retention notice are on screen', () => {
    expect(
      deletionWarningCheck({ ...base, names: [DELETE_SUBMIT, ...mustName, retention] }).status,
    ).toBe('PASS');
  });

  it('fails when a consequence is not named, and says which', () => {
    // `18`. A confirmation that only asks "are you sure" leaves somebody to find out afterwards
    // that their dose history was in scope.
    const check = deletionWarningCheck({
      ...base,
      names: [DELETE_SUBMIT, mustName[0] as string, retention],
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('Every dose you have recorded');
  });

  it('fails when nothing says what is kept', () => {
    // DEC-117 keeps the record that a deletion happened for two years. A screen claiming
    // everything disappears would be untrue.
    expect(deletionWarningCheck({ ...base, names: [DELETE_SUBMIT, ...mustName] }).status).toBe(
      'FAIL',
    );
  });

  it('is inconclusive when the deletion screen was never opened', () => {
    // Its own control is absent, so the words that were read belong to some other screen.
    const check = deletionWarningCheck({ ...base, names: ['You', 'Sign out'] });
    expect(check.status).toBe('INCONCLUSIVE');
  });

  it('is inconclusive when the screen could not be read', () => {
    expect(deletionWarningCheck({ ...base, names: null }).status).toBe('INCONCLUSIVE');
  });
});

describe('DEL-2 - a wrong password', () => {
  const base = { refusalHeading: REFUSAL, signedInOnlyName: ITEM };

  it('passes when nothing was stamped and the screen said so', () => {
    expect(wrongPasswordDeletionCheck({ ...base, rowsAfter: LIVE, names: [REFUSAL] }).status).toBe(
      'PASS',
    );
  });

  it('fails when a wrong password closed the account', () => {
    // The failure this scenario exists for. `14` requires re-authentication on this action, and a
    // borrowed phone that can close somebody's account is the reason why.
    const check = wrongPasswordDeletionCheck({ ...base, rowsAfter: CLOSED, names: [REFUSAL] });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('wrong password');
  });

  it('fails when a refused attempt stamped profiles anyway', () => {
    expect(
      wrongPasswordDeletionCheck({
        ...base,
        rowsAfter: { accountStamped: false, profilesLive: 1, profilesStamped: 1 },
        names: [REFUSAL],
      }).status,
    ).toBe('FAIL');
  });

  it('fails when nothing was deleted and the screen said nothing', () => {
    expect(
      wrongPasswordDeletionCheck({ ...base, rowsAfter: LIVE, names: ['Your password'] }).status,
    ).toBe('FAIL');
  });

  it('is inconclusive when the rows could not be read', () => {
    // An unread database cannot show that nothing changed, and this check is entirely about that.
    expect(wrongPasswordDeletionCheck({ ...base, rowsAfter: null, names: [REFUSAL] }).status).toBe(
      'INCONCLUSIVE',
    );
  });
});

describe('DEL-3 - the phone afterwards', () => {
  const base = {
    submitLabel: SUBMIT,
    signedInOnlyName: ITEM,
    refusalHeading: REFUSAL,
  };

  it('passes when the sign-in screen is back with nothing behind it', () => {
    expect(deletionCompletedCheck({ ...base, names: [SUBMIT] }).status).toBe('PASS');
  });

  it('fails when the app is still showing an account that no longer exists', () => {
    expect(deletionCompletedCheck({ ...base, names: [ITEM] }).status).toBe('FAIL');
  });

  it('fails when household content survives on the sign-in screen', () => {
    // `12`: a deletion is the strongest form of "remove decrypted projections and caches".
    expect(deletionCompletedCheck({ ...base, names: [SUBMIT, ITEM] }).status).toBe('FAIL');
  });

  it('fails when the deletion was refused, rather than reading a refusal as a success', () => {
    expect(deletionCompletedCheck({ ...base, names: [REFUSAL] }).status).toBe('FAIL');
  });

  it('is inconclusive when the screen could not be read', () => {
    expect(deletionCompletedCheck({ ...base, names: null }).status).toBe('INCONCLUSIVE');
  });
});

describe('DEL-4 - the identity behind it', () => {
  it('passes when credentials that worked are now unknown', () => {
    expect(identityRemovedCheck({ identity: 'GONE', workedBefore: true }).status).toBe('PASS');
  });

  it('fails when the identity still authenticates', () => {
    expect(identityRemovedCheck({ identity: 'STILL_THERE', workedBefore: true }).status).toBe(
      'FAIL',
    );
  });

  it('is inconclusive without the positive control', () => {
    // Otherwise this is an absence test over credentials that may never have worked at all.
    expect(identityRemovedCheck({ identity: 'GONE', workedBefore: false }).status).toBe(
      'INCONCLUSIVE',
    );
    expect(identityRemovedCheck({ identity: 'GONE', workedBefore: null }).status).toBe(
      'INCONCLUSIVE',
    );
  });

  it('is inconclusive when the provider could not be asked', () => {
    expect(identityRemovedCheck({ identity: 'UNREADABLE', workedBefore: true }).status).toBe(
      'INCONCLUSIVE',
    );
  });
});

describe('DEL-5 - what is left in the database', () => {
  it('passes when the account and every profile under it are stamped', () => {
    expect(dataRemovedCheck({ rowsBefore: LIVE, rowsAfter: CLOSED }).status).toBe('PASS');
  });

  it('fails when a profile is still live under a closed account', () => {
    // DEC-120's half-deletion: a row the sweep can still see and nobody can still reach.
    const check = dataRemovedCheck({
      rowsBefore: LIVE,
      rowsAfter: { accountStamped: true, profilesLive: 1, profilesStamped: 1 },
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('part-way');
  });

  it('fails when the account is not stamped at all', () => {
    expect(dataRemovedCheck({ rowsBefore: LIVE, rowsAfter: LIVE }).status).toBe('FAIL');
  });

  it('fails when the account row was hard-deleted instead of stamped', () => {
    // DEC-117 retains the record. A row that vanished took the retention with it.
    const check = dataRemovedCheck({
      rowsBefore: LIVE,
      rowsAfter: { accountStamped: null, profilesLive: 0, profilesStamped: 0 },
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('hard-deleted');
  });

  it('is inconclusive when the account owned nothing to begin with', () => {
    // Stamping "everything" is trivially true over an account with nothing under it.
    expect(
      dataRemovedCheck({
        rowsBefore: { accountStamped: false, profilesLive: 0, profilesStamped: 0 },
        rowsAfter: CLOSED,
      }).status,
    ).toBe('INCONCLUSIVE');
  });

  it('is inconclusive without both sides', () => {
    expect(dataRemovedCheck({ rowsBefore: null, rowsAfter: CLOSED }).status).toBe('INCONCLUSIVE');
    expect(dataRemovedCheck({ rowsBefore: LIVE, rowsAfter: null }).status).toBe('INCONCLUSIVE');
  });
});

describe('DEL-6 - the record that outlives the account', () => {
  const base = { email: EMAIL };

  it('passes when the deletion is recorded and no row names the person', () => {
    expect(
      deletionRecordCheck({
        ...base,
        actions: ['account.registered', 'account.deleted', 'account.identity_removed'],
        details: ['{"email_verified":true}', '{"profile_count":2}', '{"outcome":"REMOVED"}'],
      }).status,
    ).toBe('PASS');
  });

  it('fails when nothing recorded that a deletion happened', () => {
    // `16` retains that record for twenty-four months, and without it there is no way to show a
    // deletion was carried out - which is the whole reason for the retention.
    expect(
      deletionRecordCheck({ ...base, actions: ['account.registered'], details: ['{}'] }).status,
    ).toBe('FAIL');
  });

  it('fails when the address survives in a row that outlives it', () => {
    // The audit log is the one place a purged identifier can come back from. The record of a
    // deletion must not become a description of whose.
    const check = deletionRecordCheck({
      ...base,
      actions: ['account.deleted'],
      details: [`{"email":"${EMAIL}"}`],
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('outlive');
  });

  it('is inconclusive when the audit rows could not be read', () => {
    expect(deletionRecordCheck({ ...base, actions: null, details: null }).status).toBe(
      'INCONCLUSIVE',
    );
  });
});

describe('the run as a whole', () => {
  it('is not successful with an inconclusive check in it', () => {
    // The rule that makes every "nothing changed" check above worth writing: a run that could not
    // look is not a run that looked and found nothing.
    expect(
      overallStatus([
        deletionCompletedCheck({
          names: [SUBMIT],
          submitLabel: SUBMIT,
          signedInOnlyName: ITEM,
          refusalHeading: REFUSAL,
        }),
        identityRemovedCheck({ identity: 'GONE', workedBefore: null }),
      ]),
    ).not.toBe('PASS');
  });
});
