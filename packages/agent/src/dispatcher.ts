/**
 * The only thing that can run a tool, and every gate it puts in front of one.
 *
 * Spec references: `17` (models get no write tools; a proposal is checked, never trusted), `13`
 * (authority comes from the session), `14` (step-up), `11` (the server decides), `12` (offline is
 * a state), `15` (model output is untrusted input). DEC-132.
 *
 * SIX GATES, IN THIS ORDER, AND THE ORDER MATTERS
 *
 *  1. **Is it a tool?** An unknown name is refused before anything else is looked at, because
 *     everything after this reads a definition.
 *  2. **May voice reach it?** Before arguments, so a `TOUCH_ONLY` tool cannot be probed for what
 *     arguments it takes by watching which ones are rejected.
 *  3. **Do the arguments typecheck?** Strictly, including no extra keys.
 *  4. **Does the caller hold the capability?** As the **server** last reported it. This does not
 *     authorise anything - the route does that, every time, on the session (`11`, `13`) - it
 *     stops the agent offering something the write would refuse.
 *  5. **Is identity fresh enough, and is there a network?** Both are conditions of the moment
 *     rather than of the request.
 *  6. **Has this exact proposal been confirmed?** Last, because the summary a person confirms
 *     should describe a call that has already passed every other check.
 *
 * WHAT THIS FILE CANNOT DO
 * It has no database, no token and no route table. It holds a `ToolExecutor` - a set of functions
 * the app supplies, each of which calls the same `KynvioraClient` method a screen calls. That is
 * the whole of DEC-132: **the agent's reach is exactly the app's reach, because it is the app's
 * code doing the reaching.**
 */

import { toolNamed } from './registry.js';
import {
  validateArguments,
  type ToolCall,
  type ToolCapability,
  type ToolDefinition,
  type ToolOutcome,
} from './tools.js';

/**
 * What the app knows about the caller and the moment, as the server last said.
 *
 * Every field is a **report**, not a grant. `capabilities` is what the shelf and the item detail
 * already carry (`mayRecordDoses`, `mayEdit`, `mayDelete`); `stepUpFreshAt` is what the session
 * carries. Nothing here decides anything - it stops the agent proposing what the route would
 * refuse, which is the same job `mayRecordDoses` does on the shelf.
 */
export interface DispatchContext {
  /** Capabilities the server has reported for the profile in question. */
  readonly capabilities: ReadonlySet<ToolCapability>;
  /** Whether this caller owns the profile, which no caregiver capability substitutes for. */
  readonly isOwner: boolean;
  /** Whether identity was confirmed recently enough for `14`'s high-impact actions. */
  readonly stepUpFresh: boolean;
  readonly online: boolean;
  /** Where the call came from. A tool marked `TOUCH_ONLY` is refused for `VOICE`. */
  readonly origin: 'VOICE' | 'TOUCH';
  /** Whether this exact proposal has been confirmed by the person (`session.ts` releases it). */
  readonly confirmed: boolean;
}

/**
 * The functions that actually do the work.
 *
 * Supplied by the app, one per tool, each closing over the same `KynvioraClient` a screen uses.
 * A partial executor is normal and not an error: a tool with no executor is refused as `BLOCKED`,
 * which is what the extraction tools are today.
 */
export type ToolExecutor = Readonly<Partial<Record<string, (call: ToolCall) => Promise<unknown>>>>;

/**
 * Validate a proposal without running it.
 *
 * Separated from execution because a proposal has to be **described to a person before it
 * happens**, and describing something that would have been refused anyway wastes their time and
 * teaches them that confirming is a formality. The voice shell validates first, reads out the
 * summary, and only then confirms.
 */
export function checkCall(call: ToolCall, context: DispatchContext): ToolOutcome<ToolDefinition> {
  const tool = toolNamed(call.name);
  if (tool === null) {
    return { kind: 'REFUSED', refusal: 'UNKNOWN_TOOL', tool: null };
  }

  if (context.origin === 'VOICE' && tool.voice === 'TOUCH_ONLY') {
    return { kind: 'REFUSED', refusal: 'NOT_PERMITTED_BY_VOICE', tool };
  }

  const args = validateArguments(tool, call.arguments);
  if (!args.ok) {
    return { kind: 'REFUSED', refusal: args.refusal, tool, parameter: args.parameter };
  }

  if (!holdsCapability(tool.capability, context)) {
    return { kind: 'REFUSED', refusal: 'CAPABILITY_MISSING', tool };
  }

  if (tool.stepUp && !context.stepUpFresh) {
    return { kind: 'REFUSED', refusal: 'STEP_UP_REQUIRED', tool };
  }

  if (!context.online && tool.offline === 'ONLINE_ONLY') {
    return { kind: 'REFUSED', refusal: 'OFFLINE', tool };
  }

  if (tool.blockedBy !== null) {
    return { kind: 'REFUSED', refusal: 'BLOCKED', tool, blocker: tool.blockedBy };
  }

  return { kind: 'OK', tool, value: tool };
}

/**
 * Whether the caller holds what the tool asks for.
 *
 * `OWNER_ONLY` is not a capability anybody can be granted - it is the absence of every caregiver
 * path - so it is answered from `isOwner` rather than from the set. Reading it out of the set
 * would let a future caregiver capability named `OWNER_ONLY` satisfy it, which is the shape of
 * mistake DEC-116 was about.
 */
function holdsCapability(required: ToolCapability, context: DispatchContext): boolean {
  if (required === 'NONE') return true;
  if (required === 'OWNER_ONLY') return context.isOwner;
  return context.capabilities.has(required);
}

/**
 * Run a proposal, having checked it.
 *
 * Re-checks rather than trusting the caller to have called {@link checkCall} first. The two calls
 * are separated by a person deciding something, which takes seconds during which a session can
 * expire, a network can drop and a grant can be revoked - and re-checking is cheap.
 */
export async function dispatch(
  call: ToolCall,
  context: DispatchContext,
  executor: ToolExecutor,
): Promise<ToolOutcome> {
  const checked = checkCall(call, context);
  if (checked.kind === 'REFUSED') return checked;
  const tool = checked.tool;

  // Last, and only for the tools that ask for it. A confirmation is about a specific proposal and
  // `session.ts` is what establishes that; by the time it reaches here the only question left is
  // whether one happened at all.
  if (tool.confirmation === 'EXPLICIT' && !context.confirmed) {
    return { kind: 'REFUSED', refusal: 'CONFIRMATION_REQUIRED', tool };
  }

  const run = executor[tool.name];
  if (run === undefined) {
    // A tool with no executor is a capability this build does not have wired, which is the same
    // answer as a blocked one and deliberately not a crash. `blockedBy` is the honest identifier
    // where there is one.
    return {
      kind: 'REFUSED',
      refusal: 'BLOCKED',
      tool,
      ...(tool.blockedBy === null ? {} : { blocker: tool.blockedBy }),
    };
  }

  const value = await run(call);
  return { kind: 'OK', tool, value };
}
