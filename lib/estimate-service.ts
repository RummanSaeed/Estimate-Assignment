/**
 * Estimate persistence layer.
 *
 * All functions take an already-authorized Supabase client (service role)
 * and scope every query by account_id. Authorization happens in the API
 * routes BEFORE these functions are called — this layer enforces data
 * integrity and business rules, not permissions.
 *
 * Financial rules enforced here:
 * - Totals are ALWAYS computed server-side from line items; client-supplied
 *   totals are ignored.
 * - Money is integer minor units end-to-end.
 * - Only draft estimates can be edited or soft-deleted.
 * - Lifecycle transitions are conditional updates (WHERE status = expected)
 *   so concurrent transitions cannot both succeed, and every transition
 *   writes an append-only audit row.
 */

import {
  computeEstimateTotals,
  computeLineTotalMinor,
  normalizeIdempotencyKey,
} from './estimate-money';
import {
  canTransition,
  isDeletable,
  isEditable,
  transitionError,
  type EstimateStatus,
} from './estimate-lifecycle';
import type { CreateEstimateInput, UpdateEstimateInput } from './validation-schemas';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClientAny = any;

export type { EstimateStatus };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EstimateLineItem {
  id: string;
  estimate_id: string;
  account_id: string;
  description: string;
  quantity: number;
  unit_price_minor: number;
  line_total_minor: number;
  sort_order: number;
  created_at: string;
}

export interface Estimate {
  id: string;
  account_id: string;
  project_id: string | null;
  estimate_number: string | null;
  title: string;
  status: EstimateStatus;
  currency: string;
  tax_rate_bps: number;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  valid_until: string | null;
  notes: string | null;
  idempotency_key: string | null;
  created_by: string | null;
  sent_at: string | null;
  responded_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string;
  updated_at: string;
  line_items?: EstimateLineItem[];
  project?: { id: string; name: string } | null;
  account?: { id: string; name: string } | null;
}

export interface ServiceError {
  kind: 'validation' | 'not_found' | 'conflict' | 'internal';
  message: string;
  code?: string;
}

export type ServiceResult<T> =
  | { data: T; error: null }
  | { data: null; error: ServiceError };

function ok<T>(data: T): ServiceResult<T> {
  return { data, error: null };
}

function fail<T>(error: ServiceError): ServiceResult<T> {
  return { data: null, error };
}

function internal<T>(message: string, code?: string): ServiceResult<T> {
  return fail<T>({ kind: 'internal', message, code });
}

function validation<T>(message: string): ServiceResult<T> {
  return fail<T>({ kind: 'validation', message });
}

function notFound<T>(message = 'Estimate not found'): ServiceResult<T> {
  return fail<T>({ kind: 'not_found', message });
}

function conflict<T>(message: string, code?: string): ServiceResult<T> {
  return fail<T>({ kind: 'conflict', message, code });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ESTIMATE_SELECT = `
  *,
  line_items:estimate_line_items(*),
  project:projects(id, name),
  account:accounts(id, name)
`;

const LIST_SELECT = `
  *,
  line_items:estimate_line_items(id),
  project:projects(id, name)
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape LIKE/ILIKE wildcards so user search can't inject patterns. */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

interface PreparedLineItem {
  description: string;
  quantity: number;
  unit_price_minor: number;
  line_total_minor: number;
  sort_order: number;
}

/**
 * Validate and compute line items server-side.
 * Returns prepared rows with server-computed line totals, or an error.
 */
function prepareLineItems(
  lineItems: CreateEstimateInput['lineItems'],
): ServiceResult<PreparedLineItem[]> {
  const prepared: PreparedLineItem[] = [];

  for (let i = 0; i < lineItems.length; i++) {
    const item = lineItems[i];
    const description = item.description?.trim();
    if (!description) {
      return validation(`Line item ${i + 1}: description is required`);
    }
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
      return validation(`Line item ${i + 1}: quantity must be greater than 0`);
    }
    if (
      !Number.isSafeInteger(item.unitPriceMinor) ||
      item.unitPriceMinor < 0
    ) {
      return validation(
        `Line item ${i + 1}: unit price must be a non-negative integer (minor units)`,
      );
    }

    let lineTotal: number;
    try {
      lineTotal = computeLineTotalMinor(item.quantity, item.unitPriceMinor);
    } catch (e) {
      return validation(`Line item ${i + 1}: ${(e as Error).message}`);
    }

    prepared.push({
      description,
      quantity: item.quantity,
      unit_price_minor: item.unitPriceMinor,
      line_total_minor: lineTotal,
      sort_order: i,
    });
  }

  return ok(prepared);
}

// ---------------------------------------------------------------------------
// Account check
// ---------------------------------------------------------------------------

export async function accountExists(
  supabase: SupabaseClientAny,
  accountId: string,
): Promise<ServiceResult<{ id: string }>> {
  const { data, error } = await supabase
    .from('accounts')
    .select('id')
    .eq('id', accountId)
    .maybeSingle();

  if (error) {
    return internal(`Failed to verify account: ${error.message}`);
  }
  if (!data) {
    return notFound('Account not found');
  }
  return ok(data as { id: string });
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface ListEstimatesFilters {
  status?: EstimateStatus;
  projectId?: string;
  q?: string;
  limit: number;
  offset: number;
}

/**
 * List estimates for an account with server-side filtering + pagination.
 * Always excludes soft-deleted rows.
 */
export async function listEstimates(
  supabase: SupabaseClientAny,
  accountId: string,
  filters: ListEstimatesFilters,
): Promise<ServiceResult<{ estimates: Estimate[]; total: number }>> {
  let query = supabase
    .from('estimates')
    .select(LIST_SELECT, { count: 'exact' })
    .eq('account_id', accountId)
    .is('deleted_at', null);

  if (filters.status) {
    query = query.eq('status', filters.status);
  }
  if (filters.projectId) {
    query = query.eq('project_id', filters.projectId);
  }
  if (filters.q) {
    const term = escapeLike(filters.q.trim());
    if (term) {
      query = query.or(`title.ilike.%${term}%,estimate_number.ilike.%${term}%`);
    }
  }

  query = query
    .order('created_at', { ascending: false })
    .range(filters.offset, filters.offset + filters.limit - 1);

  const { data, error, count } = await query;

  if (error) {
    return internal(`Failed to list estimates: ${error.message}`);
  }

  return ok({
    estimates: (data as Estimate[]) ?? [],
    total: count ?? 0,
  });
}

// ---------------------------------------------------------------------------
// Get one
// ---------------------------------------------------------------------------

export async function getEstimate(
  supabase: SupabaseClientAny,
  accountId: string,
  estimateId: string,
): Promise<ServiceResult<Estimate | null>> {
  const { data, error } = await supabase
    .from('estimates')
    .select(ESTIMATE_SELECT)
    .eq('id', estimateId)
    .eq('account_id', accountId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) {
    return internal(`Failed to fetch estimate: ${error.message}`);
  }
  return ok((data as Estimate) ?? null);
}

// ---------------------------------------------------------------------------
// Idempotency lookup
// ---------------------------------------------------------------------------

export async function findByIdempotencyKey(
  supabase: SupabaseClientAny,
  accountId: string,
  idempotencyKey: string,
): Promise<ServiceResult<Estimate | null>> {
  const { data, error } = await supabase
    .from('estimates')
    .select(ESTIMATE_SELECT)
    .eq('account_id', accountId)
    .eq('idempotency_key', idempotencyKey)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) {
    return internal(`Failed to check idempotency key: ${error.message}`);
  }
  return ok((data as Estimate) ?? null);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createEstimate(
  supabase: SupabaseClientAny,
  accountId: string,
  userId: string,
  input: CreateEstimateInput,
  idempotencyKeyRaw: string | null,
): Promise<ServiceResult<Estimate>> {
  // Normalize + validate idempotency key
  let idempotencyKey: string | null;
  try {
    idempotencyKey = normalizeIdempotencyKey(idempotencyKeyRaw);
  } catch (e) {
    return validation((e as Error).message);
  }

  // Validate project belongs to this account (if provided)
  if (input.projectId) {
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id')
      .eq('id', input.projectId)
      .eq('account_id', accountId)
      .maybeSingle();

    if (projectError) {
      return internal(`Failed to verify project: ${projectError.message}`);
    }
    if (!project) {
      return validation('Project not found in this account');
    }
  }

  // Prepare + validate line items (server-side totals)
  const preparedResult = prepareLineItems(input.lineItems);
  if (preparedResult.error) {
    return fail(preparedResult.error);
  }
  const prepared = preparedResult.data!;

  const taxRateBps = input.taxRateBps ?? 0;
  let totals;
  try {
    totals = computeEstimateTotals({
      lineItems: prepared.map((p) => ({
        quantity: p.quantity,
        unitPriceMinor: p.unit_price_minor,
      })),
      taxRateBps,
    });
  } catch (e) {
    return validation((e as Error).message);
  }

  // Allocate estimate number (atomic per-account sequence)
  let estimateNumber: string | null = null;
  const { data: numberData, error: numberError } = await supabase.rpc(
    'next_estimate_number',
    { p_account_id: accountId },
  );
  if (numberError) {
    // Non-fatal: numbering is cosmetic; log and continue without a number
    console.warn('next_estimate_number RPC failed:', numberError.message);
  } else {
    estimateNumber = numberData as string;
  }

  // Insert estimate header
  const { data: estimate, error: insertError } = await supabase
    .from('estimates')
    .insert({
      account_id: accountId,
      project_id: input.projectId ?? null,
      estimate_number: estimateNumber,
      title: input.title.trim(),
      status: 'draft',
      currency: input.currency ?? 'USD',
      tax_rate_bps: taxRateBps,
      subtotal_minor: totals.subtotalMinor,
      tax_minor: totals.taxMinor,
      total_minor: totals.totalMinor,
      valid_until: input.validUntil ?? null,
      notes: input.notes ?? null,
      idempotency_key: idempotencyKey,
      created_by: userId,
    })
    .select(ESTIMATE_SELECT)
    .single();

  if (insertError) {
    // Unique violation on idempotency key → caller handles replay
    return internal(
      `Failed to create estimate: ${insertError.message}`,
      insertError.code,
    );
  }

  const estimateId = (estimate as Estimate).id;

  // Insert line items (denormalized account_id for defense-in-depth)
  const lineRows = prepared.map((p) => ({
    estimate_id: estimateId,
    account_id: accountId,
    description: p.description,
    quantity: p.quantity,
    unit_price_minor: p.unit_price_minor,
    line_total_minor: p.line_total_minor,
    sort_order: p.sort_order,
  }));

  const { error: itemsError } = await supabase
    .from('estimate_line_items')
    .insert(lineRows);

  if (itemsError) {
    // Compensating action: soft-delete the orphaned estimate so the
    // idempotency key is released and no partial financial record remains.
    await supabase
      .from('estimates')
      .update({ deleted_at: new Date().toISOString(), deleted_by: userId })
      .eq('id', estimateId);
    return internal(`Failed to create line items: ${itemsError.message}`);
  }

  // Audit: initial draft state
  await supabase.from('estimate_status_history').insert({
    estimate_id: estimateId,
    account_id: accountId,
    from_status: null,
    to_status: 'draft',
    changed_by: userId,
    note: 'Estimate created',
  });

  // Re-fetch with line items embedded
  const full = await getEstimate(supabase, accountId, estimateId);
  if (full.error || !full.data) {
    return internal('Estimate created but failed to reload');
  }
  return ok(full.data);
}

// ---------------------------------------------------------------------------
// Update (draft only)
// ---------------------------------------------------------------------------

export async function updateDraftEstimate(
  supabase: SupabaseClientAny,
  accountId: string,
  estimateId: string,
  userId: string,
  input: UpdateEstimateInput,
): Promise<ServiceResult<Estimate>> {
  // Fetch current estimate (scoped by account + not deleted)
  const current = await getEstimate(supabase, accountId, estimateId);
  if (current.error) {
    return fail(current.error);
  }
  if (!current.data) {
    return notFound();
  }

  const estimate = current.data;
  if (!isEditable(estimate.status)) {
    return conflict(`Only draft estimates can be edited (current status: ${estimate.status})`);
  }

  // Validate project if changing
  if (input.projectId !== undefined && input.projectId) {
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id')
      .eq('id', input.projectId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (projectError) {
      return internal(`Failed to verify project: ${projectError.message}`);
    }
    if (!project) {
      return validation('Project not found in this account');
    }
  }

  // Build update payload — only provided fields
  const updates: Record<string, unknown> = {};
  if (input.title !== undefined) updates.title = input.title.trim();
  if (input.projectId !== undefined) updates.project_id = input.projectId || null;
  if (input.currency !== undefined) updates.currency = input.currency;
  if (input.validUntil !== undefined) updates.valid_until = input.validUntil;
  if (input.notes !== undefined) updates.notes = input.notes;

  // Recompute totals if line items or tax rate changed
  let prepared: PreparedLineItem[] | null = null;
  let taxRateBps = estimate.tax_rate_bps;

  if (input.taxRateBps !== undefined) {
    taxRateBps = input.taxRateBps;
    updates.tax_rate_bps = taxRateBps;
  }

  if (input.lineItems !== undefined) {
    const preparedResult = prepareLineItems(input.lineItems);
    if (preparedResult.error) {
      return fail(preparedResult.error);
    }
    prepared = preparedResult.data!;
  }

  if (prepared !== null || input.taxRateBps !== undefined) {
    // Need existing line items if only tax changed
    let itemsForTotals: Array<{ quantity: number; unitPriceMinor: number }>;
    if (prepared !== null) {
      itemsForTotals = prepared.map((p) => ({
        quantity: p.quantity,
        unitPriceMinor: p.unit_price_minor,
      }));
    } else {
      const existing = estimate.line_items ?? [];
      itemsForTotals = existing.map((li) => ({
        quantity: Number(li.quantity),
        unitPriceMinor: li.unit_price_minor,
      }));
    }

    try {
      const totals = computeEstimateTotals({ lineItems: itemsForTotals, taxRateBps });
      updates.subtotal_minor = totals.subtotalMinor;
      updates.tax_minor = totals.taxMinor;
      updates.total_minor = totals.totalMinor;
    } catch (e) {
      return validation((e as Error).message);
    }
  }

  // Conditional update: only succeeds while still draft (guards races)
  const { data: updated, error: updateError } = await supabase
    .from('estimates')
    .update(updates)
    .eq('id', estimateId)
    .eq('account_id', accountId)
    .eq('status', 'draft')
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();

  if (updateError) {
    return internal(`Failed to update estimate: ${updateError.message}`);
  }
  if (!updated) {
    return conflict('Estimate is no longer editable (status changed concurrently)');
  }

  // Replace line items if provided (delete + insert)
  if (prepared !== null) {
    const { error: deleteError } = await supabase
      .from('estimate_line_items')
      .delete()
      .eq('estimate_id', estimateId)
      .eq('account_id', accountId);
    if (deleteError) {
      return internal(`Failed to replace line items: ${deleteError.message}`);
    }

    const lineRows = prepared.map((p) => ({
      estimate_id: estimateId,
      account_id: accountId,
      description: p.description,
      quantity: p.quantity,
      unit_price_minor: p.unit_price_minor,
      line_total_minor: p.line_total_minor,
      sort_order: p.sort_order,
    }));

    const { error: insertError } = await supabase
      .from('estimate_line_items')
      .insert(lineRows);
    if (insertError) {
      return internal(`Failed to insert line items: ${insertError.message}`);
    }
  }

  const full = await getEstimate(supabase, accountId, estimateId);
  if (full.error || !full.data) {
    return internal('Estimate updated but failed to reload');
  }
  return ok(full.data);
}

// ---------------------------------------------------------------------------
// Soft delete (draft only)
// ---------------------------------------------------------------------------

export async function softDeleteEstimate(
  supabase: SupabaseClientAny,
  accountId: string,
  estimateId: string,
  userId: string,
): Promise<ServiceResult<{ id: string }>> {
  const current = await getEstimate(supabase, accountId, estimateId);
  if (current.error) {
    return fail(current.error);
  }
  if (!current.data) {
    return notFound();
  }

  if (!isDeletable(current.data.status)) {
    return conflict(
      `Only draft estimates can be deleted (current status: ${current.data.status})`,
    );
  }

  const { data, error } = await supabase
    .from('estimates')
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: userId,
    })
    .eq('id', estimateId)
    .eq('account_id', accountId)
    .eq('status', 'draft')
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();

  if (error) {
    return internal(`Failed to delete estimate: ${error.message}`);
  }
  if (!data) {
    return conflict('Estimate is no longer deletable (status changed concurrently)');
  }

  return ok({ id: (data as { id: string }).id });
}

// ---------------------------------------------------------------------------
// Lifecycle transition
// ---------------------------------------------------------------------------

export async function transitionEstimate(
  supabase: SupabaseClientAny,
  accountId: string,
  estimateId: string,
  userId: string,
  toStatus: EstimateStatus,
  note: string | null,
): Promise<ServiceResult<Estimate>> {
  const current = await getEstimate(supabase, accountId, estimateId);
  if (current.error) {
    return fail(current.error);
  }
  if (!current.data) {
    return notFound();
  }

  const estimate = current.data;
  const fromStatus = estimate.status;

  const err = transitionError(fromStatus, toStatus);
  if (err) {
    return conflict(err);
  }
  if (!canTransition(fromStatus, toStatus)) {
    return conflict(`Cannot transition from ${fromStatus} to ${toStatus}`);
  }

  // Conditional update: only succeeds if status is still the expected value
  const updates: Record<string, unknown> = { status: toStatus };
  const now = new Date().toISOString();
  if (toStatus === 'sent') {
    updates.sent_at = now;
  }
  if (toStatus === 'accepted' || toStatus === 'rejected') {
    updates.responded_at = now;
  }

  const { data: updated, error: updateError } = await supabase
    .from('estimates')
    .update(updates)
    .eq('id', estimateId)
    .eq('account_id', accountId)
    .eq('status', fromStatus)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();

  if (updateError) {
    return internal(`Failed to transition estimate: ${updateError.message}`);
  }
  if (!updated) {
    return conflict('Estimate status changed concurrently; please refresh and retry');
  }

  // Append-only audit row
  const { error: historyError } = await supabase
    .from('estimate_status_history')
    .insert({
      estimate_id: estimateId,
      account_id: accountId,
      from_status: fromStatus,
      to_status: toStatus,
      changed_by: userId,
      note: note ?? null,
    });

  if (historyError) {
    // Transition succeeded but audit failed — surface as internal error
    // so the caller knows the state is inconsistent.
    return internal(`Transition applied but audit write failed: ${historyError.message}`);
  }

  const full = await getEstimate(supabase, accountId, estimateId);
  if (full.error || !full.data) {
    return internal('Estimate transitioned but failed to reload');
  }
  return ok(full.data);
}
