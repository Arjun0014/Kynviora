/**
 * The rule, and then the app measured against it.
 *
 * The last two tests read the real `PendingSenders.tsx`, which nothing else in this suite does.
 * `apps/**` is outside the test run and outside the lint run, so without this the only thing
 * standing between a sender for `caregiver_grant` and a revoked person's queued changes going out
 * is a refusal in a provider that somebody could relax for an unrelated reason.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registeredSenderTypes, senderPolicyFailures } from './queueableSenders.js';

const SENDERS = join(process.cwd(), 'apps', 'mobile', 'src', 'sync', 'PendingSenders.tsx');

describe('reading the registrations', () => {
  it('finds each type a sender is registered for', () => {
    const source =
      "registerSender('medicine_schedule', async (op) => x);\n" +
      "  registerSender( 'dose_event' , async (op) => y);\n";
    expect(registeredSenderTypes(source)).toEqual(['medicine_schedule', 'dose_event']);
  });

  it('finds nothing in a file that registers nothing', () => {
    expect(registeredSenderTypes('const registerSender = 1;\n')).toEqual([]);
  });
});

describe('what the policy allows a journal to carry', () => {
  it('accepts the types whose conflict policy is not SERVER_WINS', () => {
    expect(
      senderPolicyFailures(['medicine_schedule', 'owned_item', 'dose_event', 'allergy_record']),
    ).toEqual([]);
  });

  it('refuses a sender for an authorization table', () => {
    // The one this check exists for. `11` and `12` make authorization server-authoritative, and a
    // queued grant is a person shown as having access on the strength of nothing.
    const failures = senderPolicyFailures(['caregiver_grant']);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('SERVER_WINS');
  });

  it('refuses a sender for a safety table', () => {
    expect(senderPolicyFailures(['profile_assessment'])).toHaveLength(1);
    expect(senderPolicyFailures(['alert_publication'])).toHaveLength(1);
  });

  it('refuses a type the journal does not have', () => {
    // The journal stores the string it was given, so a typo is a row written and never sent.
    const failures = senderPolicyFailures(['medicine_schedules']);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('not a sync entity type');
  });

  it('refuses the same type registered twice', () => {
    const failures = senderPolicyFailures(['dose_event', 'dose_event']);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('dead code');
  });
});

describe('the app', () => {
  const source = readFileSync(SENDERS, 'utf8');

  it('registers senders at all, so a pass is not a pass over nothing', () => {
    // The absence test that makes the next one mean something (DEC-102). A moved or renamed file
    // would otherwise report a clean app by finding no senders at all.
    expect(registeredSenderTypes(source).length).toBeGreaterThanOrEqual(3);
  });

  it('registers a sender only for a type the conflict policy allows to be queued', () => {
    expect(senderPolicyFailures(registeredSenderTypes(source))).toEqual([]);
  });
});
