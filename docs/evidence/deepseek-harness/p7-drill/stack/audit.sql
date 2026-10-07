-- every init event per session, with its provider row's runtime: a Claude-runtime session must never init on a dsh ACP id
with inits as (
  select s.title, s.provider, coalesce(mp.runtime, s.provider) as runtime, s.runtime_session_id,
         e.payload->>'provider' as init_provider, e.payload->>'sessionId' as init_sid, e.payload->>'resumed' as resumed
  from session s join run_event e on e.session_id = s.id
  left join model_provider mp on mp.slug = s.provider
  where e.type = 'system' and e.payload->>'subtype' = 'init' and s.title like 'P7%' or (e.type='system' and e.payload->>'subtype'='init' and s.title like 'P6r2 real smoke%'))
select runtime, provider, title, init_provider, init_sid, resumed from inits order by title, init_sid;
select 'claude-runtime inits carrying a dsh ACP id', count(*) from run_event e join session s on s.id=e.session_id
  left join model_provider mp on mp.slug=s.provider
  where e.type='system' and e.payload->>'subtype'='init' and coalesce(mp.runtime, s.provider) <> 'dsh'
  and e.payload->>'sessionId' in (select runtime_session_id from session s2 join model_provider m2 on m2.slug=s2.provider where m2.runtime='dsh' and s2.runtime_session_id is not null);
