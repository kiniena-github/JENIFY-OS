/**
 * How the Direct Order CLI reports what it just did (issue #224).
 *
 * A pure formatter in its own module for one reason: `cli/direct-order.ts`
 * calls `main()` at import time, so nothing in it can be imported by a test,
 * and the receipt wording is exactly the kind of thing that goes quietly wrong.
 * It already had: the created-order line formatted `route.resolved`, which
 * means "can dispatch right now" and is null for a blocked order, so the CLI
 * announced `AUTO → null` as the route an order had gone to — the same defect
 * Codex found in `defaultTitle`, surviving in the interface #200 relies on
 * until a browser authentication boundary exists.
 *
 * The rule this encodes: name the BOUND provider, and never report a blocked
 * order as though it were on its way.
 */

import type { DirectOrderReceipt } from '../live/orders.js';

export interface OrderReceiptContext {
  capabilityId: string;
  /** The principal id the order was ASSERTED as. Never authenticated. */
  requestedBy: string;
}

/**
 * The lines the CLI prints for a successful submission, in order.
 *
 * Returns them rather than printing them, so the wording is a tested property
 * instead of a claim about a console call.
 */
export function formatOrderReceipt(
  receipt: DirectOrderReceipt,
  context: OrderReceiptContext,
): string[] {
  const { task, classification, deduplicated, route, idempotencyKey } = receipt;
  const lines = [
    deduplicated ? 'Matched an existing identical order.' : 'Order created.',
    `  task:        ${task.id}`,
    `  capability:  ${context.capabilityId} (${classification.riskClass})`,
    `  status:      ${task.status}`,
    // The BOUND provider, never `route.resolved`.
    `  route:       ${route.requested} → ${receipt.boundProvider}`,
    `  dispatch:    ${receipt.dispatchBlocked ? 'BLOCKED — NOT CONNECTED' : 'ready'}`,
    `  idempotency: ${idempotencyKey}`,
    `  actor:       ${context.requestedBy} (asserted locally, NOT authenticated)`,
  ];

  if (receipt.dispatchBlocked) {
    // Said plainly. A bare "Order created." over an order that cannot move is
    // precisely the misreport this issue exists to close — and the routing
    // lane's own reason is repeated verbatim rather than softened.
    lines.push('', route.reason);
    lines.push(
      'The canonical order EXISTS and is recorded — it is not lost — but nothing will dispatch ' +
        'it until that provider can be reached. No other provider was substituted.',
    );
  }

  lines.push(
    classification.requiresApproval
      ? `\nThis order executes NOTHING until a Founder approves that exact action by digest.\n` +
          `And ${context.requestedBy} cannot be that Founder: the canonical no-self-approval rule ` +
          `refuses an approval by the principal the task was opened as.`
      : '\nThis order runs under standing policy.',
  );
  return lines;
}
