/**
 * What the agent is told about the screen, and the actions that screen offers it.
 *
 * Spec references: `17` (models propose; the agent's reach is the app's reach), `15` (a model's
 * output is untrusted), `14`, `16` (data minimisation), `18`, DEC-132, DEC-157.
 *
 * WHY A SNAPSHOT AND NOT "THE SCREEN"
 * V3 asks the agent to work in context: *"What am I looking at?"*, *"Show only toothpaste"*,
 * *"Open blood pressure"*. The naive way to do that is to hand the agent the screen's data, and
 * DEC-132 forbids exactly that - the agent gets tools and never data. `AgentTurnRequest` has no
 * field for a session, a token, a profile or any record content, and this must not become one by
 * a different name.
 *
 * So what travels is a **snapshot of identity, not of content**: which route is open, which
 * profile it is about, what is focused as an *identifier*, and how many things are selected. A
 * medicine's name, a lab value, a person's date of birth - none of it is here, and there is no
 * field it could arrive in.
 *
 * The design language states the property this is built to make true: *the panel footer always
 * shows the exact context snapshot that left the phone - route, profile, what is focused, what is
 * selected - because that is the whole of what was sent.* A footer can only say that honestly if
 * the snapshot **is** the whole of what was sent, which is why {@link describeScreenContext}
 * renders the same object the request carries rather than a summary of it.
 *
 * WHY THE ACTIONS ARE DECLARED BY THE SCREEN
 * "Show only toothpaste" is a change to a screen's own state, and there is no domain tool for it.
 * The alternative designs are both worse: a general "set state" tool would give a model arbitrary
 * reach into any component, and a hard-coded list of every filter in the app would put the
 * knowledge of what Shelf can do inside the agent.
 *
 * Instead a screen **offers** a small, named set of things it can do, the agent may only invoke
 * one of those names, and the screen's own handler performs it. That is the same shape as the tool
 * registry one level down: a closed set, declared by the side that can actually perform the work,
 * validated before anything runs.
 */

import { ownEntry } from '@kynviora/domain';

/**
 * The routes an agent can be told it is on.
 *
 * A closed set rather than a free string, because a route name is printed in the footer that
 * claims to show everything that was sent - and a free string is a channel. The five destinations
 * plus the surfaces reached from them.
 */
export const AGENT_ROUTES = [
  'TODAY',
  'SHELF',
  'HEALTH',
  'CARE',
  'YOU',
  'ITEM_DETAIL',
  'HEALTH_RECORD',
  'COVERAGE_CENTER',
  'CAMERA',
  'UNKNOWN',
] as const;
export type AgentRoute = (typeof AGENT_ROUTES)[number];

export function isAgentRoute(value: unknown): value is AgentRoute {
  return typeof value === 'string' && (AGENT_ROUTES as readonly string[]).includes(value);
}

/**
 * What the agent is told about where it is.
 *
 * Every field is an identifier, a count or a member of a closed set. Nothing here is content, and
 * there is deliberately no `title`, no `displayName` and no `text` field: those are the fields a
 * medicine name would arrive in.
 */
export interface ScreenContext {
  readonly route: AgentRoute;
  /** Which profile the screen is about, as an identifier. Never a name. */
  readonly profileId: string | null;
  /**
   * What is focused, as an identifier.
   *
   * An item id on a detail screen, a record id on a lab report. The agent uses it as an argument
   * to a tool; it never learns what the thing is called.
   */
  readonly focusId: string | null;
  /** How many things are selected. A count, not a list - a list of ids is still a list. */
  readonly selectedCount: number;
  /**
   * The named actions this screen can perform, in the order it offers them.
   *
   * The whole of what the agent may ask a screen to do. An action the screen did not declare is
   * refused before it reaches any handler.
   */
  readonly actions: readonly ScreenAction[];
}

/**
 * One thing a screen can do on request.
 *
 * `id` is what the agent names and is machine-readable; `label` is what a person is shown in the
 * panel and in the transcript, so the phrasing offered and the thing that happens are the same
 * sentence. `says` is what Kynviora reports afterwards - composed by the screen, which is what
 * lets it through the Speech Gate as a composed line rather than as something the agent wrote.
 */
export interface ScreenAction {
  readonly id: string;
  /** How the action is offered - the words a person would say or read. */
  readonly label: string;
  /** What Kynviora says once it has run. One sentence, in the app's own voice. */
  readonly says: string;
}

export function emptyScreenContext(): ScreenContext {
  return { route: 'UNKNOWN', profileId: null, focusId: null, selectedCount: 0, actions: [] };
}

/**
 * Render the snapshot as the sentence the panel footer shows.
 *
 * Built from the same object the request carries, field by field, so the claim the footer makes -
 * *this is the whole of what was sent* - is true by construction rather than by somebody keeping
 * two lists in step. A field added to {@link ScreenContext} and not to this function fails
 * `screenContext.test.ts`, which walks the object's own keys.
 */
export function describeScreenContext(context: ScreenContext): string {
  const parts = [
    `route ${context.route}`,
    `profile ${context.profileId ?? 'none'}`,
    `focused ${context.focusId ?? 'nothing'}`,
    `selected ${String(context.selectedCount)}`,
    `actions ${String(context.actions.length)}`,
  ];
  return parts.join(' · ');
}

/**
 * Whether a name the agent produced is one this screen actually offers.
 *
 * `15`: a model's output is untrusted and is validated against the registry regardless of which
 * provider produced it. This is that rule for screen actions, and the resolution is an own-property
 * lookup for the reason DEC-147 gives - a proposed action id of `constructor` must not resolve
 * through the prototype into something callable.
 */
export function resolveScreenAction(context: ScreenContext, actionId: string): ScreenAction | null {
  const byId: Record<string, ScreenAction> = Object.create(null) as Record<string, ScreenAction>;
  for (const action of context.actions) byId[action.id] = action;
  return ownEntry(byId, actionId);
}

/**
 * The phrasings this screen offers, for the panel to show.
 *
 * V3's panel carries "phrasings for this route" rather than a chat history, and this is where they
 * come from. A screen that declares no actions offers none, and the panel then says so - which is
 * an honest empty state and not a bug.
 */
export function screenPhrasings(context: ScreenContext): readonly string[] {
  return context.actions.map((action) => action.label);
}
