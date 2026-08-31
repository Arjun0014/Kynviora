import { describe, it, expect } from 'vitest';
import {
  ALL_REVIEW_INBOX_STRINGS,
  ALL_REVIEW_TASK_STRINGS,
  INBOX_EMPTY,
  INBOX_LIMITATION,
  REVIEW_INBOX_COPY,
  REVIEW_TASK_DESCRIPTIONS,
  REVIEW_TASK_TONES,
  describeReviewTask,
  everyReviewKindDescribed,
  summarizeInbox,
} from './reviewInbox.js';
import { findForbiddenClaims } from './copy.js';
import { presentUrgency } from './status.js';
import { ACTION_URGENCIES, REVIEW_TASK_KINDS } from '@kynviora/domain';

describe('a review task never looks like an alert', () => {
  it('uses none of the tones an alert uses for actionable urgency', () => {
    // Exit criterion 1 where it is most easily lost: the domain keeps the two apart, and then a
    // screen renders both as cards with a coloured border and they become indistinguishable.
    const alertTones = new Set(
      ACTION_URGENCIES.filter((u) => u !== 'LOW' && u !== 'INFORMATIONAL').map(
        (u) => presentUrgency(u).tone,
      ),
    );
    expect(alertTones.size).toBeGreaterThan(0);
    for (const tone of REVIEW_TASK_TONES) {
      expect(alertTones.has(tone)).toBe(false);
    }
  });

  it('gives every kind one of the permitted tones', () => {
    for (const kind of REVIEW_TASK_KINDS) {
      expect(REVIEW_TASK_TONES).toContain(describeReviewTask(kind).tone);
    }
  });

  it('describes every kind, so none can reach a screen without words', () => {
    expect(everyReviewKindDescribed()).toBe(true);
  });

  it('never describes a task as a hazard', () => {
    // A missing batch number is not a hazard, it is a gap in what Kynviora can check. Scoped to
    // the task descriptions on purpose: the framing copy legitimately says "none of this is
    // urgent", which is the opposite claim and must stay sayable.
    for (const text of ALL_REVIEW_TASK_STRINGS) {
      expect(text).not.toMatch(/\b(danger|dangerous|hazard|unsafe|risk|warning|alert|urgent)\b/i);
    }
  });

  it('carries no urgency or evidence vocabulary in its copy', () => {
    for (const text of ALL_REVIEW_INBOX_STRINGS) {
      expect(text).not.toMatch(/\b(critical|high priority|severity|evidence level)\b/i);
    }
  });
});

describe('the inbox summary', () => {
  const tasks = [
    { taskId: 't1', kind: 'BATCH_MISSING' as const, subjectLabel: 'Synthetic Tablet A' },
    {
      taskId: 't2',
      kind: 'ITEM_NOT_REVIEWED_RECENTLY' as const,
      subjectLabel: 'Synthetic Tablet A',
    },
  ];

  it('renders a line per task with its own words', () => {
    const summary = summarizeInbox(tasks);
    expect(summary.total).toBe(2);
    expect(summary.lines.map((l) => l.label)).toEqual([
      REVIEW_TASK_DESCRIPTIONS.BATCH_MISSING.label,
      REVIEW_TASK_DESCRIPTIONS.ITEM_NOT_REVIEWED_RECENTLY.label,
    ]);
  });

  it('preserves the order it was given rather than ranking by implied severity', () => {
    // Ranking maintenance work by importance is how the inbox would start to look like an alert
    // list. The API supplies oldest first and the view keeps it.
    const reversed = summarizeInbox([...tasks].reverse());
    expect(reversed.lines.map((l) => l.taskId)).toEqual(['t2', 't1']);
  });

  it('states the limitation on every render, not only when empty', () => {
    expect(summarizeInbox(tasks).limitation).toBe(INBOX_LIMITATION);
    expect(summarizeInbox([]).limitation).toBe(INBOX_LIMITATION);
  });

  it('says an empty inbox is empty, without claiming everything is fine', () => {
    // The misreading this heads off is "nothing here, so nothing is wrong" - a much larger claim
    // than the one the list can support.
    const summary = summarizeInbox([]);
    expect(summary.emptyMessage).toBe(INBOX_EMPTY);
    expect(summary.emptyMessage).not.toMatch(
      /all (good|clear|fine)|nothing is wrong|you are safe/i,
    );
    expect(summary.limitation).toMatch(/not a safety check/i);
  });

  it('adds no empty message when there is work to show', () => {
    expect(summarizeInbox(tasks).emptyMessage).toBeNull();
  });

  it('passes the subject label through without inventing one', () => {
    const summary = summarizeInbox([{ taskId: 't1', kind: 'BATCH_MISSING', subjectLabel: null }]);
    expect(summary.lines[0]?.subjectLabel).toBeNull();
  });
});

describe('copy', () => {
  it('contains no forbidden claim', () => {
    for (const text of ALL_REVIEW_INBOX_STRINGS) {
      expect(findForbiddenClaims(text)).toEqual([]);
    }
  });

  it('says out loud that none of it is urgent', () => {
    expect(REVIEW_INBOX_COPY.intro).toMatch(/none of this is urgent/i);
  });

  it('tells the user that completing a task changes their records', () => {
    // The user-facing statement of exit criterion 2. Someone expecting a tick box needs to know
    // why the screen is asking for something.
    expect(REVIEW_INBOX_COPY.completionRequiresChange).toMatch(/updates your records/i);
    expect(REVIEW_INBOX_COPY.completionRequiresChange).toMatch(/not keep a separate tick list/i);
  });

  it('describes "does not apply" as being recorded, not as being ignored', () => {
    expect(REVIEW_INBOX_COPY.notApplicableMeaning).toMatch(/record/i);
    expect(REVIEW_INBOX_COPY.dismissedNote).toMatch(/recorded/i);
  });

  it('does not shame the user for the work existing', () => {
    for (const text of ALL_REVIEW_INBOX_STRINGS) {
      expect(text).not.toMatch(/\b(failed|forgot|neglect|overdue|behind|you should have)\b/i);
    }
  });

  it('keeps every sentence short enough to read on a phone', () => {
    for (const text of ALL_REVIEW_INBOX_STRINGS) {
      for (const sentence of text.split(/(?<=\.)\s+/)) {
        expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(22);
      }
    }
  });

  it('gives every task an action label that names the work', () => {
    for (const kind of REVIEW_TASK_KINDS) {
      const description = describeReviewTask(kind);
      expect(description.actionLabel.length).toBeGreaterThan(0);
      // Not "Done" or "Dismiss": the control performs a change, and the label should say so.
      expect(description.actionLabel).not.toMatch(/^(done|ok|dismiss|clear)$/i);
    }
  });
});
