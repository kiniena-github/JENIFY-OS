/**
 * CLAUDE provider lane.
 *
 * Claude executes through the existing GitHub workflow
 * (`.github/workflows/ai-task-trigger.yml`) and nowhere else, so this lane holds
 * exactly one capability: turning an already-canonical, already-approved,
 * CLAUDE-bound HQ task into the `[AI TASK][CLAUDE]` issue that workflow reads,
 * and reconciling the result back to that task.
 *
 * It adds no second Claude executor, no local Claude CLI path, and no authority:
 * every gate — classification, approval, provider binding, kill switch,
 * idempotency — is read from the canonical control plane, never re-implemented.
 */
export * from './transport.js';
export * from './dispatch.js';
export * from './connection.js';
