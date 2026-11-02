-- Scoped row policies only; no settlement triggers or financial data changes.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create or replace function public.erp_current_discord_id()
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select candidates.discord_id
  from auth.identities identity_row
  cross join lateral unnest(array[
    nullif(identity_row.identity_data ->> 'provider_id', ''),
    nullif(identity_row.identity_data ->> 'sub', ''),
    nullif(identity_row.identity_data ->> 'user_id', ''),
    nullif(identity_row.id::text, '')
  ]) with ordinality as candidates(discord_id, priority)
  where identity_row.user_id = auth.uid()
    and identity_row.provider = 'discord'
    and candidates.discord_id ~ '^[0-9]{15,22}$'
  order by candidates.priority
  limit 1;
$function$;

create or replace function public.erp_has_salary_access(p_organization text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_discord_id text := public.erp_current_discord_id();
begin
  if v_discord_id is null then
    return false;
  end if;

  if v_discord_id = '847840193859682304' then
    return true;
  end if;

  if exists (
    select 1
    from public.erp_role_assignments assignment
    where assignment.organization_code = p_organization
      and assignment.discord_id = v_discord_id
      and assignment.is_active = true
      and assignment.role in ('super_admin', 'store_manager', 'customer_service')
  ) then
    return true;
  end if;

  if p_organization = 'deepnight' then
    return exists (
      select 1 from public.admins admin_row
      where admin_row.discord_id = v_discord_id
        and admin_row.is_active = true
        and not exists (
          select 1 from public.erp_role_assignments assignment
          where assignment.organization_code = p_organization
            and assignment.discord_id = v_discord_id
        )
    );
  end if;

  if p_organization = 'qiunai' then
    return exists (
      select 1 from public.qiunai_admins admin_row
      where admin_row.discord_id = v_discord_id
        and admin_row.is_active = true
        and not exists (
          select 1 from public.erp_role_assignments assignment
          where assignment.organization_code = p_organization
            and assignment.discord_id = v_discord_id
        )
    );
  end if;

  return false;
end;
$function$;

create or replace function public.erp_is_manager(p_organization text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_discord_id text := public.erp_current_discord_id();
begin
  if v_discord_id is null then
    return false;
  end if;

  if v_discord_id = '847840193859682304' then
    return true;
  end if;

  if exists (
    select 1
    from public.erp_role_assignments assignment
    where assignment.organization_code = p_organization
      and assignment.discord_id = v_discord_id
      and assignment.is_active = true
      and assignment.role in ('super_admin', 'store_manager')
  ) then
    return true;
  end if;

  -- Legacy administrators predate erp_role_assignments and are treated as
  -- managers until the role migration has populated their assignment.
  if p_organization = 'deepnight' then
    return exists (
      select 1 from public.admins admin_row
      where admin_row.discord_id = v_discord_id
        and admin_row.is_active = true
        and not exists (
          select 1 from public.erp_role_assignments assignment
          where assignment.organization_code = p_organization
            and assignment.discord_id = v_discord_id
        )
    );
  end if;

  if p_organization = 'qiunai' then
    return exists (
      select 1 from public.qiunai_admins admin_row
      where admin_row.discord_id = v_discord_id
        and admin_row.is_active = true
        and not exists (
          select 1 from public.erp_role_assignments assignment
          where assignment.organization_code = p_organization
            and assignment.discord_id = v_discord_id
        )
    );
  end if;

  return false;
end;
$function$;

revoke all on function public.erp_current_discord_id()
  from public, anon;
revoke all on function public.erp_has_salary_access(text)
  from public, anon;
revoke all on function public.erp_is_manager(text)
  from public, anon;
grant execute on function public.erp_current_discord_id()
  to authenticated, service_role;
grant execute on function public.erp_has_salary_access(text)
  to authenticated, service_role;
grant execute on function public.erp_is_manager(text)
  to authenticated, service_role;

do $reset_scoped_policies$
declare p record; t text;
begin
 for t in select unnest(array['players','players_services','play_orders','players_bonus','admins','salary_settings','qiunai_staff','qiunai_staff_services','qiunai_salary_orders','qiunai_staff_bonus','qiunai_admins','qiunai_salary_settings']) loop
  if to_regclass('public.'||t) is null then raise exception 'Required EIP table missing: %',t; end if;
  for p in select polname from pg_policy where polrelid=to_regclass('public.'||t) loop
   execute format('drop policy %I on public.%I',p.polname,t);
  end loop;
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon',t);
 end loop;
end $reset_scoped_policies$;
-- DeepNight employee profile and service preferences.
create policy deepnight_players_select on public.players
  for select to authenticated
  using (
    discord_id = (select public.erp_current_discord_id())
    or (select public.erp_is_manager('deepnight'))
  );
create policy deepnight_players_update on public.players
  for update to authenticated
  using ((select public.erp_is_manager('deepnight')))
  with check ((select public.erp_is_manager('deepnight')));
create policy deepnight_players_insert on public.players
  for insert to authenticated
  with check ((select public.erp_is_manager('deepnight')));
create policy deepnight_players_delete on public.players
  for delete to authenticated
  using ((select public.erp_is_manager('deepnight')));

create policy deepnight_services_select on public.players_services
  for select to authenticated
  using (
    discord_id = (select public.erp_current_discord_id())
    or (select public.erp_is_manager('deepnight'))
  );
create policy deepnight_services_insert on public.players_services
  for insert to authenticated
  with check (
    discord_id = (select public.erp_current_discord_id())
    or (select public.erp_is_manager('deepnight'))
  );
create policy deepnight_services_update on public.players_services
  for update to authenticated
  using (
    discord_id = (select public.erp_current_discord_id())
    or (select public.erp_is_manager('deepnight'))
  )
  with check (
    discord_id = (select public.erp_current_discord_id())
    or (select public.erp_is_manager('deepnight'))
  );
create policy deepnight_services_delete on public.players_services
  for delete to authenticated
  using (
    discord_id = (select public.erp_current_discord_id())
    or (select public.erp_is_manager('deepnight'))
  );

create policy deepnight_orders_select on public.play_orders
  for select to authenticated
  using (
    (
      guild_id = '1501098191813214312'
      and (
        discord_id = (select public.erp_current_discord_id())
        or (select public.erp_has_salary_access('deepnight'))
      )
    )
    or (
      guild_id is null
      and (
        discord_id = (select public.erp_current_discord_id())
        or (
          (select public.erp_is_manager('deepnight'))
          and exists (
            select 1 from public.players deepnight_player
            where deepnight_player.discord_id = play_orders.discord_id
          )
        )
      )
    )
  );
create policy deepnight_orders_insert on public.play_orders
  for insert to authenticated
  with check (
    (select public.erp_is_manager('deepnight'))
    and (
      guild_id = '1501098191813214312'
      or (
        guild_id is null
        and exists (
          select 1 from public.players deepnight_player
          where deepnight_player.discord_id = play_orders.discord_id
        )
      )
    )
  );
create policy deepnight_orders_update on public.play_orders
  for update to authenticated
  using (
    (select public.erp_is_manager('deepnight'))
    and (
      guild_id = '1501098191813214312'
      or (
        guild_id is null
        and exists (
          select 1 from public.players deepnight_player
          where deepnight_player.discord_id = play_orders.discord_id
        )
      )
    )
  )
  with check (
    (select public.erp_is_manager('deepnight'))
    and (
      guild_id = '1501098191813214312'
      or (
        guild_id is null
        and exists (
          select 1 from public.players deepnight_player
          where deepnight_player.discord_id = play_orders.discord_id
        )
      )
    )
  );

create policy deepnight_bonus_select on public.players_bonus
  for select to authenticated
  using (
    discord_id = (select public.erp_current_discord_id())
    or (select public.erp_is_manager('deepnight'))
  );
create policy deepnight_bonus_insert on public.players_bonus
  for insert to authenticated
  with check ((select public.erp_is_manager('deepnight')));
create policy deepnight_bonus_update on public.players_bonus
  for update to authenticated
  using ((select public.erp_is_manager('deepnight')))
  with check ((select public.erp_is_manager('deepnight')));

create policy deepnight_admin_self_select on public.admins
  for select to authenticated
  using (
    discord_id = (select public.erp_current_discord_id())
    or (select public.erp_is_manager('deepnight'))
  );
create policy deepnight_salary_settings_select on public.salary_settings
  for select to authenticated
  using ((select public.erp_has_salary_access('deepnight')));
create policy deepnight_salary_settings_insert on public.salary_settings
  for insert to authenticated
  with check ((select public.erp_is_manager('deepnight')));
create policy deepnight_salary_settings_update on public.salary_settings
  for update to authenticated
  using ((select public.erp_is_manager('deepnight')))
  with check ((select public.erp_is_manager('deepnight')));

-- Qiunai employee profile and service preferences.
create policy qiunai_staff_select on public.qiunai_staff
  for select to authenticated
  using (
    discord_id = (select public.erp_current_discord_id())
    or (select public.erp_is_manager('qiunai'))
  );
create policy qiunai_staff_update on public.qiunai_staff
  for update to authenticated
  using ((select public.erp_is_manager('qiunai')))
  with check ((select public.erp_is_manager('qiunai')));
create policy qiunai_staff_insert on public.qiunai_staff
  for insert to authenticated
  with check ((select public.erp_is_manager('qiunai')));
create policy qiunai_staff_delete on public.qiunai_staff
  for delete to authenticated
  using ((select public.erp_is_manager('qiunai')));

create policy qiunai_services_select on public.qiunai_staff_services
  for select to authenticated
  using (
    discord_id = (select public.erp_current_discord_id())
    or (select public.erp_is_manager('qiunai'))
  );
create policy qiunai_services_insert on public.qiunai_staff_services
  for insert to authenticated
  with check (
    discord_id = (select public.erp_current_discord_id())
    or (select public.erp_is_manager('qiunai'))
  );
create policy qiunai_services_update on public.qiunai_staff_services
  for update to authenticated
  using (
    discord_id = (select public.erp_current_discord_id())
    or (select public.erp_is_manager('qiunai'))
  )
  with check (
    discord_id = (select public.erp_current_discord_id())
    or (select public.erp_is_manager('qiunai'))
  );
create policy qiunai_services_delete on public.qiunai_staff_services
  for delete to authenticated
  using (
    discord_id = (select public.erp_current_discord_id())
    or (select public.erp_is_manager('qiunai'))
  );

create policy qiunai_orders_select on public.qiunai_salary_orders
  for select to authenticated
  using (
    discord_id = (select public.erp_current_discord_id())
    or (select public.erp_has_salary_access('qiunai'))
  );
create policy qiunai_orders_insert on public.qiunai_salary_orders
  for insert to authenticated
  with check ((select public.erp_is_manager('qiunai')));
create policy qiunai_orders_update on public.qiunai_salary_orders
  for update to authenticated
  using ((select public.erp_is_manager('qiunai')))
  with check ((select public.erp_is_manager('qiunai')));

create policy qiunai_bonus_select on public.qiunai_staff_bonus
  for select to authenticated
  using (
    discord_id = (select public.erp_current_discord_id())
    or (select public.erp_is_manager('qiunai'))
  );
create policy qiunai_bonus_insert on public.qiunai_staff_bonus
  for insert to authenticated
  with check ((select public.erp_is_manager('qiunai')));
create policy qiunai_bonus_update on public.qiunai_staff_bonus
  for update to authenticated
  using ((select public.erp_is_manager('qiunai')))
  with check ((select public.erp_is_manager('qiunai')));

create policy qiunai_admin_self_select on public.qiunai_admins
  for select to authenticated
  using (
    discord_id = (select public.erp_current_discord_id())
    or (select public.erp_is_manager('qiunai'))
  );
create policy qiunai_salary_settings_select on public.qiunai_salary_settings
  for select to authenticated
  using ((select public.erp_has_salary_access('qiunai')));
create policy qiunai_salary_settings_insert on public.qiunai_salary_settings
  for insert to authenticated
  with check ((select public.erp_is_manager('qiunai')));
create policy qiunai_salary_settings_update on public.qiunai_salary_settings
  for update to authenticated
  using ((select public.erp_is_manager('qiunai')))
  with check ((select public.erp_is_manager('qiunai')));


commit;
