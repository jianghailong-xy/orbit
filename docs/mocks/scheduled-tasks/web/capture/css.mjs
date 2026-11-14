export const CSS = `
.sx-entry { display:flex; align-items:center; gap:10px; margin:2px 12px 8px; padding:9px 12px; border-radius:8px; cursor:pointer;
  border:1px solid var(--border-subtle); background:var(--bg-subtle); }
.sx-entry.on { background:var(--brand-tint); border-color:var(--brand-border); }
.sx-entry .t { font-weight:600; color:var(--text-1); font-size:14px; line-height:20px; }
.sx-entry .s { color:var(--text-3); font-size:12.5px; line-height:18px; }
.sx-entry .m { flex:1; min-width:0; }
.sx-ico { width:16px; height:16px; flex:none; }
.sx-pill { display:inline-flex; align-items:center; gap:4px; font-size:12px; font-weight:600; line-height:18px; border-radius:999px; padding:1px 8px; white-space:nowrap; flex:none; }
.sx-ok { background:var(--fill-muted); color:var(--text-2); } .sx-new { background:var(--success-bg); color:var(--success); }
.sx-fail { background:var(--error-bg); color:var(--error); } .sx-held { background:var(--warning-bg); color:var(--warning); }
.sx-run { background:var(--brand-tint); color:var(--brand-strong); } .sx-pause { background:var(--fill-muted); color:var(--text-3); }
.sx-mute { color:var(--text-3); border:1px dashed var(--border); padding:0 7px; }
.sx-page { flex:1; overflow:auto; padding:8px 32px 40px; }
.sx-page h3 { font-size:12.5px; font-weight:600; color:var(--text-3); margin:22px 0 8px; }
.sx-table { border:1px solid var(--border-subtle); border-radius:10px; overflow:hidden; }
.sx-tr { display:grid; align-items:center; gap:12px; padding:11px 16px; border-top:1px solid var(--border-subtle); font-size:14px; }
.sx-tr:first-child { border-top:0; }
.sx-tr.hd { background:var(--bg-subtle); color:var(--text-3); font-size:12.5px; padding:7px 16px; }
.sx-tr.sel { background:var(--bg-hover); }
.sx-l { grid-template-columns: minmax(0,2.2fr) 1.5fr 1.3fr 1.6fr 28px; }
.sx-h { grid-template-columns: 128px 104px minmax(0,1fr) 108px 58px; }
.sx-t1 { font-weight:600; color:var(--text-1); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sx-sub { color:var(--text-3); font-size:12.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sx-c2 { color:var(--text-2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sx-dim .sx-t1 { color:var(--text-3); }
.sx-cards { display:grid; grid-template-columns: 1fr 1.6fr; gap:14px; margin-top:16px; }
.sx-card { border:1px solid var(--border-subtle); border-radius:10px; padding:14px 16px; background:var(--bg-raised); }
.sx-card .k { color:var(--text-3); font-size:12.5px; }
.sx-card .n { font-size:22px; font-weight:700; color:var(--text-1); line-height:30px; margin:2px 0; }
.sx-card .z { color:var(--text-3); font-size:12.5px; }
.sx-card a, .sx-link { color:var(--brand); text-decoration:none; }
.sx-set { display:grid; grid-template-columns: 110px 1fr 110px 1fr; gap:8px 14px; font-size:13.5px; }
.sx-set .k { color:var(--text-3); }
.sx-banner { border-radius:10px; padding:11px 14px; font-size:13.5px; line-height:20px; margin-top:14px; display:flex; gap:10px; align-items:flex-start; }
.sx-banner.fail { background:var(--error-bg); border:1px solid var(--error-border); color:#8c1d15; }
.sx-banner.held { background:var(--warning-bg); border:1px solid var(--warning-border); color:#7a4500; }
.sx-banner b { color:inherit; }
.sx-stop { color:var(--error); font-weight:600; font-size:13px; }
.sx-chev { color:var(--text-4); }
.sx-hint { color:var(--text-3); font-size:12.5px; margin-top:8px; }
.sx-mask { position:fixed; inset:0; background:rgba(0,0,0,.35); z-index:50; display:grid; place-items:center; }
.sx-dlg { width:600px; max-height:860px; background:#fff; border-radius:var(--orbit-radius-dialog); box-shadow:0 12px 40px rgba(0,0,0,.2); display:flex; flex-direction:column; }
.sx-dlg .hd { padding:16px 22px 6px; font-size:16px; font-weight:600; display:flex; }
.sx-dlg .hd span { margin-left:auto; color:var(--text-3); font-weight:400; }
.sx-dlg .bd { padding:4px 22px 6px; overflow:hidden; }
.sx-dlg .ft { padding:12px 22px 16px; display:flex; gap:8px; justify-content:flex-end; border-top:1px solid var(--border-subtle); }
.sx-f { margin-top:12px; } .sx-f > label { display:block; font-size:13px; color:var(--text-2); margin-bottom:5px; font-weight:500; }
.sx-in { border:1px solid var(--border); border-radius:6px; padding:5px 11px; font-size:14px; min-height:32px; color:var(--text-1); background:#fff; }
.sx-in.ta { min-height:76px; line-height:21px; padding:7px 11px; }
.sx-row { display:flex; gap:10px; } .sx-row > * { flex:1; }
.sx-seg { display:inline-flex; border:1px solid var(--border); border-radius:6px; overflow:hidden; }
.sx-seg span { padding:5px 14px; font-size:13.5px; border-left:1px solid var(--border); } .sx-seg span:first-child { border-left:0; }
.sx-seg span.on { background:var(--brand-tint); color:var(--brand); font-weight:600; }
.sx-opt { display:flex; gap:10px; align-items:flex-start; border:1px solid var(--border); border-radius:8px; padding:9px 12px; font-size:13.5px; }
.sx-opt.on { border-color:var(--brand); background:var(--brand-tint); }
.sx-opt .r { width:16px; height:16px; border-radius:50%; border:1.5px solid #c9cdd4; margin-top:2px; flex:none; background:#fff; }
.sx-opt.on .r { border:5px solid var(--brand); }
.sx-opt .d { color:var(--text-3); font-size:12.5px; }
.sx-btn { border:1px solid var(--border); border-radius:6px; padding:5px 15px; font-size:14px; background:#fff; color:var(--text-1); }
.sx-btn.pri { background:var(--brand); border-color:var(--brand); color:#fff; }
.sx-btn.dis { color:var(--text-4); }
.sx-btn.danger { color:var(--error); border-color:transparent; margin-right:auto; padding-left:0; }
.sx-chatcard { border:1px solid var(--border); border-radius:10px; max-width:560px; margin:10px 0 0 16px; overflow:hidden; background:#fff; }
.sx-chatcard .hd { display:flex; gap:8px; align-items:center; padding:11px 14px 4px; font-weight:600; }
.sx-chatcard .kv { display:grid; grid-template-columns:86px 1fr; gap:3px 12px; padding:6px 14px 12px; font-size:13.5px; }
.sx-chatcard .kv .k { color:var(--text-3); }
.sx-chatcard .ft { display:flex; gap:8px; padding:10px 14px; border-top:1px solid var(--border-subtle); background:var(--bg-subtle); justify-content:flex-end; }
.sx-strip { display:flex; gap:8px; align-items:center; font-size:13px; color:var(--text-2); background:var(--bg-subtle); border:1px solid var(--border-subtle); border-radius:8px; padding:7px 12px; margin:14px 0 4px; }
.sx-report { border:1px solid var(--border-subtle); border-left:3px solid var(--success-solid); border-radius:8px; padding:10px 14px; font-size:14px; line-height:22px; margin:12px 0 0 16px; max-width:640px; }
.sx-report .h { font-weight:600; display:flex; gap:6px; align-items:center; }
.sx-mk { position:absolute; width:22px; height:22px; border-radius:50%; background:#d93838; color:#fff; font:700 12.5px/22px sans-serif; text-align:center; z-index:99; box-shadow:0 0 0 2px #fff; }
`;
export const I = {
  cal: '<svg class="sx-ico" viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2 6.5h12M5.5 1.6v2.6M10.5 1.6v2.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  warn: '<svg class="sx-ico" style="width:12px;height:12px" viewBox="0 0 16 16"><path d="M8 1.8 15 14H1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 6.2v3.6M8 11.6v.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  spin: '<svg class="sx-ico" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="2"/><path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  check: '<svg class="sx-ico" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m5.2 8.2 2 2 3.8-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  pause: '<svg class="sx-ico" style="width:11px;height:11px" viewBox="0 0 16 16"><path d="M5.5 3.5v9M10.5 3.5v9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};
export const P = (cls, t) => `<span class="sx-pill ${cls}">${t}</span>`;
