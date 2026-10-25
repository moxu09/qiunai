begin;
-- Preserve the triggering order channel across reward-delivery retries.
-- Existing row permissions and reward/grant functions remain unchanged.
alter table public.bot_vip_reward_operations
 add column if not exists notification_channel_id text;
comment on column public.bot_vip_reward_operations.notification_channel_id is
 'VIP upgrade announcement destination from the triggering order; never default to the benefits channel';
commit;
