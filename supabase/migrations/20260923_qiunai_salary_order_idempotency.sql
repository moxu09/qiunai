-- 一般秋奈訂單每位陪陪只能有一筆有效薪資報單。
-- 已刪除的歷史資料不阻擋重新建立；手動報單與加時報單維持原流程。
create unique index if not exists qiunai_salary_orders_order_staff_unique
  on public.qiunai_salary_orders (order_id, discord_id)
  where coalesce(is_deleted, false) = false
    and order_id like 'ORD-%';
