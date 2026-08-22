import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { requireCtx } from '../app.js';
import { writeAudit } from '../services/audit.js';
import { AppError } from '../util.js';
import {
  answerIntent,
  matchIntent,
  availableIntents,
  listIntentCatalog,
  type IntentParams,
} from '../services/ai.js';

/**
 * JENIFY AI (read-only, v0). The assistant answers ONLY through the typed
 * intent catalog in services/ai.ts — never raw SQL, never a DB handle. Every
 * intent enforces its own permissions and derives tenant scope from the session
 * ctx. The route adds one more guarantee the mission requires: EVERY invocation
 * is audited (auditable tool invocation), including refusals.
 */
export function registerAssistantRoutes(app: FastifyInstance, db: Db): void {
  // command palette — the intents THIS user may actually run
  app.get('/api/assistant/intents', async (req) => {
    const ctx = requireCtx(db, req);
    return { available: availableIntents(ctx), catalog: listIntentCatalog() };
  });

  app.post<{ Body: { intentId?: string; utterance?: string; params?: IntentParams } }>(
    '/api/assistant/ask',
    async (req) => {
      const ctx = requireCtx(db, req);
      let intentId = req.body.intentId;
      let params = req.body.params ?? {};

      // natural-language path: deterministic local matcher, never an LLM guess
      if (!intentId && req.body.utterance) {
        const match = matchIntent(req.body.utterance);
        if (match.kind !== 'match') {
          writeAudit(ctx, {
            module: 'dashboard',
            action: 'assistant_query',
            entity: 'assistant',
            summary: `AI ${match.kind}: "${req.body.utterance.slice(0, 120)}"`,
            result: 'blocked',
          });
          return match; // clarify | unsupported — surfaced verbatim, no guessing
        }
        intentId = match.intentId;
        params = { ...match.params, ...params };
      }
      if (!intentId) throw new AppError(400, 'assistant_intent', 'An intentId or utterance is required');

      try {
        const answer = answerIntent(ctx, intentId, params);
        writeAudit(ctx, {
          module: 'dashboard',
          action: 'assistant_query',
          entity: 'assistant',
          reference: intentId,
          summary: `AI answered '${intentId}' (${answer.status}${answer.financialMasked ? ', financial masked' : ''})`,
          result: 'success',
        });
        return answer;
      } catch (err) {
        // audit the refusal too (permission denied / unknown intent)
        writeAudit(ctx, {
          module: 'dashboard',
          action: 'assistant_query',
          entity: 'assistant',
          reference: intentId,
          summary: `AI refused '${intentId}': ${err instanceof AppError ? err.code : 'error'}`,
          result: 'blocked',
        });
        throw err;
      }
    },
  );
}
