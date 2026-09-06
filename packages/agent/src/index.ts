/**
 * `@kynviora/agent` - the Agent Tool Registry, and everything around it that is not a provider.
 *
 * Spec references: `17` (models propose; sources and validated records prove; rules and review
 * decide), `13`, `14`, `11`, `15`, `18`. DEC-132 to DEC-136, `BLK-012`.
 *
 * The shape, in one line:
 *
 *     speech -> agent -> a **proposal** -> six gates -> the app's own client -> result
 *            -> the Speech Gate -> spoken and shown, together
 *
 * Platform-neutral and pure, like `presentation` and `contracts`. Nothing here opens a socket,
 * touches a database, or knows what a React component is. The app supplies a `ToolExecutor` whose
 * functions call the same `KynvioraClient` methods its screens call, which is the whole of why
 * the agent cannot reach anything a person could not.
 */

export * from './tools.js';
export * from './registry.js';
export * from './session.js';
export * from './speech.js';
export * from './ports.js';
export * from './dispatcher.js';
export * from './scriptedAgent.js';
export * from './summary.js';
