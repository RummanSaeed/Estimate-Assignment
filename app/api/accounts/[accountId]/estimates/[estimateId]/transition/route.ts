/**
 * POST /api/accounts/[accountId]/estimates/[estimateId]/transition
 * Body: { toStatus: 'sent' | 'accepted' | 'rejected', note?: string }
 *
 * Enforces the lifecycle state machine (draft → sent → accepted|rejected)
 * and requires SEND_ESTIMATES — the permission that gates client-facing
 * financial commitments.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withApiRoute } from '@/lib/server-guards';
import { Permission } from '@/lib/permissions';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import {
  estimateTransitionSchema,
  validateRequestBody,
} from '@/lib/validation-schemas';
import { transitionEstimate, type EstimateStatus } from '@/lib/estimate-service';
import { serviceErrorResponse } from '@/lib/estimate-api';
import { logger } from '@/lib/debug-logger';

export const POST = withApiRoute(
  async (request: NextRequest, { user, params }) => {
    const admin = createAdminSupabaseClient();
    if (!admin) {
      return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const validation = validateRequestBody(estimateTransitionSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const result = await transitionEstimate(
      admin,
      params.accountId,
      params.estimateId,
      user.id,
      validation.data.toStatus as EstimateStatus,
      validation.data.note ?? null,
    );

    if (result.error) {
      return serviceErrorResponse(result.error);
    }

    logger.info('Estimate transitioned', {
      action: 'transition_estimate',
      userId: user.id,
      accountId: params.accountId,
      estimateId: params.estimateId,
      toStatus: validation.data.toStatus,
    });

    return NextResponse.json({ success: true, estimate: result.data });
  },
  {
    permission: Permission.SEND_ESTIMATES,
    getContext: (_req, params) => ({ accountId: params.accountId }),
  },
);
