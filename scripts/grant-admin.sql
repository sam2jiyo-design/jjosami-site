-- First create a user in Supabase Authentication > Users, with a strong password.
-- Replace only this email with that existing account. No password belongs in SQL.
do $$declare account uuid;begin
  select id into account from auth.users where email='REPLACE_WITH_ADMIN_EMAIL';
  if account is null then raise exception 'Create the Authentication user first';end if;
  insert into public.admin_users(id,active) values(account,true)
  on conflict(id) do update set active=true;
end$$;
