/**
 * GET  /api/accounts/[accountId]/estimates — list estimates (server-side filter + pagination)
 * POST /api/accounts/[accountId]/estimates — create a draft estimate (Idempotency-Key supported)
 *
 * Authorization: VIEW_ESTIMATES / MANAGE_ESTIMATES with account context.
 * Data access uses the service-role client AFTER permission checks; the
 * estimates tables have no anon/authenticated RLS policies by design.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withApiRoute } from '@/lib/server-guards';
import { Permission } from '@/lib/permissions';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import {
  createEstimateSchema,
  listEstimatesQuerySchema,
  validateQueryParams,
  validateRequestBody,
} from '@/lib/validation-schemas';
import {
  accountExists,
  createEstimate,
  findByIdempotencyKey,
  listEstimates,
} from '@/lib/estimate-service';
import { normalizeIdempotencyKey } from '@/lib/estimate-money';
import { serviceErrorResponse } from '@/lib/estimate-api';
import { logger } from '@/lib/debug-logger';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export const GET = withApiRoute(
  async (request: NextRequest, { params }) => {
    const accountId = params.accountId;
    const admin = createAdminSupabaseClient();
    if (!admin) {
      return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });
    }

    const rawParams = Object.fromEntries(request.nextUrl.searchParams.entries());
    const parsed = validateQueryParams(listEstimatesQuerySchema, rawParams);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const limit = Math.min(parsed.data.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = parsed.data.offset ?? 0;

    const result = await listEstimates(admin, accountId, {
      status: parsed.data.status,
      projectId: parsed.data.projectId,
      q: parsed.data.q,
      limit,
      offset,
    });

    if (result.error) {
      return serviceErrorResponse(result.error);
    }

    return NextResponse.json({
      success: true,
      estimates: result.data?.estimates ?? [],
      total: result.data?.total ?? 0,
      limit,
      offset,
    });
  },
  {
    permission: Permission.VIEW_ESTIMATES,
    getContext: (_req, params) => ({ accountId: params.accountId }),
  },
);

export const POST = withApiRoute(
  async (request: NextRequest, { user, params }) => {
    const accountId = params.accountId;
    const admin = createAdminSupabaseClient();
    if (!admin) {
      return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });
    }

    // Account must exist (override-permission users skip the membership check)
    const accountCheck = await accountExists(admin, accountId);
    if (accountCheck.error) {
      return serviceErrorResponse(accountCheck.error);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const validation = validateRequestBody(createEstimateSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // Idempotency-Key: optional, but when present retries are safe.
    let idempotencyKey: string | null = null;
    try {
      idempotencyKey = normalizeIdempotencyKey(request.headers.get('Idempotency-Key'));
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }

    if (idempotencyKey) {
      const existing = await findByIdempotencyKey(admin, accountId, idempotencyKey);
      if (existing.error) {
        return serviceErrorResponse(existing.error);
      }
      if (existing.data) {
        return NextResponse.json(
          { success: true, estimate: existing.data, replayed: true },
          { status: 200 },
        );
      }
    }

    const result = await createEstimate(admin, accountId, user.id, validation.data, idempotencyKey);

    if (result.error) {
      // Lost an idempotency race → return the winner instead of an error.
      if (result.error.kind === 'internal' && result.error.code === '23505' && idempotencyKey) {
        const winner = await findByIdempotencyKey(admin, accountId, idempotencyKey);
        if (winner.data) {
          return NextResponse.json(
            { success: true, estimate: winner.data, replayed: true },
            { status: 200 },
          );
        }
      }
      return serviceErrorResponse(result.error);
    }

    logger.info('Estimate created', {
      action: 'create_estimate',
      userId: user.id,
      accountId,
      estimateId: result.data?.id,
      idempotent: !!idempotencyKey,
    });

    return NextResponse.json({ success: true, estimate: result.data }, { status: 201 });
  },
  {
    permission: Permission.MANAGE_ESTIMATES,
    getContext: (_req, params) => ({ accountId: params.accountId }),
  },
);
