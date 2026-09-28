-- Hide deleted records without losing financial history or event deduplication.
-- Re-running this migration is safe.
alter table public.obligation_accounts add column if not exists deleted_at timestamptz;
alter table public.photo_requests add column if not exists deleted_at timestamptz;
alter table public.obligation_accounts drop constraint if exists obligation_accounts_viewer_id_type_id_key;
create unique index if not exists obligation_accounts_active_viewer_type on public.obligation_accounts(viewer_id,type_id) where deleted_at is null;

create or replace function public.ensure_account(p_soop text,p_nickname text,p_type uuid) returns uuid language plpgsql security definer set search_path='' as $$declare v uuid;a uuid;begin insert into public.viewer_accounts(soop_id,nickname) values(trim(p_soop),trim(p_nickname)) on conflict(soop_id) do update set nickname=excluded.nickname returning id into v;insert into public.obligation_accounts(viewer_id,type_id) values(v,p_type) on conflict(viewer_id,type_id) where deleted_at is null do update set viewer_id=excluded.viewer_id returning id into a;return a;end$$;

create or replace function public.append_ledger(p_account uuid,p_delta numeric,p_kind text,p_reason text,p_event uuid default null,p_request uuid default null,p_reverse uuid default null) returns uuid language plpgsql security definer set search_path='' as $$declare i uuid;b numeric;whole boolean;begin perform 1 from public.obligation_accounts where id=p_account and (deleted_at is null or p_kind='request_reopen') for update;if not found then raise exception 'ACCOUNT_NOT_FOUND';end if;select t.integer_only into whole from public.obligation_types t join public.obligation_accounts a on a.type_id=t.id where a.id=p_account;if p_delta=0 or p_delta<>round(p_delta,3) or (whole and p_delta<>trunc(p_delta)) then raise exception 'INVALID_QUANTITY';end if;select coalesce(sum(delta),0) into b from public.obligation_ledger where account_id=p_account;if b+p_delta<0 then raise exception 'NEGATIVE_BALANCE';end if;insert into public.obligation_ledger(account_id,delta,kind,reason,source_event_id,source_request_id,reverse_of,created_by) values(p_account,p_delta,p_kind,p_reason,p_event,p_request,p_reverse,auth.uid()) returning id into i;update public.obligation_accounts set version=version+1 where id=p_account;return i;end$$;

create or replace function public.edit_request(p_id uuid,p_data jsonb,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$declare result jsonb;r public.photo_requests;s text:=p_data->>'status';a uuid:=(p_data->>'accountId')::uuid;q numeric:=(p_data->>'quantity')::numeric;i uuid;e public.obligation_ledger;begin perform public.assert_admin();result=public.operation_begin('request.edit',p_key,jsonb_build_object('id',p_id,'data',p_data));if result is not null then return result;end if;select * into r from public.photo_requests where id=p_id and deleted_at is null for update;if not found or r.version is distinct from (p_data->>'expectedVersion')::integer then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 if s<>r.status then if not coalesce((p_data->>'confirmed')::boolean,false) then raise exception 'CONFIRM_REQUIRED';end if;
 if not(case r.status when 'received' then s in ('reviewing','on_hold','cancelled') when 'reviewing' then s in ('in_progress','on_hold','cancelled') when 'in_progress' then s in ('completed','on_hold','cancelled') when 'on_hold' then s in ('reviewing','cancelled') when 'completed' then s='reviewing' when 'cancelled' then s='reviewing' else false end) then raise exception 'INVALID_TRANSITION';end if;
 if r.status in ('completed','cancelled') and length(trim(p_data->>'reason'))=0 then raise exception 'REASON_REQUIRED';end if;end if;
 if r.status='completed' then a=r.account_id;q=r.quantity;end if;
 if a is not null and r.status<>'completed' and not coalesce((p_data->>'verified')::boolean,false) then raise exception 'ACCOUNT_VERIFICATION_REQUIRED';end if;
 if a is not null then perform 1 from public.obligation_accounts oa join public.obligation_types ot on ot.id=oa.type_id where oa.id=a and (oa.deleted_at is null or r.status='completed') and (not ot.integer_only or q=trunc(q)) for update of oa;if not found then raise exception 'INVALID_QUANTITY';end if;end if;
 i=r.completion_entry;
 if s='completed' and r.status<>s and a is not null then i=public.append_ledger(a,-q,'request_complete','방셀 신청 완료',null,p_id);end if;
 if r.status='completed' and s<>r.status and r.completion_entry is not null then select * into e from public.obligation_ledger where id=r.completion_entry;perform public.append_ledger(e.account_id,-e.delta,'request_reopen',p_data->>'reason',null,p_id,e.id);i=null;end if;
 if r.status='completed' and s<>r.status and exists(select 1 from public.obligation_accounts where id=a and deleted_at is not null) then a=null;end if;
 update public.photo_requests set status=s,memo=p_data->>'memo',account_id=a,quantity=q,completion_entry=i,version=version+1 where id=p_id;perform public.audit('request.'||s,p_id::text,jsonb_build_object('from',r.status,'accountId',a));return public.operation_finish('request.edit',p_key,jsonb_build_object('id',p_id,'version',r.version+1));end$$;

create or replace function public.read_accounts(p_q text default '',p_type uuid default null,p_remaining boolean default false,p_page integer default 1,p_size integer default 20) returns jsonb language sql stable security definer set search_path='' as $$with rows as(select a.id,v.soop_id as soop,v.nickname,a.type_id as "typeId",t.name as item,t.unit,t.integer_only as integer,a.version,coalesce(sum(l.delta) filter(where l.kind in ('acquire','roulette')),0) as acquired,coalesce(sum(l.delta) filter(where l.kind in ('adjust','invalidate','reverse','request_reopen')),0) as adjusted,-coalesce(sum(l.delta) filter(where l.kind in ('fulfill','request_complete')),0) as fulfilled,coalesce(sum(l.delta),0) as balance from public.obligation_accounts a join public.viewer_accounts v on v.id=a.viewer_id join public.obligation_types t on t.id=a.type_id left join public.obligation_ledger l on l.account_id=a.id where a.deleted_at is null and (p_type is null or t.id=p_type) and (p_q='' or position(lower(p_q) in lower(v.nickname||' '||v.soop_id))>0) group by a.id,v.soop_id,v.nickname,t.name,t.unit,t.integer_only),filtered as(select * from rows where not p_remaining or balance>0),paged as(select * from filtered order by nickname collate "C",soop collate "C",id limit least(greatest(p_size,1),100) offset (greatest(p_page,1)-1)*least(greatest(p_size,1),100))select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(paged)) from paged),'[]'),'total',(select count(*) from filtered))$$;

create or replace function public.read_public_history(p_account uuid,p_page integer default 1) returns jsonb language sql stable security definer set search_path='' as $$select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (select l.id,l.account_id as "accountId",l.delta,l.kind,l.created_at as time,exists(select 1 from public.obligation_ledger r where r.reverse_of=l.id) as reversed from public.obligation_ledger l where l.account_id=p_account and exists(select 1 from public.obligation_accounts a where a.id=l.account_id and a.deleted_at is null) order by l.created_at desc,l.id limit 50 offset (greatest(p_page,1)-1)*50)x$$;

create or replace function public.delete_obligation(p_id uuid,p_version integer,p_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; a public.obligation_accounts;
begin
 perform public.assert_admin();
 result=public.operation_begin('obligation.delete',p_key,jsonb_build_object('id',p_id,'version',p_version));
 if result is not null then return result;end if;
 -- Match edit_request's request-before-account lock order.
 perform 1 from public.photo_requests where account_id=p_id and deleted_at is null order by id for update;
 select * into a from public.obligation_accounts where id=p_id and deleted_at is null for update;
 if not found or a.version is distinct from p_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 update public.obligation_accounts set deleted_at=now(),version=version+1 where id=p_id;
 -- Pending applications can still be processed independently or linked to a new account.
 update public.photo_requests set account_id=null,version=version+1 where account_id=p_id and status<>'completed' and deleted_at is null;
 perform public.audit('obligation.delete',p_id::text);
 return public.operation_finish('obligation.delete',p_key,jsonb_build_object('id',p_id,'deleted',true));
end$$;

create or replace function public.delete_photo_request(p_id uuid,p_version integer,p_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; r public.photo_requests;
begin
 perform public.assert_admin();
 result=public.operation_begin('request.delete',p_key,jsonb_build_object('id',p_id,'version',p_version));
 if result is not null then return result;end if;
 select * into r from public.photo_requests where id=p_id and deleted_at is null for update;
 if not found or r.version is distinct from p_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 -- Deleting a completed application does not refund an already fulfilled obligation.
 update public.photo_requests set deleted_at=now(),version=version+1 where id=p_id;
 perform public.audit('request.delete',p_id::text,jsonb_build_object('status',r.status));
 return public.operation_finish('request.delete',p_key,jsonb_build_object('id',p_id,'deleted',true));
end$$;

-- Apply the same visibility to direct authenticated reads and the admin ledger API.
drop policy if exists admin_read on public.obligation_accounts;
create policy admin_read on public.obligation_accounts for select to authenticated using ((select public.is_admin()) and deleted_at is null);
drop policy if exists admin_read on public.photo_requests;
create policy admin_read on public.photo_requests for select to authenticated using ((select public.is_admin()) and deleted_at is null);
drop policy if exists admin_read on public.obligation_ledger;
create policy admin_read on public.obligation_ledger for select to authenticated using ((select public.is_admin()) and exists(select 1 from public.obligation_accounts a where a.id=account_id and a.deleted_at is null));
revoke all on function public.delete_obligation(uuid,integer,uuid),public.delete_photo_request(uuid,integer,uuid) from public;
grant execute on function public.delete_obligation(uuid,integer,uuid),public.delete_photo_request(uuid,integer,uuid) to authenticated;
