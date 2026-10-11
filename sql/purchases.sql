-- Tabela alinhada com purchases.js (PayPal + PayJSR).
-- Se a tabela já existir, corre só o bloco ALTER no fim.

create table if not exists public.purchases (
  id uuid not null default gen_random_uuid(),
  video_id uuid null,
  buyer_email text not null,
  buyer_name text null,
  transaction_id text not null,
  payment_method text not null,
  amount numeric(10, 2) not null,
  currency text not null default 'usd',
  status text not null default 'completed',
  video_title text null,
  product_link text null,
  metadata jsonb null,
  created_at timestamp with time zone null default now(),
  updated_at timestamp with time zone null default now(),
  constraint purchases_pkey primary key (id),
  constraint purchases_transaction_id_key unique (transaction_id),
  constraint purchases_video_id_fkey foreign key (video_id) references videos (id) on delete set null,
  constraint purchases_payment_method_check check (
    payment_method = any (
      array['whop'::text, 'who'::text, 'stripe'::text, 'crypto'::text, 'paypal'::text, 'payjsr'::text]
    )
  ),
  constraint purchases_status_check check (
    status = any (
      array['pending'::text, 'completed'::text, 'failed'::text, 'refunded'::text]
    )
  )
);

create index if not exists idx_purchases_email on public.purchases using btree (buyer_email);
create index if not exists idx_purchases_transaction_id on public.purchases using btree (transaction_id);
create index if not exists idx_purchases_created_at on public.purchases using btree (created_at desc);

-- Migração se a tabela já existir com o check antigo ('who' sem payjsr):
alter table public.purchases
  drop constraint if exists purchases_payment_method_check;

alter table public.purchases
  add constraint purchases_payment_method_check check (
    payment_method = any (
      array['whop'::text, 'who'::text, 'stripe'::text, 'crypto'::text, 'paypal'::text, 'payjsr'::text]
    )
  );

alter table public.purchases
  alter column currency set default 'usd';
