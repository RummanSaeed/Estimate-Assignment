/**
 * GET    /api/accounts/[accountId]/estimates/[estimateId] — fetch one estimate
 * PATCH  /api/accounts/[accountId]/estimates/[estimateId] — update a DRAFT estimate
 * DELETE /api/accounts/[accountId]/estimates/[estimateId] — soft-delete a DRAFT estimate
 *
 * Every handler scopes queries by BOTH estimate id and account id, so an
 * estimate from another account is indistinguishable from a missing one (404).
 */

import { NextRequest, NextResponse } from 'next/server';
import { withApiRoute } from '@/lib/server-guards';
import { Permission } from '@/lib/permissions';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import {
  updateEstimateSchema,
  validateRequestBody,
} from '@/lib/validation-schemas';
import {
  getEstimate,
  softDeleteEstimate,
  updateDraftEstimate,
} from '@/lib/estimate-service';
import { serviceErrorResponse } from '@/lib/estimate-api';
import { logger } from '@/lib/debug-logger';

function accountContext(_req: NextRequest, params: Record<string, string>) {
  return { accountId: params.accountId };
}

export const GET = withApiRoute(
  async (_request: NextRequest, { params }) => {
    const admin = createAdminSupabaseClient();
    if (!admin) {
      return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });
    }

    const result = await getEstimate(admin, params.accountId, params.estimateId);
    if (result.error) {
      return serviceErrorResponse(result.error);
    }
    if (!result.data) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, estimate: result.data });
  },
  { permission: Permission.VIEW_ESTIMATES, getContext: accountContext },
);

export const PATCH = withApiRoute(
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

    const validation = validateRequestBody(updateEstimateSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const result = await updateDraftEstimate(
      admin,
      params.accountId,
      params.estimateId,
      user.id,
      validation.data,
    );

    if (result.error) {
      return serviceErrorResponse(result.error);
    }

    logger.info('Estimate updated', {
      action: 'update_estimate',
      userId: user.id,
      accountId: params.accountId,
      estimateId: params.estimateId,
    });

    return NextResponse.json({ success: true, estimate: result.data });
  },
  { permission: Permission.MANAGE_ESTIMATES, getContext: accountContext },
);

export const DELETE = withApiRoute(
  async (_request: NextRequest, { user, params }) => {
    const admin = createAdminSupabaseClient();
    if (!admin) {
      return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });
    }

    const result = await softDeleteEstimate(
      admin,
      params.accountId,
      params.estimateId,
      user.id,
    );

    if (result.error) {
      return serviceErrorResponse(result.error);
    }

    logger.info('Estimate soft-deleted', {
      action: 'delete_estimate',
      userId: user.id,
      accountId: params.accountId,
      estimateId: params.estimateId,
    });

    return NextResponse.json({ success: true, id: result.data?.id });
  },
  { permission: Permission.MANAGE_ESTIMATES, getContext: accountContext },
);
