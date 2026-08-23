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
import {
  previewAction,
  executeAction,
  listActionCatalog,
} from '../services/aiActions.js';
import {
  sectorContext,
  sectorRefusal,
  sectorCapabilityStatement,
} from '../services/aiSector.js';

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

  /** What business is this assistant inside, and what may it do here? */
  app.get('/api/assistant/context', async (req) => {
    const ctx = requireCtx(db, req);
    return { context: sectorContext(ctx), statement: sectorCapabilityStatement(ctx) };
  });

  // action catalog (what the AI CAN do, with risk/executable flags)
  app.get('/api/assistant/actions', async (req) => {
    requireCtx(db, req);
    return { catalog: listActionCatalog() };
  });

  // PREVIEW an action — side-effect free; returns a confirmation token for
  // executable (draft) actions. Permission is enforced inside previewAction.
  app.post<{ Body: { actionId: string; params?: Record<string, unknown> } }>(
    '/api/assistant/action/preview',
    async (req) => {
      const ctx = requireCtx(db, req);
      return previewAction(ctx, req.body.actionId, req.body.params ?? {});
    },
  );

  // EXECUTE an action — requires the matching preview's confirmation token.
  app.post<{ Body: { actionId: string; params?: Record<string, unknown>; confirmationToken?: string } }>(
    '/api/assistant/action/execute',
    async (req) => {
      const ctx = requireCtx(db, req);
      return executeAction(ctx, req.body.actionId, req.body.params ?? {}, {
        confirmationToken: req.body.confirmationToken,
      });
    },
  );

  app.post<{ Body: { intentId?: string; utterance?: string; params?: IntentParams } }>(
    '/api/assistant/ask',
    async (req) => {
      const ctx = requireCtx(db, req);
      let intentId = req.body.intentId;
      let params = req.body.params ?? {};

      // SECTOR GUARD FIRST (§27): some sectors forbid whole classes of question
      // outright (clinical advice, deciding a citizen case, dosing guidance).
      // This runs before intent matching so nothing downstream can bypass it.
      if (req.body.utterance) {
        const refusal = sectorRefusal(ctx, req.body.utterance);
        if (refusal) {
          writeAudit(ctx, {
            module: 'dashboard',
            action: 'assistant_query',
            entity: 'assistant',
            reference: refusal.sectorId,
            summary: `AI refused (sector limit): ${refusal.limit}`,
            result: 'blocked',
          });
          return refusal;
        }
      }

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
