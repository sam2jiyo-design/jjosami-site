create function public.prune_lookup_cache() returns void language plpgsql security definer set search_path='' as $$begin
 perform pg_advisory_xact_lock(hashtextextended('lookup-cache-prune',0));
 delete from public.songbook_lookup_cache where id in(select id from public.songbook_lookup_cache where expires_at<now() order by expires_at limit 500);
 delete from public.songbook_lookup_cache where id in(select id from public.songbook_lookup_cache order by expires_at desc,id offset 1500 limit 500);
end$$;
revoke all on function public.prune_lookup_cache() from public;
grant execute on function public.prune_lookup_cache() to service_role;
