-- Run once on an existing deployment to allow an empty or omitted entry reason.
create or replace function public.write_entry(p_data jsonb,p_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 r jsonb; a uuid; i uuid; v integer;
 d numeric := (p_data->>'quantity')::numeric;
 k text := p_data->>'kind';
 entry_reason text := coalesce(trim(p_data->>'reason'),'');
begin
 perform public.assert_admin();
 r=public.operation_begin('entry',p_key,p_data);
 if r is not null then return r; end if;
 if k not in ('acquire','adjust','fulfill','invalidate','set') then raise exception 'INVALID_KIND'; end if;
 if k in ('acquire','fulfill','invalidate') and d<=0 then raise exception 'INVALID_QUANTITY'; end if;
 perform 1 from public.obligation_types where id=(p_data->>'typeId')::uuid and active;
 if not found then raise exception 'TYPE_NOT_FOUND'; end if;
 a=public.ensure_account(p_data->>'soop',p_data->>'nickname',(p_data->>'typeId')::uuid);
 select version into v from public.obligation_accounts where id=a for update;
 if p_data ? 'expectedVersion' and v is distinct from (p_data->>'expectedVersion')::integer then
  raise exception 'VERSION_CONFLICT' using errcode='40001';
 end if;
 if k='set' then
  if not p_data ? 'expectedVersion' then raise exception 'VERSION_REQUIRED'; end if;
  select d-coalesce(sum(delta),0) into d from public.obligation_ledger where account_id=a;
  k='adjust';
 end if;
 if k in ('fulfill','invalidate') then d=-d; end if;
 if d<>0 then i=public.append_ledger(a,d,k,entry_reason); end if;
 perform public.audit('ledger.'||k,a::text,jsonb_build_object('delta',d));
 return public.operation_finish('entry',p_key,jsonb_build_object('id',i,'accountId',a));
end
$$;
