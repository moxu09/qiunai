-- A paid self-service ATM/CVS/card order is stored as pending + waiting_ecpay.
-- Keep the existing row locks and payer/amount/player checks; only admit that
-- exact unpaid state to the already-paid ECPay fulfillment function.
do $migration$
declare
  definition text := pg_get_functiondef(
    'public.qiunai_mark_ecpay_orders_paid(text,text)'::regprocedure
  );
  old_predicate text :=
    'and coalesce(v_order.status, '''') not in (''waiting_payment'', ''quoted'', ''waiting_confirm'')';
  new_predicate text :=
    'and not (coalesce(v_order.status, '''') in (''waiting_payment'', ''quoted'', ''waiting_confirm'')'
    || ' or (v_self_service and v_order.status = ''pending'''
    || ' and v_order.quote_status = ''waiting_ecpay'''
    || ' and v_order.payment_method = ''綠界支付''))';
begin
  if position(new_predicate in definition) > 0 then
    return;
  end if;
  if position(old_predicate in definition) = 0 then
    raise exception 'Qiunai ECPay fulfillment definition changed; review before migration';
  end if;
  execute replace(definition, old_predicate, new_predicate);
end
$migration$;
