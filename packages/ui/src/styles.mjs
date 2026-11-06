// Team UI stylesheet. Colors inherit the upstream theme aliases (dsh-client-ui-theme); only the
// "unknown" purple has no upstream alias and is defined here for light/dark (09 §2.3).
export const CSS = String.raw`
.tm{--tm-fg:var(--dsw-alias-label-primary);--tm-fg2:var(--dsw-alias-label-secondary);--tm-fg3:var(--dsw-alias-label-tertiary);--tm-cap:var(--dsw-alias-label-caption);
--tm-line:var(--dsw-alias-border-l1);--tm-line2:var(--dsw-alias-border-l2);--tm-hover:var(--dsw-alias-interactive-bg-hover);--tm-active:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover));
--tm-bg:var(--dsw-alias-bg-base);--tm-bg1:var(--dsw-alias-bg-layer-1);--tm-bg2:var(--dsw-alias-bg-layer-2);
--tm-ok:var(--dsw-alias-label-secondary);--tm-wait:var(--dsw-static-blue-500,#3b82f6);--tm-warn:var(--dsw-alias-state-warn-primary,#f59e0b);
--tm-bad:var(--dsw-alias-state-error-primary,#ec1313);--tm-unknown:#7c3aed;--tm-idle:var(--dsw-alias-state-idle-primary,#8a8f98);--tm-done:var(--dsw-alias-state-success-primary,#22c55e);
--tm-accent:var(--dsw-alias-state-business-primary,#4176e6);--tm-mono:var(--dsh-font-family-code,var(--dsh-font-family-code-default,ui-monospace,monospace));
color:var(--tm-fg);font-size:13px;line-height:1.45;font-family:var(--dsw-font-family,inherit);-webkit-font-smoothing:antialiased}
body[data-ds-dark-theme] .tm{--tm-unknown:#a78bfa;--tm-wait:var(--dsw-static-blue-400,#60a5fa)}
.tm *{box-sizing:border-box}
.tm .num,.tm .mono{font-family:var(--tm-mono);font-variant-numeric:tabular-nums;font-size:12px;letter-spacing:-.01em}
.tm [data-sev=bad]{--sev:var(--tm-bad)}.tm [data-sev=unknown]{--sev:var(--tm-unknown)}.tm [data-sev=warn]{--sev:var(--tm-warn)}
.tm [data-sev=wait]{--sev:var(--tm-wait)}.tm [data-sev=ok]{--sev:var(--tm-ok)}.tm [data-sev=frozen],.tm [data-sev=retired]{--sev:var(--tm-idle)}.tm [data-sev=done]{--sev:var(--tm-done)}
.tm-glyph{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;color:var(--sev);font-size:11px;line-height:1;font-family:var(--tm-mono)}
.tm-glyph[data-sev=bad]{font-size:10px}.tm-glyph[data-sev=ok]{font-size:9px}
.tm-glyph[data-sev=unknown]{font-weight:700;font-size:10px;width:14px;height:14px;margin:1px;border:1.5px solid var(--sev);border-radius:2px;transform:rotate(45deg)}
.tm-glyph[data-sev=unknown]>span{transform:rotate(-45deg)}
.tm-sevtext{color:var(--sev)}
.tm button{font:inherit;color:inherit}
.tm-btn{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--tm-line2);background:transparent;cursor:pointer;font-size:12px;white-space:nowrap;color:var(--tm-fg)}
.tm-btn:hover{background:var(--tm-hover)}.tm-btn:disabled{opacity:.45;cursor:not-allowed}
.tm-btn[aria-pressed=true]{background:var(--tm-active);border-color:var(--tm-fg3)}
/* Scoped as ".tm .tm-btn-primary" (0,2,0) on purpose: the generic ".tm button" colour rule (0,1,1) is more
   specific than a bare class and silently replaced this text colour with the page foreground -- the label became the
   same colour as its own fill (both #f9fafb in the dark theme). The fill is --tm-fg and the text --tm-bg1, a pair that
   inverts in light (dark on white) and dark (near-white on dark) themes. */
.tm .tm-btn-primary{background:var(--tm-fg);color:var(--tm-bg1);border-color:transparent;font-weight:500}
.tm .tm-btn-primary:hover{background:var(--tm-fg);opacity:.88}
.tm .tm-btn-primary:disabled{background:color-mix(in srgb,var(--tm-fg) 10%,transparent);color:var(--tm-fg3);opacity:1}
.tm-btn-ghost{border-color:transparent}
.tm-kbd{font-family:var(--tm-mono);font-size:10.5px;color:var(--tm-cap);border:1px solid var(--tm-line2);border-radius:4px;padding:0 4px;line-height:15px}
.tm :focus-visible{outline:2px solid var(--tm-accent);outline-offset:1px;border-radius:4px}
.tm-cap{color:var(--tm-cap)}.tm-fg2{color:var(--tm-fg2)}.tm-fg3{color:var(--tm-fg3)}
.tm-section-title{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--tm-fg3);margin:0 0 6px;height:22px}
.tm-section-title .tm-spacer{flex:1}
.tm-badge{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border-radius:9px;font-size:11px;border:1px solid var(--tm-line2);color:var(--tm-fg2);white-space:nowrap}
.tm-badge[data-sev]{color:var(--sev);border-color:color-mix(in srgb,var(--sev) 40%,transparent);background:color-mix(in srgb,var(--sev) 8%,transparent)}
.tm-mock{border-style:dashed;color:var(--tm-fg3)}

/* ── page ─────────────────────────────────────────── */
.tm-page{position:relative;height:100%;min-height:0;display:flex;flex-direction:column;container-type:inline-size;container-name:tmpage;background:var(--tm-bg1);outline:none}
.tm-situation{flex:none;height:40px;display:flex;align-items:center;gap:2px;padding:0 12px 0 16px;border-bottom:1px solid var(--tm-line2);overflow:hidden;white-space:nowrap}
.tm-situation[data-fresh=lagging]{box-shadow:inset 0 0 0 1.5px var(--tm-warn)}
.tm-situation[data-fresh=stale],.tm-situation[data-fresh=error]{box-shadow:inset 0 0 0 1.5px var(--tm-unknown)}
.tm-goal{display:flex;align-items:center;gap:8px;min-width:0;margin-right:10px}
.tm-goal-tag{font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--tm-fg3)}
.tm-goal-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;max-width:220px}
.tm-metric{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px;border-radius:6px;color:var(--tm-fg2);font-size:12px;border:0;background:none;cursor:default}
button.tm-metric{cursor:pointer}button.tm-metric:hover{background:var(--tm-hover)}
.tm-metric b{font-family:var(--tm-mono);font-variant-numeric:tabular-nums;font-weight:600;color:var(--tm-fg);font-size:12.5px}
.tm-metric[data-sev] b{color:var(--sev)}
.tm-metric[data-hot=true]{background:color-mix(in srgb,var(--tm-bad) 10%,transparent);color:var(--tm-bad)}
.tm-metric[data-hot=true] b{color:var(--tm-bad)}
.tm-sep{width:1px;height:16px;background:var(--tm-line2);margin:0 4px;flex:none}
.tm-fresh{margin-left:auto;display:inline-flex;align-items:center;gap:8px;color:var(--tm-fg3);font-size:12px}
.tm-fresh[data-level=lagging]{color:var(--tm-warn)}.tm-fresh[data-level=stale],.tm-fresh[data-level=error]{color:var(--tm-unknown)}
/* 15 §9 V-23: green is reserved for accepted work; a live connection is not an acceptance (it uses the wait token). */
.tm-dot{width:6px;height:6px;border-radius:50%;background:var(--tm-wait);flex:none}
.tm-fresh[data-level=lagging] .tm-dot{background:var(--tm-warn)}.tm-fresh[data-level=stale] .tm-dot,.tm-fresh[data-level=error] .tm-dot{background:var(--tm-unknown)}
.tm-body{flex:1;min-height:0;display:flex}
.tm-center{flex:1;min-width:0;overflow:auto;padding:14px 16px 24px;display:flex;flex-direction:column;gap:18px;scrollbar-gutter:stable}
.tm-stale-veil .tm-count-box{outline:1px dashed var(--tm-unknown);outline-offset:2px;text-decoration:line-through}
.tm-alert{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;font-size:12px;border:1px solid color-mix(in srgb,var(--sev) 35%,transparent);background:color-mix(in srgb,var(--sev) 7%,transparent);color:var(--tm-fg)}
.tm-alert .tm-spacer{flex:1}

/* needs you */
.tm-needs{border:1px solid var(--tm-line2);border-radius:10px;overflow:hidden;background:var(--tm-bg1)}
.tm-need{position:relative;display:grid;grid-template-columns:18px minmax(0,1fr) auto auto auto;align-items:center;gap:10px;height:38px;padding:0 10px 0 14px;border-top:1px solid var(--tm-line)}
.tm-need:first-child{border-top:0}
.tm-need:before{content:"";position:absolute;left:0;top:7px;bottom:7px;width:3px;border-radius:0 2px 2px 0;background:var(--sev)}
.tm-need[data-sev=wait]:before,.tm-need[data-sev=ok]:before{opacity:.5}
.tm-need-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;border:0;background:none;padding:0;text-align:left}
.tm-need-title:hover{text-decoration:underline;text-underline-offset:3px}
.tm-need-kind{font-size:11px;color:var(--tm-fg3);margin-right:6px}
.tm-need-when{min-width:64px;text-align:right}
.tm-empty{padding:14px;color:var(--tm-fg3);font-size:12.5px}
.tm-more{width:100%;text-align:left;border:0;border-top:1px solid var(--tm-line);background:none;padding:8px 14px;color:var(--tm-fg3);font-size:12px;cursor:pointer}
.tm-more:hover{background:var(--tm-hover)}

/* lanes */
.tm-lanes{--row:32px;border:1px solid var(--tm-line2);border-radius:10px;overflow:hidden;background:var(--tm-bg1)}
.tm-lanes[data-density=compact]{--row:24px}
.tm-lane-grid{display:grid;grid-template-columns:20px minmax(112px,.85fr) minmax(136px,1fr) minmax(176px,1.35fr) 56px 126px 30px 56px;align-items:center;column-gap:4px}
.tm-lane-head{height:30px;padding:0 10px;border-bottom:1px solid var(--tm-line2);font-size:11px;color:var(--tm-fg3);position:sticky;top:0;background:var(--tm-bg1);z-index:1}
.tm-lane-head>div{overflow:hidden;white-space:nowrap}
.tm-group{display:flex;align-items:center;gap:8px;height:30px;padding:0 10px;border-top:1px solid var(--tm-line);background:color-mix(in srgb,var(--tm-fg) 2.5%,transparent);cursor:pointer;user-select:none;width:100%;border-left:0;border-right:0;border-bottom:0;text-align:left;font-size:12px}
.tm-group:hover{background:var(--tm-hover)}
.tm-group .tm-caret{width:14px;color:var(--tm-fg3);font-size:10px;transition:transform .15s}
.tm-group[aria-expanded=false] .tm-caret{transform:rotate(-90deg)}
.tm-group-name{font-weight:600}
.tm-group-sum{display:flex;align-items:center;gap:8px;color:var(--tm-fg3);font-size:12px;margin-left:4px}
.tm-tally{display:inline-flex;align-items:center;gap:2px}
.tm-row{height:var(--row);padding:0 10px;border-top:1px solid var(--tm-line);cursor:default;position:relative;transition:background .15s}
.tm-row:hover{background:var(--tm-hover)}
.tm-row[aria-selected=true]{background:color-mix(in srgb,var(--tm-accent) 9%,transparent)}
.tm-row[aria-selected=true]:before{content:"";position:absolute;left:0;top:4px;bottom:4px;width:2px;background:var(--tm-accent);border-radius:0 2px 2px 0}
.tm-row[data-sev=bad]{background-image:linear-gradient(90deg,color-mix(in srgb,var(--tm-bad) 7%,transparent),transparent 40%)}
.tm-row[data-sev=unknown]{background-image:linear-gradient(90deg,color-mix(in srgb,var(--tm-unknown) 8%,transparent),transparent 40%)}
.tm-row[data-sev=frozen],.tm-row[data-sev=retired]{opacity:.55}
.tm-row[data-flash=true]{animation:tm-flash 2s ease-out}
@keyframes tm-flash{0%,30%{box-shadow:inset 0 0 0 1.5px var(--tm-accent);background-color:color-mix(in srgb,var(--tm-accent) 14%,transparent)}100%{box-shadow:inset 0 0 0 0 transparent}}
.tm-row>div{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0}
.tm-name{display:flex;align-items:baseline;gap:6px}
.tm-name strong{font-weight:500;overflow:hidden;text-overflow:ellipsis}
.tm-role{font-family:var(--tm-mono);font-size:10.5px;color:var(--tm-fg3);border:1px solid var(--tm-line2);border-radius:3px;padding:0 3px;line-height:14px;flex:none}
.tm-task{display:flex;gap:6px;align-items:baseline}
.tm-task-state{color:var(--tm-fg3);font-size:12px}
.tm-task-state[data-sev]{color:var(--sev)}
.tm-wait{display:flex;align-items:baseline;gap:5px;color:var(--tm-fg2)}
.tm-wait[data-sev] .tm-wait-left{color:var(--sev)}
.tm-link{border:0;background:none;padding:0;color:var(--tm-fg);text-decoration:underline;text-decoration-color:var(--tm-line2);text-underline-offset:3px;cursor:pointer}
.tm-link:hover{text-decoration-color:currentColor}
.tm-ack{display:flex;align-items:center;gap:6px}
.tm-dots{display:inline-flex;gap:2px}
.tm-dots i{width:6px;height:6px;border-radius:50%;border:1.2px solid var(--tm-fg3);display:block}
.tm-dots i[data-on=true]{background:var(--tm-fg2);border-color:var(--tm-fg2)}
.tm-dots[data-sev=bad] i[data-on=false]{border-color:var(--tm-bad)}
.tm-ctx{display:flex;align-items:center;gap:6px}
.tm-bar{position:relative;width:64px;height:6px;border-radius:3px;background:color-mix(in srgb,var(--tm-fg) 9%,transparent);flex:none;overflow:visible}
.tm-bar-fill{position:absolute;left:0;top:0;bottom:0;border-radius:3px;background:var(--tm-fg3)}
.tm-bar[data-level=warn] .tm-bar-fill{background:var(--tm-warn)}
.tm-bar[data-level=bad] .tm-bar-fill{background:var(--tm-bad)}
.tm-bar-tick{position:absolute;top:-2px;bottom:-2px;width:1.5px;left:80%;background:var(--tm-warn);opacity:.9;border-radius:1px}
.tm-ctx-pct{min-width:28px;text-align:right}
.tm-ctx[data-level=bad] .tm-ctx-pct{color:var(--tm-bad)}.tm-ctx[data-level=warn] .tm-ctx-pct{color:var(--tm-warn)}
.tm-capped{font-size:10px;color:var(--tm-bad);border:1px solid color-mix(in srgb,var(--tm-bad) 45%,transparent);border-radius:3px;padding:0 3px;line-height:13px}
.tm-fold-off{color:var(--tm-fg3);opacity:.7}
.tm-lease-bad{color:var(--tm-bad)}
.tm-restricted{display:flex;align-items:center;gap:8px;height:28px;padding:0 12px;border-top:1px solid var(--tm-line);color:var(--tm-fg3);font-size:12px}
.tm-toolbar{display:flex;align-items:center;gap:6px}

/* pipeline */
.tm-pipe{display:flex;align-items:stretch;gap:0}
.tm-stage{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;padding:9px 12px;border:1px solid var(--tm-line2);margin-left:-1px;background:var(--tm-bg1);cursor:pointer;text-align:left;position:relative}
.tm-stage:first-child{border-radius:10px 0 0 10px;margin-left:0}.tm-stage:last-child{border-radius:0 10px 10px 0}
.tm-stage:hover{background:var(--tm-hover)}
.tm-stage[aria-pressed=true]{background:color-mix(in srgb,var(--tm-accent) 10%,transparent);border-color:color-mix(in srgb,var(--tm-accent) 50%,transparent);z-index:1}
.tm-stage-label{font-size:11.5px;color:var(--tm-fg3);display:flex;align-items:center;gap:5px}
.tm-stage-count{font-family:var(--tm-mono);font-variant-numeric:tabular-nums;font-size:20px;font-weight:600;line-height:1.15}
.tm-stage[data-end=produced] .tm-stage-label:before{content:"";width:8px;height:8px;border-radius:2px;border:1.5px dashed var(--tm-fg3)}
.tm-stage[data-end=accepted]{background:color-mix(in srgb,var(--tm-done) 8%,var(--tm-bg1))}
.tm-stage[data-end=accepted] .tm-stage-count,.tm-stage[data-end=accepted] .tm-stage-label{color:var(--tm-done)}
.tm-stage-arrow{position:absolute;right:-7px;top:50%;transform:translateY(-50%);width:12px;height:12px;z-index:2;color:var(--tm-fg3);font-size:11px;line-height:12px;text-align:center;background:var(--tm-bg1);border-radius:50%}

/* detail */
.tm-detail{flex:none;width:344px;border-left:1px solid var(--tm-line2);display:flex;flex-direction:column;min-height:0;background:var(--tm-bg1)}
.tm-tabs{flex:none;display:flex;gap:2px;height:40px;align-items:flex-end;padding:0 10px;border-bottom:1px solid var(--tm-line2)}
.tm-tab{border:0;background:none;padding:0 9px;height:34px;font-size:12.5px;color:var(--tm-fg3);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.tm-tab:hover{color:var(--tm-fg)}
.tm-tab[aria-selected=true]{color:var(--tm-fg);border-bottom-color:var(--tm-fg);font-weight:500}
.tm-detail-body{flex:1;min-height:0;overflow:auto;padding:14px 16px 20px;display:flex;flex-direction:column;gap:14px}
.tm-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tm-card-head h3{margin:0;font-size:14px;font-weight:600}
.tm-kv{display:grid;grid-template-columns:76px minmax(0,1fr);gap:6px 10px;font-size:12.5px;align-items:baseline}
.tm-kv>dt{color:var(--tm-fg3);margin:0}.tm-kv>dd{margin:0;min-width:0;overflow-wrap:anywhere}
.tm-hr{height:1px;background:var(--tm-line2);border:0;margin:0}
.tm-actions{display:flex;flex-wrap:wrap;gap:6px}
.tm-sub{font-size:12px;color:var(--tm-fg3)}
.tm-list{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.tm-li{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer;font-size:12.5px;border:0;background:none;width:100%;text-align:left}
.tm-li:hover{background:var(--tm-hover)}.tm-li[aria-current=true]{background:var(--tm-active)}
.tm-li .tm-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tm-history{display:flex;flex-wrap:wrap;gap:3px;align-items:center;font-size:11.5px;color:var(--tm-fg3)}
.tm-history b{font-weight:500;color:var(--tm-fg)}
.tm-dl-bar{position:relative;height:4px;border-radius:2px;background:color-mix(in srgb,var(--tm-fg) 9%,transparent);margin-top:4px;overflow:hidden}
.tm-dl-bar>i{position:absolute;left:0;top:0;bottom:0;background:var(--sev);border-radius:2px}
.tm-resp{display:flex;flex-wrap:wrap;gap:6px}
.tm-reply{border-left:2px solid var(--tm-line2);padding:2px 0 2px 10px;font-size:12.5px}
.tm-reply q{quotes:"“" "”"}
.tm-quote-src{font-size:11px;color:var(--tm-fg3)}
.tm-msg{border:1px solid var(--tm-line2);border-radius:8px;padding:9px 11px;display:flex;flex-direction:column;gap:6px;font-size:12.5px}
.tm-msg[data-sev=bad]{border-color:color-mix(in srgb,var(--tm-bad) 45%,transparent)}
.tm-msg-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.tm-receipts{display:grid;grid-template-columns:62px 12px 64px minmax(0,1fr);gap:3px 6px;align-items:center;font-size:12px}
.tm-receipts .tm-r-dot{width:7px;height:7px;border-radius:50%;border:1.2px solid var(--tm-fg3)}
.tm-receipts .tm-r-dot[data-on=true]{background:var(--tm-fg2);border-color:var(--tm-fg2)}
.tm-filters{display:flex;gap:6px;flex-wrap:wrap}
.tm-chip{height:24px;padding:0 9px;border-radius:12px;border:1px solid var(--tm-line2);background:none;font-size:12px;cursor:pointer;color:var(--tm-fg2)}
.tm-chip[aria-pressed=true]{background:var(--tm-fg);color:var(--tm-bg1);border-color:transparent}
.tm-ctx-big .tm-bar{width:100%;height:8px}
.tm-fold-rec{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:12px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--tm-fg) 3%,transparent)}
.tm-mut{color:var(--tm-fg3);font-size:12px}
.tm-note{font-size:11.5px;color:var(--tm-fg3);line-height:1.5}

/* drawers & responsive */
.tm-scrim{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.25));z-index:20}
.tm-drawer{position:absolute;top:0;bottom:0;right:0;width:min(380px,92%);z-index:21;box-shadow:var(--dsw-elevation-prominent);border-left:1px solid var(--tm-line2)}
.tm-bottom{display:none}
.tm-only-narrow{display:none}
@container tmpage (max-width:1099px){.tm-detail.tm-inline{display:none}.tm-only-mid{display:inline-flex}}
@container tmpage (min-width:1100px){.tm-only-mid{display:none}}
@container tmpage (max-width:760px){
 .tm-lane-grid{grid-template-columns:22px minmax(90px,1fr) minmax(90px,1fr) 82px}
 .tm-col-task,.tm-col-ack,.tm-col-fold,.tm-col-lease{display:none!important}
 .tm-bar{width:40px}
 .tm-situation{padding:0 8px;gap:0}.tm-goal-title,.tm-goal-tag,.tm-situation .tm-sep{display:none}.tm-goal{margin-right:2px}
 .tm-metric{padding:0 5px;gap:3px}.tm-metric-long{display:none}
 .tm-fresh-text,.tm-mock-label,.tm-gate{display:none}.tm-capped{display:none}
 .tm-center{padding:10px 10px 64px}
 .tm-pipe{flex-wrap:wrap}.tm-stage{flex:1 1 30%;border-radius:0!important;margin:-1px 0 0 -1px}
 .tm-bottom{display:flex;position:absolute;left:0;right:0;bottom:0;height:52px;align-items:center;justify-content:space-between;padding:0 12px;border-top:1px solid var(--tm-line2);background:var(--tm-bg1);z-index:5}
 .tm-only-narrow{display:inline-flex}
 .tm-need{grid-template-columns:18px minmax(0,1fr) auto auto;gap:8px}.tm-need-owner{display:none}
}

/* palette (portal, outside .tm-page) */
.tm-modal-scrim{position:fixed;inset:0;z-index:1000;background:var(--dsw-alias-bg-mask-2,rgba(0,0,0,.35));display:flex;align-items:flex-start;justify-content:center;padding-top:10vh}
.tm-modal{width:min(560px,calc(100vw - 24px));max-height:80vh;display:flex;flex-direction:column;border-radius:14px;background:var(--dsw-alias-bg-layer-2,var(--tm-bg1));box-shadow:var(--dsw-elevation-prominent);border:1px solid var(--tm-line2);overflow:hidden}
.tm-modal-head{display:flex;align-items:center;gap:10px;padding:14px 18px 10px}
.tm-modal-head h2{font-size:15px;margin:0;font-weight:600;flex:1}
.tm-modal-body{padding:4px 18px 14px;overflow:auto;display:flex;flex-direction:column;gap:12px}
.tm-cmd{font-family:var(--tm-mono);font-size:12.5px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--tm-fg) 5%,transparent);overflow-wrap:anywhere}
.tm-field{display:flex;flex-direction:column;gap:5px;font-size:12.5px}
.tm-field>span{color:var(--tm-fg2)}
.tm-field>span em{color:var(--tm-bad);font-style:normal;margin-left:3px}
.tm-input{font:inherit;font-size:13px;color:var(--tm-fg);background:var(--tm-bg1);border:1px solid var(--tm-line2);border-radius:8px;padding:7px 9px;outline:none;width:100%}
.tm-input:focus{border-color:var(--tm-accent)}
textarea.tm-input{min-height:64px;resize:vertical}
.tm-radio{display:flex;gap:8px;align-items:flex-start;padding:7px 9px;border:1px solid var(--tm-line2);border-radius:8px;cursor:pointer;font-size:12.5px}
.tm-radio[data-checked=true]{border-color:var(--tm-accent);background:color-mix(in srgb,var(--tm-accent) 6%,transparent)}
.tm-warnbox{font-size:12px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--tm-warn) 10%,transparent);color:var(--tm-fg)}
.tm-modal-foot{display:flex;align-items:center;gap:8px;padding:12px 18px;border-top:1px solid var(--tm-line2)}
.tm-modal-foot .tm-spacer{flex:1}
.tm-receipt{display:grid;grid-template-columns:96px 1fr;gap:4px 10px;font-size:12.5px;padding:10px 12px;border-radius:8px;border:1px solid var(--tm-line2)}
.tm-receipt[data-status=conflict]{border-color:var(--tm-warn)}.tm-receipt[data-status=unknown]{border-color:var(--tm-unknown)}

/* roster (sidebar.body.wrapper) */
.tm-roster-wrap{display:flex;flex-direction:column;min-height:0;flex:1}
.tm-seg{display:flex;gap:2px;margin:4px 12px 6px 8px;padding:2px;border-radius:8px;background:color-mix(in srgb,var(--tm-fg) 5%,transparent)}
.tm-seg button{flex:1;height:26px;border:0;border-radius:6px;background:none;font-size:12.5px;color:var(--tm-fg3);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px}
.tm-seg button[aria-selected=true]{background:var(--tm-bg1);color:var(--tm-fg);box-shadow:var(--dsw-elevation-panel,0 1px 2px rgba(0,0,0,.08))}
.tm-roster{flex:1;min-height:0;overflow:auto;padding:0 10px 10px 4px}
.tm-roster-top{display:flex;align-items:center;gap:6px;padding:4px 6px 8px;font-size:12px;color:var(--tm-fg3);flex-wrap:wrap}
.tm-rgroup{display:flex;align-items:center;gap:6px;width:100%;height:26px;padding:0 6px;border:0;background:none;border-radius:6px;cursor:pointer;font-size:12px;color:var(--tm-fg2);text-align:left}
.tm-rgroup:hover{background:var(--tm-hover)}
.tm-rgroup .tm-caret{font-size:9px;width:10px;color:var(--tm-fg3);transition:transform .15s}
.tm-rgroup[aria-expanded=false] .tm-caret{transform:rotate(-90deg)}
.tm-rgroup .tm-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.tm-rrow{position:relative;display:flex;align-items:center;gap:7px;width:100%;height:28px;padding:0 6px 0 18px;border:0;background:none;border-radius:6px;cursor:pointer;font-size:13px;text-align:left;color:var(--tm-fg)}
.tm-rrow:hover{background:var(--tm-hover)}
.tm-rrow[aria-current=true]{background:var(--dsw-specific-sidebar-nav-item-active-accent,var(--tm-active))}
.tm-rrow[aria-current=true]:before{content:"";position:absolute;left:4px;top:6px;bottom:6px;width:3px;border-radius:2px;background:var(--tm-accent)}
.tm-rrow[data-sev=frozen],.tm-rrow[data-sev=retired]{opacity:.55}
.tm-rrow .tm-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tm-rrow .num{color:var(--tm-fg3);font-size:11px}
.tm-rrow .num[data-level=warn]{color:var(--tm-warn)}.tm-rrow .num[data-level=bad]{color:var(--tm-bad)}
.tm-hidden{display:none!important}

/* member frame (main.conversation.frame) */
.tm-frame{display:flex;flex-direction:column;height:100%;min-height:0;position:relative}
.tm-frame-body{flex:1;min-height:0;display:flex;flex-direction:column;position:relative}
.tm-frame-body>[data-slot]{display:contents}
.tm-frame[data-readonly=true] [data-slot="conversation.composer.bar"]{display:none!important}
.tm-strip{flex:none;display:flex;align-items:center;gap:8px;height:40px;padding:0 10px 0 12px;border-bottom:1px solid var(--tm-line2);background:var(--tm-bg1);white-space:nowrap;overflow:hidden;font-size:12.5px}
.tm-strip .tm-sep{margin:0 2px}
.tm-strip-who{display:flex;align-items:center;gap:6px;min-width:0}
.tm-strip-who strong{font-weight:600}
.tm-strip-task{color:var(--tm-fg2);overflow:hidden;text-overflow:ellipsis;min-width:0}
.tm-strip .tm-spacer{flex:1}
.tm-pill{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:11px;font-size:11.5px;background:color-mix(in srgb,var(--tm-fg) 6%,transparent);color:var(--tm-fg2)}
.tm-readonly-bar{flex:none;display:flex;align-items:center;gap:10px;margin:0 auto 14px;width:min(760px,calc(100% - 32px));padding:10px 12px 10px 14px;border-radius:14px;border:1px dashed var(--tm-line2);background:var(--tm-bg1);font-size:12.5px;color:var(--tm-fg2)}
.tm-readonly-bar .tm-spacer{flex:1}
.tm-frame-note{flex:none;margin:8px 12px 0;font-size:11.5px;color:var(--tm-fg3)}
@container tmframe (max-width:640px){.tm-strip-task,.tm-strip-hide{display:none}}
.tm-frame{container-type:inline-size;container-name:tmframe}
/* L2 disclosures (09 §5.5 展开态) */
.tm-disclose>summary{cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:4px;border-radius:4px}
.tm-disclose>summary::-webkit-details-marker{display:none}
.tm-disclose>summary:focus-visible{outline:2px solid var(--tm-focus,currentColor);outline-offset:1px}
.tm-disclose[open]>summary .tm-fg3{color:var(--tm-fg2)}
.tm-disclose-body{margin-top:4px;padding-left:10px;border-left:2px solid var(--tm-line2);display:flex;flex-direction:column;gap:2px}
/* v3 §3.4 on-demand detail: the v1 read states sit at the bottom of the right pane, closed by default. */
.tm-runtime{flex:none;padding:8px 16px 12px;border-top:1px solid var(--tm-line2);background:var(--tm-bg1)}
.tm-runtime>summary{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--tm-fg3)}
.tm-runtime>.tm-disclose-body{gap:6px;margin-top:6px}
.tm-l2{display:flex;flex-direction:column;gap:8px}
.tm-kv.tm-kv-sub{grid-template-columns:64px minmax(0,1fr);gap:3px 8px;font-size:12px}
/* right sidebar tab (sidebar.right.pane.tab) */
.tm-pane{height:100%;display:flex;flex-direction:column;min-height:0;background:var(--tm-bg1)}
.tm-pane .tm-detail.tm-pane-detail{width:auto;flex:1;border-left:0;background:transparent}
.tm-pane-note{padding:8px 16px 0}
/* session-header mini strip (conversation.session.header.actions) */
.tm-mini{display:inline-flex;align-items:center;gap:6px;height:24px;max-width:100%;padding:0 8px;margin-left:8px;border-radius:12px;border:1px solid var(--tm-line2);background:transparent;color:var(--tm-fg2);font:inherit;font-size:12px;white-space:nowrap;overflow:hidden;cursor:pointer}
.tm-mini:hover{background:color-mix(in srgb,var(--tm-fg) 5%,transparent)}
.tm-mini:focus-visible{outline:2px solid var(--tm-focus,currentColor);outline-offset:1px}
.tm-mini-name{color:var(--tm-fg);font-weight:500;overflow:hidden;text-overflow:ellipsis}
.tm-mini-sep{width:1px;height:12px;background:var(--tm-line2)}
.tm-mini [data-sev=warn]{color:var(--tm-warn)}.tm-mini [data-sev=unknown]{color:var(--tm-unknown)}
/* v3 pages (16 §3): now / members / records + the inspector rail */
.tm-v3{display:flex;flex-direction:column;min-height:0;height:100%}
.tm-v3-top{flex:none;height:56px;display:flex;align-items:center;gap:12px;padding:0 32px;border-bottom:1px solid var(--tm-line2)}
.tm-v3-team{margin:0;font-size:16px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tm-v3-tabs{display:flex;gap:4px;margin-left:24px}
.tm-v3-tab{padding:6px 14px;border-radius:8px;border:0;background:none;color:var(--tm-fg3);cursor:pointer}
.tm-v3-tab.on{background:var(--tm-bg2);color:var(--tm-fg)}
.tm-v3-badge{font-size:12px;padding:2px 9px;border-radius:20px;border:1px solid var(--tm-line2);color:var(--tm-fg2);white-space:nowrap}
.tm-v3-details{border:1px solid var(--tm-line2);background:none;border-radius:8px;padding:4px 10px;font-size:12px;color:var(--tm-fg2);cursor:pointer}
.tm-v3-details.on{background:var(--tm-bg2);color:var(--tm-fg)}
.tm-v3-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr);overflow:auto}
.tm-v3-body.has-ins{grid-template-columns:minmax(0,1fr) 380px}
.tm-v3-main{min-width:0;padding:40px 32px}
.tm-v3-col{max-width:860px;margin:0 auto;min-width:0}
.tm-v3-status{margin:0 0 6px;font-size:22px;font-weight:600;letter-spacing:-.01em;display:flex;align-items:baseline;gap:12px;overflow-wrap:anywhere}
.tm-v3-status .tm-v3-dot{flex:none;width:10px;height:10px;border-radius:50%;background:var(--sev,var(--tm-fg2))}
.tm-v3-sub{margin:0 0 34px;color:var(--tm-fg3);overflow-wrap:anywhere}
.tm-v3-sec{margin-bottom:36px}
.tm-v3-sec h2{margin:0 0 12px;font-size:13px;font-weight:600;color:var(--tm-fg3);letter-spacing:.02em}
.tm-v3-empty{border:1px dashed var(--tm-line2);border-radius:12px;padding:22px 24px;display:flex;align-items:flex-start;gap:14px;color:var(--tm-fg2);min-width:0}
.tm-v3-empty .tm-fg3{overflow-wrap:anywhere}
.tm-v3-ok{flex:none;width:28px;height:28px;border-radius:50%;border:2px solid var(--tm-fg3);display:inline-flex;align-items:center;justify-content:center;color:var(--tm-fg2);font-size:14px}
.tm-v3-ask{display:flex;align-items:center;gap:18px;border:1px solid var(--tm-line2);border-left:3px solid var(--sev,var(--tm-warn));border-radius:12px;padding:16px 20px;background:var(--tm-bg1);margin-bottom:10px;min-width:0}
.tm-v3-ask-q{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.tm-v3-ask-q b{font-weight:600;overflow-wrap:anywhere}
.tm-v3-ask-q span{font-size:13px;color:var(--tm-fg3);overflow-wrap:anywhere}
.tm-v3-prog{height:8px;border-radius:6px;background:var(--tm-bg2);overflow:hidden;margin:6px 0 8px}
.tm-v3-prog i{display:block;height:100%;background:var(--tm-done);border-radius:6px}
.tm-v3-plab{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--tm-fg3);font-size:13px}
.tm-v3-link{border:0;background:none;color:var(--tm-fg3);padding:2px 0}
.tm-v3-stages{display:flex;flex-wrap:wrap;gap:16px;margin-top:8px;color:var(--tm-fg3);font-size:13px}
.tm-v3-stage b{margin-left:6px;color:var(--tm-fg2)}
.tm-v3-sum{display:flex;align-items:center;gap:12px;width:100%;text-align:left;border:1px solid var(--tm-line2);border-radius:12px;padding:14px 20px;background:var(--tm-bg1);cursor:pointer;min-width:0}
.tm-v3-sum>span:nth-child(2){min-width:0;overflow-wrap:anywhere}
.tm-v3-chev{flex:none;color:var(--tm-fg3)}
.tm-v3-table{width:100%;border-collapse:collapse;margin-top:8px;table-layout:fixed}
.tm-v3-table th,.tm-v3-table td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--tm-line2);vertical-align:top;min-width:0}
.tm-v3-table th{font-size:12px;font-weight:500;color:var(--tm-fg3)}
.tm-v3-table tbody tr{cursor:pointer}
.tm-v3-table tbody tr:hover{background:var(--tm-bg2)}
.tm-v3-table tr[data-selected=true] td{background:var(--tm-bg2)}
.tm-v3-name{min-width:110px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tm-v3-what{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.tm-v3-st{display:inline-flex;align-items:center;gap:7px;white-space:nowrap}
.tm-v3-st:before{content:"";width:8px;height:8px;border-radius:50%;background:var(--sev,var(--tm-idle));flex:none}
.tm-v3-group td{font-size:12px;color:var(--tm-fg3);background:var(--tm-bg1);font-weight:500}
.tm-v3-chips{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:18px}
.tm-v3-chip{border:1px solid var(--tm-line2);border-radius:20px;padding:4px 14px;font-size:13px;color:var(--tm-fg2);background:none;cursor:pointer}
.tm-v3-chip.on{background:var(--tm-bg2);color:var(--tm-fg);border-color:var(--tm-fg3)}
.tm-v3-select{border:1px solid var(--tm-line2);border-radius:20px;padding:4px 10px;font-size:13px;background:transparent;color:var(--tm-fg2);max-width:180px}
.tm-v3-day{margin-top:8px}
.tm-v3-daylabel{font-size:12px;color:var(--tm-fg3);margin:16px 0 4px}
.tm-v3-tl{list-style:none;margin:0;padding:0}
.tm-v3-tl li{display:grid;grid-template-columns:64px 18px minmax(0,1fr);gap:10px;align-items:baseline;padding:10px 0;border-bottom:1px solid var(--tm-line2);cursor:pointer;min-width:0}
.tm-v3-tl li:hover{background:var(--tm-bg2)}
.tm-v3-tl .tm-v3-dot{width:8px;height:8px;border-radius:50%;background:var(--sev,var(--tm-idle));margin-top:6px}
.tm-v3-tl li>div{min-width:0;overflow-wrap:anywhere}
.tm-v3-time{font-size:12px;color:var(--tm-fg3)}
.tm-v3-who{font-weight:600}
.tm-v3-tags{font-size:12px;color:var(--tm-fg3)}
.tm-v3-more{margin-top:14px}
.tm-v3-ins{border-left:1px solid var(--tm-line2);background:var(--tm-bg1);padding:22px 24px;overflow:auto;display:flex;flex-direction:column;gap:18px;min-width:0}
.tm-v3-ins-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.tm-v3-ins-head h3{margin:0;font-size:17px}
.tm-v3-ins-note{border:1px solid var(--tm-line2);border-radius:10px;padding:12px 14px;font-size:13px;overflow-wrap:anywhere;min-width:0}
.tm-v3-ins-note[data-sev]{border-left:3px solid var(--sev,var(--tm-line2))}
.tm-v3-raw{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:240px;overflow:auto;margin:8px 0 0}
.tm-v3-broken{flex:none;display:flex;align-items:center;gap:10px;margin:12px 32px 0;padding:10px 14px;border-radius:10px;border:1px solid var(--tm-line2);border-left:3px solid var(--tm-unknown);background:var(--tm-bg1);font-size:13px}
.tm-v3-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);padding:8px 16px;border-radius:20px;background:var(--tm-bg2);border:1px solid var(--tm-line2);font-size:13px;z-index:40}
/* 16 §4 narrow: the inspector is a full-screen sheet whose top row is «← 返回»; Esc closes it the same way. */
.tm-v3-sheet{position:fixed;inset:0;z-index:70;display:flex;flex-direction:column;background:var(--tm-bg1);min-width:0;overflow:hidden}
.tm-v3-sheet-top{flex:none;display:flex;align-items:center;gap:10px;height:52px;padding:0 12px;border-bottom:1px solid var(--tm-line2)}
.tm-v3-back{border:0;background:none;color:var(--tm-fg2);font-size:14px;padding:8px 6px;cursor:pointer;white-space:nowrap}
.tm-v3-back:hover{color:var(--tm-fg)}
.tm-v3-sheet-body{flex:1;min-height:0;overflow:auto;padding:16px}
.tm-v3-sheet-body .tm-v3-ins{border-left:0;background:none;padding:0;overflow:visible}
@media (max-width:760px){
  .tm-v3-top{padding:0 16px;height:52px}
  .tm-v3-tabs{margin-left:auto}
  .tm-v3-tab{padding:6px 10px}
  .tm-v3-main{padding:24px 16px}
  .tm-v3-body.has-ins{grid-template-columns:minmax(0,1fr)}
  .tm-v3-status{font-size:18px}
  .tm-v3-ask{flex-wrap:wrap;padding:14px 16px;gap:10px}
  .tm-v3-ask-q{flex-basis:100%}
  .tm-v3-ask .tm-btn{margin-left:auto}
  .tm-v3-table{display:table}
  .tm-v3-table th:first-child{width:110px!important}
}
`;
