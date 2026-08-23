import type { FastifyInstance } from 'fastify';
import type { GrowthTier } from '@factoryos/shared/sectors';
import type { Db } from '../db/index.js';
import { requireCtx } from '../app.js';
import { requirePermission } from '../services/permissions.js';
import {
  listSectors,
  recommendConfiguration,
  growthPreview,
  type OnboardingAnswers,
} from '../services/onboarding.js';

/**
 * Onboarding routes (§23). PREVIEW-ONLY over HTTP: the resolver recommends a
 * complete configuration and the caller sees exactly what would be created
 * before anything happens. PROVISIONING is deliberately NOT exposed as a
 * runtime route — it publishes a global sector layer, which requires a system
 * context (provisioning CLI / seed), matching the template-engine governance
 * rule that a tenant user can never publish platform artifacts.
 */
export function registerOnboardingRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/onboarding/sectors', async (req) => {
    requireCtx(db, req);
    return { sectors: listSectors() };
  });

  app.post<{ Body: OnboardingAnswers }>('/api/onboarding/recommend', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'settings', 'view');
    return recommendConfiguration(db, req.body);
  });

  app.get<{ Querystring: { sectorId: string; from?: GrowthTier; to?: GrowthTier } }>(
    '/api/onboarding/growth',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'settings', 'view');
      return {
        adds: growthPreview(req.query.sectorId, req.query.from ?? 'micro', req.query.to ?? 'medium'),
      };
    },
  );
}
