import { describe, expect, it } from 'vitest';
import {
  TALK_BAR_STATES,
  talkBarIsVisible,
  talkBarPresentation,
  talkBarStateFor,
  type TalkBarState,
} from './talkBar.js';
import { emptySession, VOICE_STATES, type TurnOutcome, type VoiceState } from './session.js';

describe('the eight states', () => {
  it('gives every one a label and a sub-line', () => {
    // `18`: nothing rests on the animation. Every state has to be sayable.
    for (const state of TALK_BAR_STATES) {
      const p = talkBarPresentation(state);
      expect(p.label.length, state).toBeGreaterThan(0);
      expect(p.subline.length, state).toBeGreaterThan(0);
      expect(p.accessibilityLabel, state).toContain(p.label);
    }
  });

  it('says what happens next rather than repeating the label', () => {
    // The design language's rule, and the reason a sub-line exists at all. "Working" over
    // "Kynviora is working" is one idea printed twice.
    for (const state of TALK_BAR_STATES) {
      const p = talkBarPresentation(state);
      expect(p.subline.toLowerCase(), state).not.toBe(p.label.toLowerCase());
    }
  });

  it('never draws the bar in the action tone', () => {
    // `action` is a reviewed concern with a next step. A bar turning red because a sentence could
    // not be understood would be dramatising a refusal, which `02` refuses.
    for (const state of TALK_BAR_STATES) {
      expect(talkBarPresentation(state).tone, state).not.toBe('action');
    }
  });

  it('marks as live only the states where something is actually happening', () => {
    const live = TALK_BAR_STATES.filter((state) => talkBarPresentation(state).live);
    expect([...live].sort()).toEqual(['LISTENING', 'UNDERSTANDING', 'WORKING']);
  });

  it('offers a stop only while the person could still be talking', () => {
    // Not while working: a confirmed write is already in flight, and a stop that cannot stop it
    // would be a control that lies about what it does.
    const stoppable = TALK_BAR_STATES.filter((state) => talkBarPresentation(state).stoppable);
    expect([...stoppable].sort()).toEqual(['LISTENING', 'UNDERSTANDING']);
  });

  it('tells a person where to look after a refusal rather than apologising', () => {
    const p = talkBarPresentation('COULD_NOT');
    expect(p.subline).toContain('where the control is');
    expect(p.subline.toLowerCase()).not.toContain('sorry');
  });

  it('separates needing more information from being unable', () => {
    // "I cannot do that" ends the exchange; "which medicine did you mean" continues it. A bar
    // that said the first when it meant the second would stop somebody one word from success.
    expect(talkBarPresentation('NEEDS_MORE').label).toBe('Needs more information');
    expect(talkBarPresentation('COULD_NOT').label).toBe('Could not do that');
    expect(talkBarPresentation('NEEDS_MORE').tone).not.toBe(talkBarPresentation('COULD_NOT').tone);
  });

  it('falls back to idle for a state from outside the set', () => {
    // DEC-147.
    const rogue = talkBarPresentation('constructor' as TalkBarState);
    expect(rogue.state).toBe('IDLE');
    expect(rogue.label).toBe('Talk to Kynviora');
  });
});

describe('talkBarStateFor', () => {
  const session = (state: VoiceState, lastOutcome: TurnOutcome | null = null) => ({
    state,
    lastOutcome,
  });

  it('maps every voice state to a bar state', () => {
    // Total over the union, so a seventh voice state cannot leave the bar with nothing to show.
    for (const state of VOICE_STATES) {
      expect(TALK_BAR_STATES, state).toContain(talkBarStateFor(session(state)));
    }
  });

  it('reports what the conversation is doing while it is doing it', () => {
    expect(talkBarStateFor(session('LISTENING'))).toBe('LISTENING');
    expect(talkBarStateFor(session('THINKING'))).toBe('UNDERSTANDING');
    expect(talkBarStateFor(session('WORKING'))).toBe('WORKING');
    expect(talkBarStateFor(session('AWAITING_CONFIRMATION'))).toBe('NEEDS_CONFIRMATION');
  });

  it('does not report Done while a sentence is still being read out', () => {
    // `SPEAKING` is a turn in progress. Putting "Done" on the bar before the sentence it
    // summarises has finished would report an outcome the person has not been given.
    expect(talkBarStateFor(session('SPEAKING', 'COMPLETED'))).toBe('UNDERSTANDING');
  });

  it('reports the outcome only once the turn has ended', () => {
    expect(talkBarStateFor(session('IDLE', 'COMPLETED'))).toBe('DONE');
    expect(talkBarStateFor(session('IDLE', 'REFUSED'))).toBe('COULD_NOT');
    expect(talkBarStateFor(session('IDLE', 'NEEDS_MORE'))).toBe('NEEDS_MORE');
    expect(talkBarStateFor(session('IDLE', null))).toBe('IDLE');
  });

  it('ignores a stale outcome in every state that is not idle', () => {
    // The whole rule in one assertion: every turn passes through IDLE at its end, so an outcome
    // consulted anywhere else is the *previous* turn reported over the top of this one.
    for (const state of VOICE_STATES) {
      if (state === 'IDLE') continue;
      expect(talkBarStateFor(session(state, 'REFUSED')), state).not.toBe('COULD_NOT');
    }
  });

  it('starts a fresh session at rest', () => {
    expect(talkBarStateFor(emptySession(null))).toBe('IDLE');
  });
});

describe('talkBarIsVisible', () => {
  const context = {
    capturing: false,
    sheetOpen: false,
    selecting: false,
    confirming: false,
  };

  it('is on screen by default', () => {
    expect(talkBarIsVisible(context)).toBe(true);
  });

  it('leaves where the space belongs to the task', () => {
    // The three the design language names, plus the one it does not: a critical confirmation.
    // A bar offering a second way to act under a screen whose whole purpose is one decision is
    // `18`'s one-primary-action rule broken by furniture.
    expect(talkBarIsVisible({ ...context, capturing: true })).toBe(false);
    expect(talkBarIsVisible({ ...context, sheetOpen: true })).toBe(false);
    expect(talkBarIsVisible({ ...context, selecting: true })).toBe(false);
    expect(talkBarIsVisible({ ...context, confirming: true })).toBe(false);
  });
});
