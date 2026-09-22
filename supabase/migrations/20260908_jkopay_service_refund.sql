alter table public.jkopay_service_payments
  drop constraint if exists jkopay_service_payments_status_check;

alter table public.jkopay_service_payments
  add constraint jkopay_service_payments_status_check
  check (status in (
    'pending',
    'processing',
    'paid',
    'failed',
    'refunding',
    'refund_reversal_pending',
    'refunded'
  ));
