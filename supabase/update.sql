-- Already ran an older schema.sql? Run this file once to add: card payments + progress that follows the account.
drop policy if exists docs_read on public.docs;
create policy docs_read on public.docs for select to authenticated
  using (
    (collection not in ('drafts','payments','entitlements') and collection not like 'data/users/%')
    or is_admin()
    or collection = 'data/users/' || auth.uid()::text
    or (collection = 'entitlements' and doc_id = auth.uid()::text)
    or (collection = 'payments' and data->>'uid' = auth.uid()::text)
  );

-- each student's own progress (score, goal, answers, schedule) — follows them to any device
drop policy if exists own_state on public.docs;
create policy own_state on public.docs for all to authenticated
  using (collection = 'data/users/' || auth.uid()::text)
  with check (collection = 'data/users/' || auth.uid()::text);

-- students submit a card-transfer receipt; only the owner can approve (entitlements are admin-only)
drop policy if exists payments_insert on public.docs;
create policy payments_insert on public.docs for insert to authenticated
  with check (collection = 'payments' and data->>'uid' = auth.uid()::text and data->>'status' = 'pending');

