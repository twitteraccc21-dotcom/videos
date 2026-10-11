-- Apply once in the Supabase SQL editor before enabling Walled checkout.
-- These tables are accessed only by the server's Supabase service-role client.

create table if not exists public.walled_orders (
  order_id uuid primary key,
  request_key uuid not null unique,
  video_id uuid null references public.videos(id) on delete set null,
  bundle boolean not null default false,
  title text not null,
  amount_minor integer not null check (amount_minor > 0),
  currency text not null default 'usd',
  product_id text not null,
  session_id text unique,
  checkout_url text,
  environment text,
  status text not null default 'creating',
  walled_status text,
  transaction_id text,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_walled_orders_status on public.walled_orders(status);
create index if not exists idx_walled_orders_transaction on public.walled_orders(transaction_id);

create table if not exists public.walled_webhook_events (
  event_id text primary key,
  event_type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

alter table public.walled_orders enable row level security;
alter table public.walled_webhook_events enable row level security;
revoke all on public.walled_orders, public.walled_webhook_events from anon, authenticated;
grant all on public.walled_orders, public.walled_webhook_events to service_role;

-- Keep the legacy PayJSR method accepted in historical purchase records and
-- add Walled for new orders. Existing table constraints vary between installs.
alter table public.purchases drop constraint if exists purchases_payment_method_check;
alter table public.purchases add constraint purchases_payment_method_check check (
  payment_method = any (array[
    'whop'::text, 'who'::text, 'stripe'::text, 'crypto'::text,
    'paypal'::text, 'payjsr'::text, 'walled'::text
  ])
);
