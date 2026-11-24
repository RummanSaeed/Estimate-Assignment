# Kontrora — Staff Engineer Assignment (Revenue & Billing)

PSA platform (Next.js App Router + Supabase). Ship one revenue slice end-to-end in **2–3 hours**. Quality over completeness.

## Setup  

Node.js **20.9+**, free [Supabase](https://supabase.com) project.

```bash    
npm install
cp .env.local.template .env.local   # fill Supabase URL + keys
# Run supabase/schema.sql in the Supabase SQL Editor
npm run dev                        # http://localhost:3000
```

## Task   
   
Implement **Estimates** scoped to accounts:

1. Schema: estimates + line items — account-bound, amounts in minor units, optional project link
2. Lifecycle: draft → sent → accepted | rejected; no hard deletes
3. RBAC: extend permissions for financial data; enforce account boundaries on every route
4. API: server-side list/filter, create with `Idempotency-Key`, get by id
5. UI under account context: list, create draft, line-item editor

## Evaluation     

Schema & tenancy · Money-touching API correctness · RBAC · Code judgment · Fork README
    
## Submission

Share your fork URL (no PRs). Fork README must cover architecture decisions, security/tenancy review, how to run tests, and what you'd ship next (e.g. Stripe, reconciliation).

---

# Implementation Notes — Estimates

I scoped estimates to accounts end-to-end: schema, API, RBAC, and UI. Here's how I approached it and the decisions behind it.

## Schema

Four new tables in `supabase/schema.sql` (sections 38–41):

- **`estimates`** — every row is bound to an account (`account_id NOT NULL`, FK with `ON DELETE RESTRICT` so financial records can't be silently destroyed when an account goes away). It can optionally link to a project, but the service layer verifies the project belongs to the same account before accepting it. Status is CHECK-constrained to `draft|sent|accepted|rejected`, money is stored as `BIGINT` minor units, and tax is stored in basis points. All money columns have `CHECK >= 0` so the database itself rejects negative amounts.
- **`estimate_line_items`** — quantity, unit price in minor units, and a server-computed line total. I denormalized `account_id` onto line items too, purely as defense-in-depth for RLS and queries.
- **`estimate_status_history`** — append-only audit trail. Every lifecycle change records who did it, when, and an optional note.
- **`estimate_counters` + `next_estimate_number()`** — a per-account sequence that gives `EST-00001`, `EST-00002`, etc. It's atomic (`INSERT … ON CONFLICT`), so two people creating estimates at the same time can't get the same number.

For idempotency I added a partial unique index on `(account_id, idempotency_key) WHERE deleted_at IS NULL`. That means one live estimate per key per account, and if an estimate is soft-deleted the key becomes reusable. Deletes are soft everywhere (`deleted_at`/`deleted_by`) — there is no hard delete path in this feature.

## Money handling

This was the part I was most careful with. All amounts are integer minor units from the API boundary to the database — floats never touch Postgres. The client sends `unitPriceMinor` as an integer; the server recomputes every line total and the estimate totals itself, so a tampered client can't change what gets stored.

Tax is basis points (e.g. 825 = 8.25%) and computed with pure integer math: `round(subtotal × bps / 10000)`. Rounding is half-up to the nearest minor unit, and it's unit-tested. `majorToMinor` also guards against IEEE-754 noise — `19.99 * 100` in JS is `1998.999…`, which would silently become 1998 without the guard — and it rejects negative, non-finite, or unsafe values outright.

## Lifecycle

The state machine is deliberately small: `draft → sent → accepted | rejected`. Accepted and rejected are terminal — if a client wants changes, you create a new estimate rather than mutating a decided one. That keeps the financial record immutable once it's been sent.

Only drafts can be edited or deleted. Transitions use a conditional update (`WHERE status = <expected>`), so if two people try to transition the same estimate concurrently, only one succeeds and the other gets a 409 telling them to refresh. Every successful transition writes an audit row.

## RBAC

I added five permissions under a new Revenue category: `view_estimates`, `manage_estimates` (create/edit/delete drafts), `send_estimates` (draft→sent and recording accept/reject), plus `view_all_estimates` and `manage_all_estimates` as org-wide overrides. The overrides plug into the existing `checkPermissionHybrid` override map, so they behave exactly like `view_all_projects` does today. Base permissions still require account membership when an `accountId` context is passed.

## API

The routes live under `app/api/accounts/[accountId]/estimates/` and are built on the existing `withApiRoute` guard, which handles auth, permission, and context in one wrapper. Data access uses the service-role client *after* authorization — same pattern as the rest of the codebase.

- `GET …/estimates` — server-side filtering (status, project, search on title/number with LIKE-wildcard escaping), pagination capped at 100, returns `{ estimates, total }`.
- `POST …/estimates` — creates a draft with line items. It honors the `Idempotency-Key` header: a replay returns the original estimate with `replayed: true` instead of creating a duplicate, and if two creates race, the unique index picks a winner and the loser re-fetches it. The UI generates one UUID key per create session so double-clicks and network retries are safe.
- `GET/PATCH/DELETE …/estimates/:id` — fetch one, update draft only (header fields plus full line-item replacement, totals recomputed), soft-delete draft only.
- `POST …/transition` — `{ toStatus, note? }`, requires `send_estimates`, enforces the state machine.

On account boundaries: every query is scoped by both `.eq('account_id', accountId)` and `.eq('id', estimateId)`, and a cross-account estimate returns 404 rather than 403 — I didn't want to leak that the estimate exists. Permission checks run with `{ accountId }` context on every single route.

## UI

- `/accounts/[accountId]/estimates` — a server component (permission-gated) rendering `EstimatesList`: searchable/filterable table, status badges, formatted totals, pagination, draft-only delete, and a "New Estimate" button.
- `/accounts/[accountId]/estimates/[estimateId]` — `estimateId = 'new'` opens the create form; anything else loads the editor. `EstimateEditor` has header fields, dynamic line-item rows with a live totals preview, tax %, project picker, and lifecycle actions (Save / Mark as Sent / Accept / Reject / Delete) gated by both permission and current status. Non-draft or unauthorized users get a read-only view.
- Entry point is an "Estimates" button in the account overview header, only shown to users with `view_estimates`.

## Security / tenancy review

Account isolation is enforced twice: `hasAccountAccess` inside the permission check, and the `account_id` predicate on every SQL query. The `*_all_*` override permissions intentionally bypass membership — that's consistent with how the existing `*_all_*` permissions work elsewhere in the app.

On RLS: the new tables have RLS enabled with no anon/authenticated policies, so direct PostgREST access is denied by default. Everything goes through API routes that authorize first and then use the service role. Worth flagging: the pre-existing tables use `USING (TRUE)` policies, which is looser than I'd like — tightening those is out of scope here but something I'd revisit.

Financial integrity comes from three layers: zod validation on input, server-side recomputation of all totals, and DB CHECK constraints as a last line of defense. Transitions are conditional updates with an audit trail, and idempotency keys make retries safe.

## How to run tests

```bash
npm test          # vitest run — __tests__/estimate-money.test.ts, estimate-lifecycle.test.ts
npm run lint      # eslint
npx tsc --noEmit  # typecheck
```

The tests cover minor-unit conversion (including the float-noise case), line and estimate total math with tax rounding, idempotency-key normalization, and the full lifecycle transition matrix.

## What I'd ship next

1. **Stripe integration** — turn an accepted estimate into a Stripe invoice or checkout session, store the invoice ID on the estimate, and let a webhook mark it paid. Stripe amounts are already minor units, so it drops straight into the existing money model.
2. **Reconciliation** — match payments against estimate totals, flag under/over-payments, and build an aging report on `sent` estimates past their `valid_until` date.
3. **Client portal acceptance** — let client users accept or reject via a signed token link instead of staff recording the decision on their behalf. Keeps `send_estimates` staff-side and moves the actual decision to the client.
4. **Estimate → project bridge** — on acceptance, optionally spin up a project budget or SOW from the accepted line items.
5. **Atomic creation RPC** — move the estimate + line-item insert into a single Postgres function to eliminate the compensating soft-delete path I currently use if line-item insert fails.
6. **PDF snapshot at send time** — render a client-facing PDF when an estimate is sent and store an immutable snapshot, so later edits can't change what the client actually saw.