/* ========= API + STORAGE (Neon via Next.js API) ========= */
async function apiJson(url, opts={}){
  const headers={'Content-Type':'application/json',...(opts.headers||{})};
  const r=await fetch(url,{...opts,headers,credentials:'include'});
  if(r.status===401){ window.location.href='/login'; throw new Error('Unauthorized'); }
  if(!r.ok){
    const t=await r.text();
    throw new Error(t.slice(0,400)||('HTTP '+r.status));
  }
  if(r.status===204) return null;
  const text=await r.text();
  if(!text) return null;
  return JSON.parse(text);
}

const Store = {
  async listBrands(){ return apiJson('/api/brands')||[]; },
  async getBrand(id){
    const brands=await this.listBrands();
    return brands.find(b=>b.id===id)||null;
  },
  async saveBrand(b){
    b.updatedAt=Date.now();
    b.id=b.id||('b_'+Math.random().toString(36).slice(2,10));
    return apiJson('/api/brands',{method:'POST',body:JSON.stringify(b)});
  },
  async deleteBrand(id){
    await apiJson('/api/brands/'+encodeURIComponent(id),{method:'DELETE'});
  },
  async saveCalendar(brandId,cal){
    const id=cal.id||('cal_'+Date.now());
    cal.id=id; cal.brandId=brandId; cal.createdAt=cal.createdAt||Date.now();
    return apiJson('/api/brands/'+encodeURIComponent(brandId)+'/calendars',{method:'POST',body:JSON.stringify(cal)});
  },
  async listCalendars(brandId){
    return apiJson('/api/brands/'+encodeURIComponent(brandId)+'/calendars')||[];
  },
  async deleteCalendar(brandId,calId){
    await apiJson('/api/calendars/'+encodeURIComponent(calId)+'?brandId='+encodeURIComponent(brandId),{method:'DELETE'});
  },
  async saveBrief(brandId,brief){
    const id=brief.id||('br_'+Date.now()+'_'+Math.random().toString(36).slice(2,6));
    brief.id=id; brief.brandId=brandId; brief.createdAt=brief.createdAt||Date.now();
    return apiJson('/api/brands/'+encodeURIComponent(brandId)+'/briefs',{method:'POST',body:JSON.stringify(brief)});
  },
  async listBriefs(brandId){
    return apiJson('/api/brands/'+encodeURIComponent(brandId)+'/briefs')||[];
  },
  async deleteBrief(brandId,id){
    await apiJson('/api/briefs/'+encodeURIComponent(id)+'?brandId='+encodeURIComponent(brandId),{method:'DELETE'});
  },
  async listAllBriefs(){ return apiJson('/api/briefs')||[]; },
  async saveTrends(brandId,trends){
    trends.id='latest'; trends.brandId=brandId; trends.createdAt=Date.now();
    return apiJson('/api/brands/'+encodeURIComponent(brandId)+'/trends',{method:'PUT',body:JSON.stringify(trends)});
  },
  async getTrends(brandId){
    try{ return await apiJson('/api/brands/'+encodeURIComponent(brandId)+'/trends'); }catch(e){ return null; }
  },
};

/* ========= LLM API (Vercel serverless proxy) ========= */
// For Vercel hosting: we call our own `/api/chat` so your OpenRouter key stays on the server.
// In Vercel, set env var: OPENROUTER_API_KEY
const LLM_MODEL = 'anthropic/claude-sonnet-4';

async function callClaude(prompt, opts={}){
  const body={
    model: opts.model || LLM_MODEL,
    max_tokens: opts.max_tokens || 4096,
    temperature: (opts.temperature==null ? 0.2 : opts.temperature),
    messages:[{role:"user",content:prompt}]
  };
  const r=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  if(!r.ok){ const t=await r.text(); throw new Error("API "+r.status+": "+t.slice(0,400)); }
  const d=await r.json();
  const text = d?.choices?.[0]?.message?.content;
  if(!text) throw new Error("Empty response from API");
  return text;
}

// Get JSON response with aggressive parsing fallback
async function callClaudeJSON(prompt, opts={}){
  const finalPrompt = prompt + `\n\n=== OUTPUT FORMAT ===
Respond with ONLY a valid JSON object. Start with { and end with }.
- No markdown code fences (no \`\`\`json)
- No preamble or explanation before the JSON
- No trailing commas
- All string values must escape internal quotes with \\"
- All string values must escape internal newlines with \\n
- Do not break strings across multiple lines
Begin your response with the opening brace { immediately.`;

  const body={
    model: opts.model || LLM_MODEL,
    max_tokens: opts.max_tokens || 16000,
    temperature: (opts.temperature==null ? 0.2 : opts.temperature),
    messages:[{role:"user", content: finalPrompt}]
  };
  const r=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  if(!r.ok){ const t=await r.text(); throw new Error("API "+r.status+": "+t.slice(0,400)); }
  const d=await r.json();
  console.log('API response:', d);
  const text = d?.choices?.[0]?.message?.content || '';
  const finish = d?.choices?.[0]?.finish_reason || '?';
  if(!text) throw new Error("Empty response. finish_reason: "+finish);
  return aggressiveJSONParse(text, finish === 'length' ? 'max_tokens' : finish);
}

// Aggressive JSON parser that fixes common LLM output issues
function aggressiveJSONParse(txt, stopReason){
  let s = txt.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();

  // If model stopped at max_tokens, response is likely truncated mid-string
  const truncated = stopReason === 'max_tokens';

  // Try direct parse first
  try { return JSON.parse(s); } catch(e0) {}

  // Step 1: remove trailing commas before } or ]
  s = s.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(s); } catch(e1) {}

  // Step 2: brace-balance — find last properly-closed top-level structure
  let depth=0, inStr=false, esc=false, lastGoodClose=-1;
  for(let i=0;i<s.length;i++){
    const c=s[i];
    if(esc){ esc=false; continue; }
    if(inStr){
      if(c==='\\') { esc=true; continue; }
      if(c==='"') { inStr=false; }
      continue;
    }
    if(c==='"'){ inStr=true; continue; }
    if(c==='{'||c==='[') depth++;
    else if(c==='}'||c===']'){ depth--; if(depth===0) lastGoodClose=i; }
  }

  // If we have any complete top-level structure
  if(lastGoodClose>0){
    let truncatedSafe = s.slice(0, lastGoodClose+1).replace(/,(\s*[}\]])/g,'$1');
    try { return JSON.parse(truncatedSafe); } catch(e2) {}
  }

  // Step 3: aggressive recovery for arrays — find all complete objects and rebuild
  // Look for "posts": [ ... and try to extract complete post objects
  const arrayKeyMatch = s.match(/"(\w+)"\s*:\s*\[/);
  if(arrayKeyMatch){
    const arrayKey = arrayKeyMatch[1];
    const startIdx = s.indexOf('[', arrayKeyMatch.index) + 1;
    const items = [];
    let i = startIdx;
    while(i < s.length){
      // Skip whitespace and commas
      while(i < s.length && /[\s,]/.test(s[i])) i++;
      if(i >= s.length || s[i] === ']') break;
      if(s[i] !== '{') break;
      // Find matching close brace
      let d=0, str=false, e=false, end=-1;
      for(let j=i; j<s.length; j++){
        const c=s[j];
        if(e){e=false; continue;}
        if(str){ if(c==='\\'){e=true;continue;} if(c==='"'){str=false;} continue; }
        if(c==='"'){str=true;continue;}
        if(c==='{') d++;
        else if(c==='}'){ d--; if(d===0){end=j; break;} }
      }
      if(end===-1) break;
      const objStr = s.slice(i, end+1).replace(/,(\s*[}\]])/g,'$1');
      try { items.push(JSON.parse(objStr)); } catch(_) {}
      i = end+1;
    }
    if(items.length){
      const result = {};
      result[arrayKey] = items;
      console.warn(`Recovered ${items.length} ${arrayKey} from malformed JSON`);
      return result;
    }
  }

  throw new Error(`JSON parse failed${truncated?' (response truncated by max_tokens)':''}. Got ${s.length} chars. Last 200: ${s.slice(-200)}`);
}

// Keep the original tolerant parser for trends fetcher
function tolerantJSONParse(txt){
  return aggressiveJSONParse(txt);
}

/* ========= STATE ========= */
const state={ view:'brands', brands:[], activeBrandId:null, calendars:[], activeCalendar:null, briefs:[], trends:null, allBriefs:[], loading:false, modal:null, toast:null };

function setState(p){ Object.assign(state,p); render(); }
function showToast(msg,kind='ok',durMs){ state.toast={msg,kind}; render(); const dur=durMs||(kind==='err'?7000:3500); setTimeout(()=>{state.toast=null;render()},dur); }

/* ========= ICONS ========= */
const ICONS={
  brands:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7l9-4 9 4v10l-9 4-9-4V7z"/><path d="M3 7l9 4 9-4M12 11v10"/></svg>',
  calendar:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  brief:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6"/></svg>',
  analytics:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18M7 16V9M12 16V5M17 16v-4"/></svg>',
  trends:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 7l-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/></svg>',
  plus:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>',
  spark:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l1.9 5.8L20 10l-5.1 2.2L12 18l-2.9-5.8L4 10l6.1-1.2z"/></svg>',
  trash:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
  edit:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
  download:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
  refresh:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.65 4.36A9 9 0 0 0 20.5 15"/></svg>',
  close:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  copy:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
};

/* ========= RENDER SHELL ========= */
function render(){
  const root=document.getElementById('app');
  // Preserve focus state of inputs that re-render on keystroke (search box)
  const focused = document.activeElement;
  const focusedId = focused?.id;
  const cursorPos = (focusedId === 'posts-search') ? focused.selectionStart : null;

  root.innerHTML=`
    <div class="flex min-h-screen">
      ${renderSidebar()}
      <main class="flex-1 min-w-0">
        ${renderTopbar()}
        <div class="p-6 fadein" id="content">${renderView()}</div>
      </main>
    </div>
    ${state.modal?renderModal():''}
    ${state.toast?renderToast():''}
  `;
  attachHandlers();
  if(state.view==='analytics') drawAnalytics();

  // Restore focus on search input
  if(focusedId === 'posts-search'){
    const el = document.getElementById('posts-search');
    if(el){
      el.focus();
      if(cursorPos !== null){ try{ el.setSelectionRange(cursorPos, cursorPos); }catch(e){} }
    }
  }

  if(state._pendingScrollPostIdx != null){
    const idx = state._pendingScrollPostIdx;
    state._pendingScrollPostIdx = null;
    performScrollToPost(idx);
  }
}

function renderSidebar(){
  const items=[
    {k:'brands',label:'Brands',icon:ICONS.brands,count:state.brands.length},
    {k:'calendar',label:'Calendar',icon:ICONS.calendar},
    {k:'briefs',label:'Brief Library',icon:ICONS.brief},
    {k:'trends',label:'Industry Trends',icon:ICONS.trends},
    {k:'analytics',label:'EVI Analytics',icon:ICONS.analytics},
  ];
  return `
  <aside class="w-[240px] shrink-0 border-r border-[var(--line)] bg-white min-h-screen p-4 flex flex-col">
    <div class="flex items-center gap-2 px-2 mb-6">
      <div class="w-8 h-8 rounded-lg flex items-center justify-center" style="background:linear-gradient(135deg,#5b54e5,#0d9488)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M12 3l1.9 5.8L20 10l-5.1 2.2L12 18l-2.9-5.8L4 10l6.1-1.2z"/></svg>
      </div>
      <div>
        <div class="text-[13px] font-bold leading-tight">Strategy OS</div>
        <div class="text-[10px] text-[var(--accent)] leading-tight font-bold mono">v4.0 · light</div>
      </div>
    </div>
    <div class="space-y-1 flex-1">
      ${items.map(i=>`
        <div class="nav-btn ${state.view===i.k?'active':''}" data-nav="${i.k}">
          <div class="dot"></div>
          <span class="flex-1 flex items-center gap-2">${i.icon}${i.label}</span>
          ${i.count!==undefined?`<span class="text-[10px] mono text-[var(--ink3)]">${i.count}</span>`:''}
        </div>
      `).join('')}
    </div>
    <div class="px-2 pt-3 border-t border-[var(--line)] text-[10.5px] text-[var(--ink3)] leading-relaxed">
      <div>McKinsey Senior Partner Edition</div>
      <div class="mt-1 opacity-70">Funnel-mapped · EVI-scored</div>
    </div>
  </aside>`;
}

function renderTopbar(){
  const brand=state.brands.find(b=>b.id===state.activeBrandId);
  const showBrandSwitcher=['calendar','briefs','trends'].includes(state.view);
  return `
  <div class="border-b border-[var(--line)] bg-white px-6 py-3.5 flex items-center justify-between gap-4 sticky top-0 z-10">
    <div class="flex items-center gap-3">
      <div class="text-[15px] font-semibold capitalize">${({brands:'Brand Portfolio',calendar:'Content Calendar',briefs:'Creative Brief Library',trends:'Industry Intelligence',analytics:'EVI & Funnel Analytics'})[state.view]}</div>
      ${showBrandSwitcher?`
        <span class="text-[var(--ink3)]">/</span>
        <select class="select" style="width:auto;min-width:200px" id="brand-switcher">
          <option value="">— Select brand —</option>
          ${state.brands.map(b=>`<option value="${b.id}" ${b.id===state.activeBrandId?'selected':''}>${esc(b.name)}</option>`).join('')}
        </select>
      `:''}
    </div>
    <div class="flex items-center gap-2">
      ${renderGoogleAuthTopbar()}
      ${state.view==='brands'?`<button class="btn primary" data-action="new-brand">${ICONS.plus} New Brand</button>`:''}
      ${state.view==='calendar'&&brand?`<button class="btn primary" data-action="generate-calendar">${ICONS.spark} Generate Calendar</button>`:''}
      ${state.view==='trends'&&brand?`<button class="btn primary" data-action="fetch-trends">${ICONS.refresh} ${state.trends?'Refresh':'Fetch'} Trends</button>`:''}
    </div>
  </div>`;
}

function renderGoogleAuthTopbar(){
  const session=window.__BRANDSTORY_SESSION__;
  if(!session?.user) return '';
  const user=session.user;
  const label=esc(user.email||user.name||'Account');
  const pic=user.image?`<img src="${esc(user.image)}" alt="" class="w-7 h-7 rounded-full border border-[var(--line)]" referrerpolicy="no-referrer"/>`:'';
  return `
    <div class="flex items-center gap-2 pr-2 border-r border-[var(--line)] mr-1">
      ${pic}
      <span class="text-[12px] text-[var(--ink2)] max-w-[160px] truncate hidden sm:inline" title="${label}">${label}</span>
      <a class="btn" href="/api/auth/signout">Sign out</a>
    </div>`;
}

/* ========= VIEWS ========= */
function renderView(){
  switch(state.view){
    case 'brands': return renderBrandsView();
    case 'calendar': return renderCalendarView();
    case 'briefs': return renderBriefsView();
    case 'trends': return renderTrendsView();
    case 'analytics': return renderAnalyticsView();
  }
}

/* ----- BRANDS VIEW ----- */
function renderBrandsView(){
  if(!state.brands.length){
    return `<div class="panel empty">
      <div class="w-14 h-14 rounded-2xl mb-4 flex items-center justify-center" style="background:var(--accent-soft);border:1px solid var(--accent-soft2);color:var(--accent)">${ICONS.brands}</div>
      <div class="text-[15px] font-semibold text-[var(--ink)] mb-1">No brands yet</div>
      <div class="text-[12.5px] mb-5 max-w-md">Add your first brand to start building funnel-mapped, EVI-scored content strategies. Each brand stores its own profile, calendars, briefs, and industry intel.</div>
      <button class="btn primary" data-action="new-brand">${ICONS.plus} Add First Brand</button>
    </div>`;
  }
  return `
  <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
    ${state.brands.map(b=>{
      const lastUpd=b.updatedAt?timeAgo(b.updatedAt):'—';
      return `
      <div class="panel p-5 fadein">
        <div class="flex items-start justify-between mb-3">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-11 h-11 rounded-xl flex items-center justify-center text-white font-bold text-[15px] shrink-0" style="background:${brandColor(b.name)}">${initials(b.name)}</div>
            <div class="min-w-0">
              <div class="font-semibold text-[14px] truncate">${esc(b.name)}</div>
              <div class="text-[11.5px] text-[var(--ink3)] truncate">${esc(b.website_url||'no domain')}</div>
            </div>
          </div>
          <div class="flex gap-1">
            <button class="btn ghost" style="padding:5px 7px" data-edit-brand="${b.id}" title="Edit">${ICONS.edit}</button>
            <button class="btn ghost danger" style="padding:5px 7px" data-delete-brand="${b.id}" title="Delete">${ICONS.trash}</button>
          </div>
        </div>
        <div class="flex flex-wrap gap-1.5 mb-3">
          <span class="pill">${esc(b.business_model||'B2C')}</span>
          <span class="pill">${esc(b.price_sensitivity_tier||'Mid-Market')}</span>
          ${b.vertical?`<span class="pill accent">${esc(b.vertical.length>22?b.vertical.slice(0,22)+'…':b.vertical)}</span>`:''}
        </div>
        <div class="text-[11.5px] text-[var(--ink2)] leading-relaxed mb-4 line-clamp-2" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(b.target_customer_profile||'No customer profile yet')}</div>
        <div class="flex items-center justify-between">
          <div class="text-[10.5px] text-[var(--ink3)]">Updated ${lastUpd}</div>
          <button class="btn primary" style="padding:6px 11px;font-size:12px" data-open-brand="${b.id}">Open →</button>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

/* ----- CALENDAR VIEW ----- */
function renderCalendarView(){
  const brand=state.brands.find(b=>b.id===state.activeBrandId);
  if(!brand) return renderSelectBrandHint('Pick a brand to view its content calendars');
  const cals=state.calendars||[];
  const active=state.activeCalendar;
  return `
    <div class="grid grid-cols-12 gap-4">
      <div class="col-span-12 lg:col-span-3 panel p-4 self-start">
        <div class="flex items-center justify-between mb-3">
          <div class="text-[12px] font-semibold text-[var(--ink2)] uppercase tracking-wider">Calendars</div>
          <span class="pill mono">${cals.length}</span>
        </div>
        ${cals.length?`<div class="space-y-2">${cals.map(c=>`
          <div class="panel2 p-3 cursor-pointer ${active&&active.id===c.id?'glow':''}" data-open-cal="${c.id}">
            <div class="flex items-center justify-between mb-1">
              <div class="text-[12.5px] font-semibold truncate">${esc(c.title||'Untitled plan')}</div>
              <button class="btn ghost danger" style="padding:3px 5px" data-delete-cal="${c.id}">${ICONS.trash}</button>
            </div>
            <div class="text-[10.5px] text-[var(--ink3)]">${c.posts?c.posts.length:0} posts · ${timeAgo(c.createdAt)}</div>
            <div class="flex gap-1 mt-2">
              <span class="pill tofu">T ${countByFunnel(c.posts,'TOFU')}</span>
              <span class="pill mofu">M ${countByFunnel(c.posts,'MOFU')}</span>
              <span class="pill bofu">B ${countByFunnel(c.posts,'BOFU')}</span>
            </div>
          </div>`).join('')}</div>`:`
          <div class="text-[12px] text-[var(--ink3)]">No calendars yet. Click <b class="text-[var(--ink2)]">Generate Calendar</b> to create the first one.</div>
        `}
      </div>
      <div class="col-span-12 lg:col-span-9">
        ${active?renderCalendarDetail(active,brand):`
          <div class="panel empty">
            <div class="text-[14px] font-semibold mb-1 text-[var(--ink)]">Select a calendar</div>
            <div class="text-[12px]">Pick one from the left, or generate a new 30-day plan.</div>
          </div>
        `}
      </div>
    </div>
  `;
}

function renderCalendarDetail(c,brand){
  const posts=c.posts||[];
  const dist=funnelDistribution(posts);
  const platDist=platformDistribution(posts);
  return `
    <div class="panel p-5 mb-4">
      <div class="flex items-start justify-between gap-4 mb-4">
        <div>
          <div class="text-[16px] font-semibold mb-1">${esc(c.title)}</div>
          <div class="text-[11.5px] text-[var(--ink3)]">${posts.length} posts · created ${timeAgo(c.createdAt)} · ${esc(brand.name)}</div>
        </div>
        <div class="flex gap-2">
          <div class="dl-wrap" style="position:relative">
            <button class="btn" data-action="toggle-download-menu">${ICONS.download} Download <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-left:2px"><polyline points="6 9 12 15 18 9"/></svg></button>
            ${state._dlMenuOpen ? `
              <div class="dl-menu">
                <div class="dl-menu-header">Export ${state.activeCalendar?(applyPostFilters(state.activeCalendar.posts).length):0} posts</div>
                <button class="dl-item" data-action="export-csv">
                  <div class="dl-icon" style="background:rgba(34,197,94,.12);color:#22c55e">CSV</div>
                  <div class="dl-text"><div class="dl-title">CSV</div><div class="dl-sub">Spreadsheet-ready, comma-separated</div></div>
                </button>
                <button class="dl-item" data-action="export-xlsx">
                  <div class="dl-icon" style="background:rgba(34,211,238,.12);color:#22d3ee">XLS</div>
                  <div class="dl-text"><div class="dl-title">Excel (.xlsx)</div><div class="dl-sub">Native Excel with formatting</div></div>
                </button>
                <button class="dl-item" data-action="export-pdf">
                  <div class="dl-icon" style="background:rgba(239,68,68,.12);color:#ef4444">PDF</div>
                  <div class="dl-text"><div class="dl-title">PDF</div><div class="dl-sub">Print-ready calendar report</div></div>
                </button>
                <div class="dl-divider"></div>
                <button class="dl-item" data-action="export-md">
                  <div class="dl-icon" style="background:rgba(124,92,255,.12);color:#7c5cff">MD</div>
                  <div class="dl-text"><div class="dl-title">Markdown</div><div class="dl-sub">For Notion, GitHub, docs</div></div>
                </button>
              </div>
            ` : ''}
          </div>
          <button class="btn primary" data-action="gen-briefs">${ICONS.spark} Auto-Brief Top 4</button>
        </div>
      </div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        ${[
          {label:'Avg EVI',val:avgEVI(posts).toFixed(1),sub:'/ 10'},
          {label:'TOFU / MOFU / BOFU',val:`${dist.TOFU||0} · ${dist.MOFU||0} · ${dist.BOFU||0}`,sub:'distribution'},
          {label:'Platforms',val:Object.keys(platDist).length,sub:Object.keys(platDist).join(', ')||'—'},
          {label:'High-priority',val:posts.filter(p=>(p.evi_score||0)>=7.5).length,sub:'EVI ≥ 7.5'},
        ].map(s=>`
          <div class="panel2 p-3">
            <div class="text-[10.5px] uppercase tracking-wider text-[var(--ink3)] font-semibold mb-1">${s.label}</div>
            <div class="text-[18px] font-semibold mono grad-text">${s.val}</div>
            <div class="text-[10.5px] text-[var(--ink3)] truncate mt-0.5">${esc(s.sub)}</div>
          </div>`).join('')}
      </div>
    </div>

    <div class="panel p-4 mb-4">
      <div class="flex items-center justify-between mb-3">
        <div class="text-[12px] font-semibold text-[var(--ink2)] uppercase tracking-wider">30-Day View</div>
        <div class="flex gap-1.5">
          <span class="pill tofu">TOFU</span><span class="pill mofu">MOFU</span><span class="pill bofu">BOFU</span>
        </div>
      </div>
      ${renderMonthGrid(posts)}
    </div>

    <div class="panel p-0" id="all-posts-panel">
      <div class="flex items-center justify-between p-4 flex-wrap gap-2">
        <div class="flex items-center gap-2">
          <div class="text-[12px] font-semibold text-[var(--ink2)] uppercase tracking-wider">All Posts</div>
          ${renderFilterChipCount(posts)}
        </div>
        <div class="flex items-center gap-2">
          <input class="input" id="posts-search" placeholder="Search hook, CTA, segment…" value="${esc(state._postsFilter?.q||'')}" style="width:240px;padding:6px 11px;font-size:12px"/>
          ${(Object.keys(state._postsFilter||{}).some(k=>k!=='q'&&state._postsFilter[k])||state._postsFilter?.q)?`<button class="btn" style="padding:5px 10px;font-size:11.5px" data-action="clear-post-filters">Clear filters</button>`:''}
        </div>
      </div>
      ${renderPostsTable(posts)}
    </div>
  `;
}

function renderFilterChipCount(posts){
  const f = state._postsFilter || {};
  const filtered = applyPostFilters(posts);
  if(filtered.length === posts.length) return `<span class="pill mono">${posts.length}</span>`;
  return `<span class="pill mono">${filtered.length} <span style="opacity:.5">/ ${posts.length}</span></span>`;
}

const BRIEF_CONTENT_KEYS = [
  'hook','objective','target_audience','core_message','script_copy',
  'visual_direction','audio_direction','technical_specs','cta_block','compliance',
  'content_id','platform','format','funnel_stage','evi_score','caption_preview','intent','hook_type','date','cta',
];

function extractBriefContent(obj){
  const out = {};
  if(!obj) return out;
  BRIEF_CONTENT_KEYS.forEach(k=>{ if(obj[k] !== undefined && obj[k] !== null) out[k] = obj[k]; });
  return out;
}

function newVariantId(){
  return `bv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function formatVariantDateTime(ts){
  if(!ts) return '—';
  const d = new Date(ts);
  if(Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function variantSourceLabel(source){
  return ({ generated:'Generated', edited:'Edited', regenerated:'Regenerated' })[source] || 'Brief';
}

function normalizeBrief(b){
  if(!b) return b;
  if(b.variants?.length){
    if(!b.activeVariantId) b.activeVariantId = b.variants[b.variants.length - 1].id;
    return b;
  }
  const variants = [];
  const activeId = newVariantId();
  variants.push({
    id: activeId,
    ...extractBriefContent(b),
    savedAt: b.savedAt || b.createdAt || Date.now(),
    source: b.regenerated ? 'regenerated' : 'generated',
  });
  (b.versions || []).forEach((v, i)=>{
    variants.push({
      id: `bv_${b.id || 'legacy'}_hist_${i}_${v.savedAt || i}`,
      ...extractBriefContent(v),
      savedAt: v.savedAt || v.createdAt || Date.now(),
      source: v.regenerated ? 'regenerated' : 'edited',
    });
  });
  return { ...b, variants, activeVariantId: activeId, versions: undefined };
}

function getActiveVariant(brief){
  const b = normalizeBrief(brief);
  if(!b?.variants?.length) return null;
  return b.variants.find(v=>v.id === b.activeVariantId) || b.variants[b.variants.length - 1];
}

function syncBriefRecordFromVariant(record, variant){
  if(!record || !variant) return record;
  Object.assign(record, extractBriefContent(variant));
  return record;
}

function sortedBriefVariants(brief){
  const b = normalizeBrief(brief);
  return [...(b.variants || [])].sort((a, z)=>(z.savedAt || 0) - (a.savedAt || 0));
}

function briefActivityScore(b){
  return b.savedAt || b.createdAt || 0;
}

/** Content from the user-selected active variant (used in table, popup, exports). */
function getActiveBriefForPost(post){
  const record = findBriefForPost(post);
  if(!record) return null;
  const active = getActiveVariant(record);
  if(!active) return null;
  return { ...extractBriefContent(active), id: record.id, brandId: record.brandId, content_id: record.content_id || active.content_id };
}

function findBriefForPost(post){
  const briefs=state.briefs||[];
  if(!post||!briefs.length) return null;
  let matches = [];
  if(post.content_id){
    matches = briefs.filter(b=>b.content_id===post.content_id);
  }
  if(!matches.length){
    matches = briefs.filter(b=>
      b.platform===post.platform &&
      b.hook===post.hook &&
      b.format===post.format &&
      b.funnel_stage===post.funnel_stage
    );
  }
  if(!matches.length) return null;
  const flagged = matches.filter(b=>b.isActive===true);
  const pool = flagged.length ? flagged : matches;
  const record = pool.reduce((best, b)=>
    briefActivityScore(b) > briefActivityScore(best) ? b : best, pool[0]);
  return normalizeBrief(record);
}

function applyPostFilters(posts){
  const f = state._postsFilter || {};
  let result = posts.map((p,originalIdx)=>({...p,_idx:originalIdx}));
  if(f.platform) result = result.filter(p=>p.platform===f.platform);
  if(f.funnel_stage) result = result.filter(p=>p.funnel_stage===f.funnel_stage);
  if(f.format) result = result.filter(p=>p.format===f.format);
  if(f.intent) result = result.filter(p=>p.intent===f.intent);
  if(f.sentiment) result = result.filter(p=>p.sentiment===f.sentiment);
  if(f.eviRange){
    const [min,max] = f.eviRange.split('-').map(Number);
    result = result.filter(p=>(p.evi_score||0)>=min && (p.evi_score||0)<=max);
  }
  if(f.q){
    const q = f.q.toLowerCase();
    result = result.filter(p=>{
      return (p.hook||'').toLowerCase().includes(q) ||
             (p.cta||'').toLowerCase().includes(q) ||
             (p.segment||'').toLowerCase().includes(q) ||
             (p.caption_preview||'').toLowerCase().includes(q) ||
             (p.content_id||'').toLowerCase().includes(q);
    });
  }
  // Sort
  const sortKey = f.sortKey || 'date';
  const sortDir = f.sortDir || 'asc';
  result.sort((a,b)=>{
    let av = a[sortKey], bv = b[sortKey];
    if(sortKey === 'evi_score'){ av = av||0; bv = bv||0; }
    else { av = String(av||''); bv = String(bv||''); }
    if(av < bv) return sortDir==='asc' ? -1 : 1;
    if(av > bv) return sortDir==='asc' ? 1 : -1;
    return 0;
  });
  return result;
}

function renderPostsTable(posts){
  const filtered = applyPostFilters(posts);
  const f = state._postsFilter || {};
  const platforms = [...new Set(posts.map(p=>p.platform).filter(Boolean))].sort();
  const formats = [...new Set(posts.map(p=>p.format).filter(Boolean))].sort();
  const intents = [...new Set(posts.map(p=>p.intent).filter(Boolean))].sort();
  const sentiments = [...new Set(posts.map(p=>p.sentiment).filter(Boolean))].sort();
  const stages = ['TOFU','MOFU','BOFU'].filter(s=>posts.some(p=>p.funnel_stage===s));
  const eviRanges = [
    {v:'9-10',l:'9.0–10.0 (Top)'},
    {v:'7.5-8.99',l:'7.5–8.9 (Priority)'},
    {v:'5.5-7.49',l:'5.5–7.4 (Mid)'},
    {v:'0-5.49',l:'< 5.5 (Rework)'},
  ];

  const sortIcon = (key)=>{
    if(f.sortKey!==key) return `<span class="sort-icon" style="opacity:.3">⇅</span>`;
    return f.sortDir==='asc' ? `<span class="sort-icon active">↑</span>` : `<span class="sort-icon active">↓</span>`;
  };

  const dropdown = (key, options, currentVal, label) => {
    return `<select class="th-filter" data-post-filter="${key}">
      <option value="">${label}</option>
      ${options.map(o=>{
        const v = typeof o === 'string' ? o : o.v;
        const t = typeof o === 'string' ? o : o.l;
        return `<option value="${esc(v)}" ${currentVal===v?'selected':''}>${esc(t)}</option>`;
      }).join('')}
    </select>`;
  };

  return `
    <div class="scroll" style="max-height:640px">
      <table>
        <thead>
          <tr>
            <th>
              <button class="th-sort" data-post-sort="date">Date ${sortIcon('date')}</button>
            </th>
            <th>
              <button class="th-sort" data-post-sort="platform">Platform ${sortIcon('platform')}</button>
              ${dropdown('platform', platforms, f.platform, 'All')}
            </th>
            <th>
              <button class="th-sort" data-post-sort="funnel_stage">Stage ${sortIcon('funnel_stage')}</button>
              ${dropdown('funnel_stage', stages, f.funnel_stage, 'All')}
            </th>
            <th>
              <button class="th-sort" data-post-sort="hook">Hook / Headline ${sortIcon('hook')}</button>
            </th>
            <th>
              <button class="th-sort" data-post-sort="format">Format ${sortIcon('format')}</button>
              ${dropdown('format', formats, f.format, 'All')}
            </th>
            <th>
              <button class="th-sort" data-post-sort="intent">Intent ${sortIcon('intent')}</button>
              ${dropdown('intent', intents, f.intent, 'All')}
            </th>
            <th>
              <button class="th-sort" data-post-sort="evi_score">EVI ${sortIcon('evi_score')}</button>
              ${dropdown('eviRange', eviRanges, f.eviRange, 'All')}
            </th>
            <th>
              <button class="th-sort" data-post-sort="cta">CTA ${sortIcon('cta')}</button>
            </th>
            <th style="min-width:130px"></th>
            <th style="min-width:100px">Brief</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.length ? filtered.map(p=>{
            const brief=getActiveBriefForPost(p);
            return `<tr id="post-row-${p._idx}" data-post-row="${p._idx}">
            <td class="mono text-[var(--ink2)]">${esc(p.date||'')}</td>
            <td><span class="pill">${esc(p.platform||'')}</span></td>
            <td><span class="pill ${(p.funnel_stage||'').toLowerCase()}">${esc(p.funnel_stage||'')}</span></td>
            <td class="font-medium cursor-pointer hover:text-[var(--accent)]" style="max-width:280px" data-post-detail="${p._idx}">${esc(truncate(p.hook||'',90))}</td>
            <td class="text-[var(--ink2)]">${esc(p.format||'')}</td>
            <td class="text-[var(--ink2)]">${esc(p.intent||'')}</td>
            <td><div class="flex items-center gap-2"><span class="mono text-[12px]">${(p.evi_score||0).toFixed(1)}</span><div class="ev-bar w-12"><div class="ev-fill" style="width:${Math.min(100,(p.evi_score||0)*10)}%"></div></div></div></td>
            <td class="text-[var(--ink2)] text-[11.5px]">${esc(truncate(p.cta||'',24))}</td>
            <td>
              ${brief
                ? ''
                : `<button class="btn" style="padding:4px 10px;font-size:11.5px;white-space:nowrap" data-gen-brief-post="${p._idx}">${ICONS.spark} Generate Brief</button>`}
            </td>
            <td>
              ${brief
                ? `<button class="btn ghost" style="padding:4px 10px;font-size:11.5px;white-space:nowrap" data-view-brief="${state.activeBrandId}|${brief.id}">${ICONS.brief} View Brief</button>`
                : ''}
            </td>
          </tr>`;
          }).join('') : `<tr><td colspan="10" class="text-center text-[var(--ink3)] py-8 text-[12px]">No posts match the current filters. <button class="text-[var(--accent)] underline ml-2" data-action="clear-post-filters">Clear filters</button></td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function isPostVisibleInTable(postIdx){
  const posts = state.activeCalendar?.posts;
  if(!posts || postIdx < 0 || postIdx >= posts.length) return false;
  const withIdx = posts.map((p,i)=>({...p,_idx:i}));
  return applyPostFilters(withIdx).some(p=>p._idx===postIdx);
}

function scrollToPostRow(postIdx){
  if(!state.activeCalendar?.posts?.[postIdx]) return;
  if(!isPostVisibleInTable(postIdx)){
    state._pendingScrollPostIdx = postIdx;
    const sortKey = state._postsFilter?.sortKey || 'date';
    const sortDir = state._postsFilter?.sortDir || 'asc';
    state._postsFilter = { sortKey, sortDir };
    render();
    showToast('Filters cleared to show this post','ok');
    return;
  }
  performScrollToPost(postIdx);
}

function performScrollToPost(postIdx){
  requestAnimationFrame(()=>{
    const row = document.getElementById(`post-row-${postIdx}`);
    if(!row) return;
    document.getElementById('all-posts-panel')?.scrollIntoView({ behavior:'smooth', block:'start' });
    row.scrollIntoView({ behavior:'smooth', block:'center' });
    row.classList.add('post-row-highlight');
    setTimeout(()=>row.classList.remove('post-row-highlight'), 2200);
  });
}

function renderMonthGrid(posts){
  const byDate={};
  posts.forEach((p,idx)=>{ const k=p.date||''; (byDate[k]=byDate[k]||[]).push({post:p,idx}); });
  const dates=Object.keys(byDate).sort();
  if(!dates.length) return '<div class="empty">No dated posts to render.</div>';
  let html='<div class="grid grid-cols-7 gap-2">';
  for(const d of dates){
    const day=new Date(d);
    const dayLabel=isNaN(day)?d:day.getDate();
    const dow=isNaN(day)?'':['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day.getDay()];
    html+=`<div class="day-cell"><div class="dnum">${dow} ${dayLabel}</div>`;
    byDate[d].slice(0,4).forEach(({post:p,idx})=>{
      html+=`<div class="post post-cal-click ${(p.funnel_stage||'').toLowerCase()}" data-scroll-to-post="${idx}" role="button" tabindex="0" title="View in All Posts table"><b>${esc(p.platform||'')}</b> · ${esc(truncate(p.hook||'',38))}</div>`;
    });
    if(byDate[d].length>4) html+=`<div class="text-[10px] text-[var(--ink3)] mt-1">+${byDate[d].length-4} more</div>`;
    html+='</div>';
  }
  html+='</div>';
  return html;
}

/* ----- BRIEFS LIBRARY ----- */
function renderBriefsView(){
  const all=state.allBriefs||[];
  if(!all.length){
    return `<div class="panel empty">
      <div class="text-[14px] font-semibold mb-1 text-[var(--ink)]">No briefs yet</div>
      <div class="text-[12px] mb-4">Generate a calendar, then run <b class="text-[var(--ink2)]">Auto-Brief Top 4</b> on it to populate this library.</div>
    </div>`;
  }
  const byBrand={};
  all.forEach(b=>{
    const br=state.brands.find(x=>x.id===b.brandId);
    const name=br?br.name:'(deleted)';
    if(!byBrand[name]) byBrand[name]={brand:br, briefs:[]};
    byBrand[name].briefs.push(b);
  });
  const totalVersions = all.reduce((s,b)=>s + (normalizeBrief(b).variants?.length || 1), 0);
  return `
  <div class="panel p-4 mb-4">
    <div class="grid grid-cols-3 gap-3">
      <div class="panel2 p-3">
        <div class="text-[10.5px] uppercase tracking-wider text-[var(--ink3)] font-semibold mb-1">Brands with briefs</div>
        <div class="text-[20px] font-semibold mono grad-text">${Object.keys(byBrand).length}</div>
      </div>
      <div class="panel2 p-3">
        <div class="text-[10.5px] uppercase tracking-wider text-[var(--ink3)] font-semibold mb-1">Active briefs</div>
        <div class="text-[20px] font-semibold mono">${all.length}</div>
      </div>
      <div class="panel2 p-3">
        <div class="text-[10.5px] uppercase tracking-wider text-[var(--ink3)] font-semibold mb-1">Saved brief copies</div>
        <div class="text-[20px] font-semibold mono text-[var(--accent2)]">${totalVersions}</div>
      </div>
    </div>
  </div>
  <div class="space-y-5">
    ${Object.entries(byBrand).map(([brand, data])=>{
      const items = data.briefs;
      const brandObj = data.brand;
      const totalV = items.reduce((s,b)=>s+(normalizeBrief(b).variants?.length||1),0);
      return `
      <div>
        <div class="flex items-center gap-2 mb-3">
          ${brandObj?`<div class="w-7 h-7 rounded-lg flex items-center justify-center text-white font-bold text-[10.5px]" style="background:${brandColor(brandObj.name)}">${initials(brandObj.name)}</div>`:''}
          <div class="text-[13px] font-semibold">${esc(brand)}</div>
          <span class="pill mono">${items.length} brief${items.length===1?'':'s'}</span>
          <span class="pill accent mono">${totalV} version${totalV===1?'':'s'}</span>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          ${items.map(b=>{
            const norm = normalizeBrief(b);
            const activeV = getActiveVariant(norm);
            const vCount = norm.variants?.length || 1;
            const lastEdit = b.savedAt || b.createdAt;
            const previewText = activeV?.script_copy || activeV?.objective || activeV?.core_message || b.script_copy || b.objective || '';
            return `
            <div class="panel p-4 fadein">
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-1.5">
                  <span class="pill ${(b.funnel_stage||'').toLowerCase()}">${esc(b.funnel_stage||'')}</span>
                  <span class="pill mono" title="${vCount} saved copies">${vCount} copies</span>
                  ${b.regenerated?`<span class="pill accent" style="padding:1px 5px;font-size:10px">↻</span>`:''}
                </div>
                <span class="mono text-[11px] text-[var(--ink3)]">EVI ${(b.evi_score||0).toFixed(1)}</span>
              </div>
              <div class="text-[12.5px] font-semibold mb-1.5 line-clamp-2" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(b.hook||b.objective||'Untitled brief')}</div>
              <div class="flex flex-wrap gap-1.5 mb-3">
                <span class="pill">${esc(b.platform||'')}</span>
                <span class="pill">${esc(b.format||'')}</span>
              </div>
              <div class="text-[11px] text-[var(--ink2)] mb-3 max-h-32 overflow-y-auto whitespace-pre-wrap leading-relaxed">${esc(previewText)}</div>
              <div class="text-[10.5px] text-[var(--ink3)] mb-3">Last edit ${timeAgo(lastEdit)}</div>
              <div class="flex gap-2">
                <button class="btn primary" style="padding:5px 10px;flex:1;font-size:12px" data-view-brief="${b.brandId}|${b.id}">View / Edit</button>
                <button class="btn ghost danger" style="padding:5px 8px" data-delete-brief="${b.brandId}|${b.id}">${ICONS.trash}</button>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

/* ----- TRENDS VIEW ----- */
function renderTrendsView(){
  const brand=state.brands.find(b=>b.id===state.activeBrandId);
  if(!brand) return renderSelectBrandHint('Select a brand to fetch live industry trends and thought leadership.');
  const t=state.trends;
  if(!t){
    return `<div class="panel empty">
      <div class="text-[14px] font-semibold mb-1 text-[var(--ink)]">No trends fetched yet for ${esc(brand.name)}</div>
      <div class="text-[12px] mb-4">Click <b class="text-[var(--ink2)]">Fetch Trends</b> to run live web search across the ${esc(brand.vertical||'industry')} category.</div>
    </div>`;
  }
  return `
    <div class="panel p-5 mb-4">
      <div class="flex items-center justify-between">
        <div>
          <div class="text-[14px] font-semibold">${esc(brand.name)} · ${esc(brand.vertical||'Industry')}</div>
          <div class="text-[11.5px] text-[var(--ink3)]">Snapshot generated ${timeAgo(t.createdAt)} · ${esc(brand.location||'global')}</div>
        </div>
        <span class="pill accent">Live web search</span>
      </div>
    </div>

    ${t.executive_summary?`<div class="panel p-5 mb-4"><div class="text-[12px] font-semibold text-[var(--ink2)] uppercase tracking-wider mb-2">Executive Summary</div><div class="text-[13px] leading-relaxed text-[var(--ink)]">${esc(t.executive_summary)}</div></div>`:''}

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
      ${[
        {title:'Emerging Trends',items:t.emerging_trends,color:'var(--accent)'},
        {title:'Consumer Shifts',items:t.consumer_shifts,color:'var(--accent2)'},
        {title:'Competitor Plays',items:t.competitor_moves,color:'#a855f7'},
        {title:'Content Opportunities',items:t.content_opportunities,color:'var(--good)'},
      ].map(s=>`
        <div class="panel p-5">
          <div class="flex items-center gap-2 mb-3">
            <div class="w-1.5 h-1.5 rounded-full" style="background:${s.color}"></div>
            <div class="text-[12px] font-semibold uppercase tracking-wider">${s.title}</div>
          </div>
          ${(s.items||[]).length?`<ol class="space-y-3">${(s.items||[]).map((it,i)=>`
            <li class="flex gap-3">
              <div class="mono text-[10.5px] text-[var(--ink3)] pt-0.5 w-5">${String(i+1).padStart(2,'0')}</div>
              <div class="flex-1">
                <div class="text-[12.5px] font-semibold mb-0.5">${esc(it.title||it.headline||'')}</div>
                <div class="text-[11.5px] text-[var(--ink2)] leading-relaxed">${esc(it.detail||it.description||'')}</div>
                ${it.source?`<div class="text-[10.5px] text-[var(--ink3)] mt-1 mono">${esc(it.source)}</div>`:''}
              </div>
            </li>`).join('')}</ol>`:`<div class="text-[12px] text-[var(--ink3)]">No items returned.</div>`}
        </div>
      `).join('')}
    </div>

    ${t.thought_leadership_angles?.length?`
      <div class="panel p-5 mb-4">
        <div class="text-[12px] font-semibold text-[var(--ink2)] uppercase tracking-wider mb-3">Thought Leadership Angles for ${esc(brand.name)}</div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          ${t.thought_leadership_angles.map((a,i)=>`
            <div class="panel2 p-4">
              <div class="flex items-start gap-2 mb-1.5">
                <span class="mono text-[10.5px] text-[var(--ink3)]">${String(i+1).padStart(2,'0')}</span>
                <div class="text-[13px] font-semibold flex-1">${esc(a.angle||a.title||'')}</div>
              </div>
              <div class="text-[11.5px] text-[var(--ink2)] leading-relaxed mb-2">${esc(a.rationale||a.description||'')}</div>
              ${a.platforms?`<div class="flex gap-1 flex-wrap">${(Array.isArray(a.platforms)?a.platforms:[a.platforms]).map(p=>`<span class="pill">${esc(p)}</span>`).join('')}</div>`:''}
            </div>
          `).join('')}
        </div>
      </div>
    `:''}

    ${t.sources?.length?`<div class="panel p-4 text-[11px] text-[var(--ink3)]">
      <div class="font-semibold mb-1.5 text-[var(--ink2)] uppercase tracking-wider text-[10.5px]">Sources cited</div>
      <div class="leading-relaxed">${t.sources.map(s=>esc(s)).join(' · ')}</div>
    </div>`:''}
  `;
}

/* ----- ANALYTICS VIEW ----- */
function renderAnalyticsView(){
  const all=[];
  state.brands.forEach(b=>{
    // We need calendars for each brand — these are lazy-loaded here
  });
  return `
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4" id="analytics-stats">
    <div class="panel p-4 skeleton" style="height:90px"></div>
    <div class="panel p-4 skeleton" style="height:90px"></div>
    <div class="panel p-4 skeleton" style="height:90px"></div>
  </div>
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
    <div class="panel p-4"><div class="text-[12px] font-semibold text-[var(--ink2)] uppercase tracking-wider mb-3">EVI Distribution</div><canvas id="chart-evi" height="220"></canvas></div>
    <div class="panel p-4"><div class="text-[12px] font-semibold text-[var(--ink2)] uppercase tracking-wider mb-3">Funnel Mix by Brand</div><canvas id="chart-funnel" height="220"></canvas></div>
    <div class="panel p-4"><div class="text-[12px] font-semibold text-[var(--ink2)] uppercase tracking-wider mb-3">Platform Mix</div><canvas id="chart-platform" height="220"></canvas></div>
    <div class="panel p-4"><div class="text-[12px] font-semibold text-[var(--ink2)] uppercase tracking-wider mb-3">Hook Type Performance</div><canvas id="chart-hooks" height="220"></canvas></div>
  </div>`;
}

async function drawAnalytics(){
  // gather all calendars across brands
  const all=[];
  for(const b of state.brands){
    const cs=await Store.listCalendars(b.id);
    cs.forEach(c=>{ (c.posts||[]).forEach(p=>all.push({...p,brand:b.name,brandId:b.id})); });
  }
  const stats=document.getElementById('analytics-stats');
  if(!all.length){ if(stats) stats.innerHTML=`<div class="panel empty col-span-full"><div class="text-[13px] font-semibold mb-1 text-[var(--ink)]">No calendar data yet</div><div class="text-[12px]">Generate calendars on at least one brand to populate analytics.</div></div>`; return; }
  const avg=all.reduce((s,p)=>s+(p.evi_score||0),0)/all.length;
  const high=all.filter(p=>(p.evi_score||0)>=7.5).length;
  const low=all.filter(p=>(p.evi_score||0)<5.5).length;
  if(stats) stats.innerHTML=[
    {l:'Total posts (all brands)',v:all.length,s:`${state.brands.length} brand${state.brands.length>1?'s':''}`},
    {l:'Average EVI',v:avg.toFixed(2),s:'target ≥ 7.0',cls:avg>=7?'text-[var(--good)]':avg>=5.5?'text-[var(--warn)]':'text-[var(--bad)]'},
    {l:'High-priority / Low',v:`${high} / ${low}`,s:'EVI ≥ 7.5 vs < 5.5'},
  ].map(s=>`<div class="panel p-4"><div class="text-[10.5px] uppercase tracking-wider text-[var(--ink3)] font-semibold mb-1">${s.l}</div><div class="text-[24px] font-semibold mono ${s.cls||''}">${s.v}</div><div class="text-[10.5px] text-[var(--ink3)] mt-0.5">${s.s}</div></div>`).join('');

  const co={grid:{color:'#e5e7eb'},ticks:{color:'#64748b',font:{size:10}},border:{color:'#e5e7eb'}};
  Chart.defaults.color='#64748b';
  Chart.defaults.borderColor='#e5e7eb';
  Chart.defaults.font.family="'Inter',sans-serif";

  // EVI histogram
  const buckets=[0,0,0,0,0,0,0,0,0,0];
  all.forEach(p=>{ const b=Math.min(9,Math.floor(p.evi_score||0)); buckets[b]++; });
  new Chart(document.getElementById('chart-evi'),{type:'bar',data:{labels:['0-1','1-2','2-3','3-4','4-5','5-6','6-7','7-8','8-9','9-10'],datasets:[{label:'Posts',data:buckets,backgroundColor:buckets.map((_,i)=>i>=7?'#10b981':i>=5?'#5b54e5':'#ef4444'),borderRadius:6,borderSkipped:false}]},options:{plugins:{legend:{display:false}},scales:{x:co,y:co}}});

  // Funnel mix per brand
  const brands=[...new Set(all.map(p=>p.brand))];
  const tofu=brands.map(b=>all.filter(p=>p.brand===b&&p.funnel_stage==='TOFU').length);
  const mofu=brands.map(b=>all.filter(p=>p.brand===b&&p.funnel_stage==='MOFU').length);
  const bofu=brands.map(b=>all.filter(p=>p.brand===b&&p.funnel_stage==='BOFU').length);
  new Chart(document.getElementById('chart-funnel'),{type:'bar',data:{labels:brands,datasets:[
    {label:'TOFU',data:tofu,backgroundColor:'#0891b2'},
    {label:'MOFU',data:mofu,backgroundColor:'#7c3aed'},
    {label:'BOFU',data:bofu,backgroundColor:'#ea580c'},
  ]},options:{plugins:{legend:{position:'bottom',labels:{boxWidth:10,boxHeight:10,padding:14}}},scales:{x:{...co,stacked:true},y:{...co,stacked:true}}}});

  // Platform mix
  const plat={}; all.forEach(p=>{plat[p.platform||'?']=(plat[p.platform||'?']||0)+1});
  new Chart(document.getElementById('chart-platform'),{type:'doughnut',data:{labels:Object.keys(plat),datasets:[{data:Object.values(plat),backgroundColor:['#5b54e5','#0891b2','#7c3aed','#ea580c','#10b981','#f59e0b','#ef4444','#0a66c2'],borderColor:'#fff',borderWidth:2}]},options:{plugins:{legend:{position:'right',labels:{boxWidth:10,boxHeight:10,padding:10,font:{size:11}}}},cutout:'62%'}});

  // Hook performance — avg EVI by hook
  const hooks={}; all.forEach(p=>{const h=p.hook_type||'Other'; (hooks[h]=hooks[h]||[]).push(p.evi_score||0)});
  const hLabels=Object.keys(hooks); const hVals=hLabels.map(k=>hooks[k].reduce((s,v)=>s+v,0)/hooks[k].length);
  new Chart(document.getElementById('chart-hooks'),{type:'bar',data:{labels:hLabels,datasets:[{label:'Avg EVI',data:hVals,backgroundColor:'#5b54e5',borderRadius:6,borderSkipped:false}]},options:{indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{...co,min:0,max:10},y:co}}});
}

/* ----- MODAL ----- */
function renderModal(){
  const m=state.modal;
  if(m.kind==='brand-form') return renderBrandFormModal(m);
  if(m.kind==='generate-calendar') return renderGenerateCalendarModal(m);
  if(m.kind==='post-detail') return renderPostDetailModal(m);
  if(m.kind==='view-brief') return renderBriefDetailModal(m);
  if(m.kind==='confirm') return renderConfirmModal(m);
  if(m.kind==='loading') return renderLoadingModal(m);
  if(m.kind==='error') return renderErrorModal(m);
  return '';
}

function renderBrandFormModal(m){
  const b=m.data||{};
  return `<div class="modal-backdrop" data-close-modal>
    <div class="panel p-6 w-full max-w-3xl max-h-[88vh] overflow-auto" onclick="event.stopPropagation()">
      <div class="flex items-center justify-between mb-5">
        <div>
          <div class="text-[16px] font-semibold">${b.id?'Edit Brand':'New Brand'}</div>
          <div class="text-[11.5px] text-[var(--ink3)]">All 12 fields feed the McKinsey-grade strategy engine</div>
        </div>
        <button class="btn ghost" data-close-modal>${ICONS.close}</button>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div><label class="label">Brand Name *</label><input class="input" id="f-name" value="${esc(b.name||'')}" placeholder="Acme Brands"/></div>
        <div><label class="label">Website URL *</label><input class="input" id="f-website_url" value="${esc(b.website_url||'')}" placeholder="https://acme.com"/></div>
        <div><label class="label">Vertical / Sub-segment *</label><input class="input" id="f-vertical" value="${esc(b.vertical||'')}" placeholder="D2C protein supplements"/></div>
        <div><label class="label">Location (Country → City) *</label><input class="input" id="f-location" value="${esc(b.location||'')}" placeholder="India → Bangalore"/></div>
        <div><label class="label">Business Model *</label><select class="select" id="f-business_model">${['B2B','B2C','B2G','D2C','Marketplace'].map(o=>`<option ${o===(b.business_model||'B2C')?'selected':''}>${o}</option>`).join('')}</select></div>
        <div><label class="label">Price Tier *</label><select class="select" id="f-price_sensitivity_tier">${['Premium','Mid-Market','Value','Discount'].map(o=>`<option ${o===(b.price_sensitivity_tier||'Mid-Market')?'selected':''}>${o}</option>`).join('')}</select></div>
        <div><label class="label">Purchase Cycle *</label><input class="input" id="f-purchase_cycle_length" value="${esc(b.purchase_cycle_length||'')}" placeholder="14 days / 3 months"/></div>
        <div><label class="label">Avg Transaction Value *</label><input class="input" id="f-avg_transaction_value" value="${esc(b.avg_transaction_value||'')}" placeholder="₹1,800 AOV"/></div>
        <div><label class="label">Time Horizon *</label><select class="select" id="f-time_horizon">${['30','60','90','180','365'].map(o=>`<option value="${o}" ${o===String(b.time_horizon||'30')?'selected':''}>${o} days</option>`).join('')}</select></div>
        <div class="md:col-span-2"><label class="label">Target Customer Profile *</label><textarea class="textarea" id="f-target_customer_profile" placeholder="Demographics + psychographics + decision role">${esc(b.target_customer_profile||'')}</textarea></div>
        <div class="md:col-span-2"><label class="label">Growth Objective *</label><textarea class="textarea" id="f-growth_objective" placeholder="2x leads in 90 days from Bangalore + Mumbai">${esc(b.growth_objective||'')}</textarea></div>
        <div><label class="label">Product Placement Context *</label><select class="select" id="f-product_placement_context">${['E-comm','Lead Gen','App Install','Retail Pickup','B2B Sales'].map(o=>`<option ${o===(b.product_placement_context||'Lead Gen')?'selected':''}>${o}</option>`).join('')}</select></div>
        <div><label class="label">Brand Voice Notes</label><input class="input" id="f-brand_voice" value="${esc(b.brand_voice||'')}" placeholder="Bold, pragmatic, data-led"/></div>
      </div>
      <div class="flex justify-end gap-2 mt-6">
        <button class="btn" data-close-modal>Cancel</button>
        <button class="btn primary" data-action="save-brand">${b.id?'Save Changes':'Create Brand'}</button>
      </div>
    </div>
  </div>`;
}

function renderGenerateCalendarModal(m){
  const brand=state.brands.find(b=>b.id===state.activeBrandId);
  // Initialize channel state if not set, with smart defaults per business model
  if(!state._chanSel){
    const bm=brand.business_model||'B2C';
    const defaults = {
      'B2B':       {LinkedIn:15, YouTube:6, X:8, Instagram:4, Facebook:0, TikTok:0, Threads:0},
      'B2C':       {Instagram:14, TikTok:10, YouTube:5, Facebook:5, LinkedIn:0, X:3, Threads:3},
      'D2C':       {Instagram:16, TikTok:10, YouTube:5, Facebook:4, LinkedIn:0, X:0, Threads:5},
      'B2G':       {LinkedIn:14, Facebook:8, X:6, YouTube:4, Instagram:4, TikTok:0, Threads:0},
      'Marketplace': {Instagram:14, TikTok:8, YouTube:4, Facebook:6, LinkedIn:4, X:4, Threads:0}
    };
    state._chanSel = JSON.parse(JSON.stringify(defaults[bm]||defaults['B2C']));
  }
  const ch = state._chanSel;
  const channels = [
    {key:'Instagram', icon:'📷', color:'#e1306c'},
    {key:'Facebook',  icon:'👤', color:'#1877f2'},
    {key:'LinkedIn',  icon:'💼', color:'#0a66c2'},
    {key:'YouTube',   icon:'▶',  color:'#ff0000'},
    {key:'TikTok',    icon:'♪',  color:'#fff'},
    {key:'X',         icon:'𝕏',  color:'#fff'},
    {key:'Threads',   icon:'@',  color:'#fff'},
  ];
  const total = Object.values(ch).reduce((s,v)=>s+(Number(v)||0),0);
  const days = Number(state._chanDays||30);
  const perDay = days>0?(total/days).toFixed(1):'0';

  return `<div class="modal-backdrop" data-close-modal>
    <div class="panel p-6 w-full max-w-2xl max-h-[92vh] overflow-auto scroll" onclick="event.stopPropagation()">
      <div class="flex items-center justify-between mb-4">
        <div>
          <div class="text-[16px] font-semibold">Generate calendar</div>
          <div class="text-[11.5px] text-[var(--ink3)]">${esc(brand.name)} · ${esc(brand.vertical||'')}</div>
        </div>
        <button class="btn ghost" data-close-modal>${ICONS.close}</button>
      </div>

      <div class="space-y-4">
        <div><label class="label">Calendar title</label><input class="input" id="g-title" placeholder="${esc(brand.name)} · ${monthName(new Date())}" value="${esc(brand.name)} · ${monthName(new Date())}"/></div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="label">Start date</label>
            <input class="input date-input" type="date" id="g-start" value="${todayISO()}"/>
          </div>
          <div>
            <label class="label">Days</label>
            <select class="select" id="g-days" data-chan-days>
              <option ${days===30?'selected':''}>30</option>
              <option ${days===60?'selected':''}>60</option>
              <option ${days===90?'selected':''}>90</option>
            </select>
          </div>
        </div>

        <div>
          <div class="flex items-center justify-between mb-2">
            <label class="label" style="margin:0">Channels &amp; post quantity</label>
            <div class="flex gap-2">
              <button class="btn ghost" style="padding:4px 9px;font-size:11px" data-chan-action="reset">Reset</button>
              <button class="btn ghost" style="padding:4px 9px;font-size:11px" data-chan-action="clear">Clear all</button>
            </div>
          </div>
          <div class="panel2 p-3 space-y-1.5">
            ${channels.map(c=>{
              const count = Number(ch[c.key]||0);
              const active = count>0;
              return `
              <div class="flex items-center gap-3 p-2 rounded-lg ${active?'channel-row-active':'channel-row'}" data-chan-row="${c.key}">
                <label class="flex items-center gap-2.5 flex-1 cursor-pointer min-w-0" data-chan-toggle="${c.key}">
                  <span class="custom-checkbox ${active?'checked':''}">
                    ${active?'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3.5"><path d="M5 12l5 5L20 7"/></svg>':''}
                  </span>
                  <span class="w-6 h-6 rounded-md flex items-center justify-center text-[12px] shrink-0" style="background:${c.color};color:${c.key==='TikTok'||c.key==='X'||c.key==='Threads'?'#000':'#fff'}">${c.icon}</span>
                  <span class="text-[13px] font-medium ${active?'text-[var(--ink)]':'text-[var(--ink2)]'}">${c.key}</span>
                </label>
                <div class="flex items-center gap-1.5">
                  <button class="stepper" data-chan-step="${c.key}|-1" ${!active||count<=0?'disabled':''}>−</button>
                  <input class="stepper-input" type="number" min="0" max="999" value="${count}" data-chan-input="${c.key}"/>
                  <button class="stepper" data-chan-step="${c.key}|1">+</button>
                </div>
              </div>`;
            }).join('')}
          </div>
        </div>

        <div class="grid grid-cols-3 gap-2">
          <div class="panel2 p-3 text-center">
            <div class="text-[10px] uppercase tracking-wider text-[var(--ink3)] font-semibold mb-1">Total Posts</div>
            <div class="text-[20px] font-bold mono grad-text">${total}</div>
          </div>
          <div class="panel2 p-3 text-center">
            <div class="text-[10px] uppercase tracking-wider text-[var(--ink3)] font-semibold mb-1">Per Day Avg</div>
            <div class="text-[20px] font-bold mono ${total>0?'text-[var(--ink)]':'text-[var(--ink3)]'}">${perDay}</div>
          </div>
          <div class="panel2 p-3 text-center">
            <div class="text-[10px] uppercase tracking-wider text-[var(--ink3)] font-semibold mb-1">Active Channels</div>
            <div class="text-[20px] font-bold mono ${total>0?'text-[var(--accent2)]':'text-[var(--ink3)]'}">${Object.values(ch).filter(v=>v>0).length}</div>
          </div>
        </div>

        <div><label class="label">Special focus / extra context</label><textarea class="textarea" id="g-focus" placeholder="Holiday push, product launch, hiring campaign, etc."></textarea></div>

        ${total===0?`<div class="panel2 p-3 text-[11.5px]" style="border-color:rgba(245,158,11,.4);background:rgba(245,158,11,.06);color:#fbbf24">⚠ Select at least one channel and set post quantity before generating.</div>`:`<div class="panel2 p-3 text-[11.5px] text-[var(--ink2)]">
          Will generate <b class="text-[var(--ink)]">${total} posts</b> across <b class="text-[var(--ink)]">${Object.values(ch).filter(v=>v>0).length} channels</b> over <b class="text-[var(--ink)]">${days} days</b>, EVI-scored and funnel-mapped per the McKinsey Senior Partner v2.0 framework. Takes ~${Math.ceil(total/12)*30}–${Math.ceil(total/12)*60}s.
        </div>`}
      </div>

      <div class="flex justify-end gap-2 mt-5">
        <button class="btn" data-close-modal>Cancel</button>
        <button class="btn primary" data-action="run-calendar" ${total===0?'disabled':''}>${ICONS.spark} Run Generation</button>
      </div>
    </div>
  </div>`;
}

function renderPostDetailModal(m){
  const post=m.data;
  const briefFlow=!!m.briefFlow;
  const editMode = !!state._postEdit;
  const editing = editMode ? state._postEdit : post;
  const versions = post.versions || [];
  const showHistory = !!state._postShowHist;

  return `<div class="modal-backdrop" data-close-modal>
    <div class="panel p-6 w-full max-w-3xl max-h-[92vh] overflow-auto scroll" onclick="event.stopPropagation()">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="pill ${(post.funnel_stage||'').toLowerCase()}">${esc(post.funnel_stage||'')}</span>
          <span class="pill">${esc(post.platform||'')}</span>
          <span class="pill">${esc(post.format||'')}</span>
          <span class="pill mono">EVI ${(post.evi_score||0).toFixed(1)}</span>
          ${versions.length?`<span class="pill accent">v${versions.length+1}</span>`:`<span class="pill">v1</span>`}
        </div>
        <button class="btn ghost" data-close-modal>${ICONS.close}</button>
      </div>
      <div class="text-[11.5px] text-[var(--ink3)] mono mb-3">${esc(post.content_id||'')} · ${esc(post.date||'')} · ${esc(post.day||'')}</div>

      ${editMode?`<div class="panel2 p-2.5 mb-4 flex items-center gap-2" style="border-color:rgba(124,92,255,.4);background:rgba(124,92,255,.06)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7c5cff" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        <div class="text-[12px] text-[var(--ink)] flex-1"><b>Editing post</b> — adjust fields, then Save to commit a new version.</div>
      </div>`:''}

      ${editMode?`
        <div class="mb-4">
          <label class="label">Hook / Headline</label>
          <input class="input" data-post-field="hook" value="${esc(editing.hook||'')}"/>
        </div>
        <div class="mb-4">
          <label class="label">Caption Preview</label>
          <textarea class="textarea" data-post-field="caption_preview">${esc(editing.caption_preview||'')}</textarea>
        </div>
        <div class="grid grid-cols-2 gap-3 mb-4">
          <div><label class="label">Intent</label><input class="input" data-post-field="intent" value="${esc(editing.intent||'')}"/></div>
          <div><label class="label">Hook Type</label><input class="input" data-post-field="hook_type" value="${esc(editing.hook_type||'')}"/></div>
          <div><label class="label">Sentiment</label><input class="input" data-post-field="sentiment" value="${esc(editing.sentiment||'')}"/></div>
          <div><label class="label">Segment</label><input class="input" data-post-field="segment" value="${esc(editing.segment||'')}"/></div>
          <div class="col-span-2"><label class="label">CTA</label><input class="input" data-post-field="cta" value="${esc(editing.cta||'')}"/></div>
          <div class="col-span-2"><label class="label">Tracking URL</label><input class="input" data-post-field="tracking_url" value="${esc(editing.tracking_url||'')}"/></div>
        </div>
        <div class="mb-3"><label class="label">Creative Direction</label><textarea class="textarea" data-post-field="creative_direction">${esc(editing.creative_direction||'')}</textarea></div>
        <div class="mb-3"><label class="label">Visual Specs</label><textarea class="textarea" data-post-field="visual_specs">${esc(editing.visual_specs||'')}</textarea></div>
        <div class="grid grid-cols-2 gap-3 mb-3">
          <div><label class="label">EVI Score</label><input class="input mono" type="number" step="0.1" min="0" max="10" data-post-field="evi_score" value="${editing.evi_score||0}"/></div>
          <div><label class="label">Status</label><input class="input" data-post-field="status" value="${esc(editing.status||'Draft')}"/></div>
        </div>
      `:`
        <div class="text-[16px] font-semibold mb-3">${esc(post.hook||'')}</div>
        ${post.caption_preview?`<div class="panel2 p-3 mb-4 text-[12.5px] leading-relaxed whitespace-pre-wrap">${esc(post.caption_preview)}</div>`:''}
        <div class="grid grid-cols-2 gap-3 text-[12px] mb-4">
          ${[
            ['Intent',post.intent],['Hook Type',post.hook_type],['Sentiment',post.sentiment],['Segment',post.segment],['CTA',post.cta],['Tracking',post.tracking_url],
          ].map(([k,v])=>v?`<div class="panel2 p-3"><div class="text-[10.5px] uppercase tracking-wider text-[var(--ink3)] font-semibold">${k}</div><div class="text-[12px] mt-0.5 break-words">${esc(v)}</div></div>`:'').join('')}
        </div>
        ${post.creative_direction?`<div class="mb-3"><div class="label">Creative Direction</div><div class="panel2 p-3 text-[12px] leading-relaxed whitespace-pre-wrap">${esc(post.creative_direction)}</div></div>`:''}
        ${post.visual_specs?`<div class="mb-3"><div class="label">Visual Specs</div><div class="panel2 p-3 text-[12px] leading-relaxed whitespace-pre-wrap">${esc(post.visual_specs)}</div></div>`:''}
      `}

      ${versions.length?`
        <div class="mt-5 border-t border-[var(--line)] pt-4">
          <button class="flex items-center gap-2 text-[12px] font-semibold text-[var(--ink2)] hover:text-[var(--ink)]" data-action="toggle-post-history">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transform:rotate(${showHistory?'90deg':'0'});transition:transform .15s"><polyline points="9 18 15 12 9 6"/></svg>
            <span>Version history</span>
            <span class="pill mono" style="padding:1px 6px">${versions.length}</span>
          </button>
          ${showHistory?`<div class="mt-3 space-y-2">${versions.map((v,i)=>{
            const versionNum = versions.length - i;
            return `<div class="panel2 p-3">
              <div class="flex items-center justify-between mb-1.5">
                <div class="flex items-center gap-2">
                  <span class="pill mono">v${versionNum}</span>
                  <span class="text-[11px] text-[var(--ink3)]">${timeAgo(v.savedAt)}</span>
                  ${v.regenerated?`<span class="pill accent">regenerated</span>`:`<span class="pill">edited</span>`}
                  <span class="pill mono" style="padding:1px 6px">EVI ${(v.evi_score||0).toFixed(1)}</span>
                </div>
                <button class="btn ghost" style="padding:3px 8px;font-size:11px" data-action="restore-post-version" data-version-idx="${i}">Restore</button>
              </div>
              <div class="text-[12px] font-medium truncate">${esc(v.hook||'(no hook)')}</div>
            </div>`;
          }).join('')}</div>`:''}
        </div>
      `:''}

      ${briefFlow&&!editMode?`<div class="panel2 p-3 mb-4 text-[12.5px] text-[var(--ink2)]" style="border-color:rgba(124,92,255,.35);background:rgba(124,92,255,.06)">
        Review this post, then generate a production-grade creative brief. You can edit fields first if needed.
      </div>`:''}

      <div class="flex justify-between gap-2 mt-5 pt-4 border-t border-[var(--line)]">
        <div class="flex gap-2">
          ${!editMode?`<button class="btn primary" data-action="brief-from-post">${ICONS.spark} Generate Creative Brief</button>`:''}
        </div>
        <div class="flex gap-2">
          ${editMode?`
            <button class="btn" data-action="cancel-edit-post">Cancel Edit</button>
            <button class="btn primary" data-action="save-post-edit">${ICONS.spark} Save</button>
          `:`
            <button class="btn" data-action="edit-post">${ICONS.edit} Edit</button>
            <button class="btn" data-action="regenerate-post">${ICONS.refresh} Regenerate</button>
            <button class="btn primary" data-close-modal>Done</button>
          `}
        </div>
      </div>
    </div>
  </div>`;
}

function renderBriefDetailModal(m){
  const record = normalizeBrief(m.data);
  const active = getActiveVariant(record);
  const editMode = !!state._briefEdit;
  const editing = editMode ? state._briefEdit : active;
  const alternates = sortedBriefVariants(record).filter(v=>v.source === 'regenerated');
  const showRegenerated = !!state._briefShowRegenerated;

  const fields = [
    ['hook','Hook (first 3 seconds)','input'],
    ['objective','Objective','textarea'],
    ['target_audience','Target Audience','textarea'],
    ['core_message','Core Message','textarea'],
    ['script_copy','Script / Copy','textarea'],
    ['visual_direction','Visual Direction','textarea'],
    ['audio_direction','Audio Direction','textarea'],
    ['technical_specs','Technical Specs','textarea'],
    ['cta_block','CTA','textarea'],
    ['compliance','Compliance','textarea'],
  ];

  return `<div class="modal-backdrop" data-close-modal>
    <div class="panel p-6 w-full max-w-4xl max-h-[92vh] overflow-auto scroll" onclick="event.stopPropagation()">
      <div class="flex items-start justify-between mb-4 gap-3">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="pill ${(record.funnel_stage||'').toLowerCase()}">${esc(record.funnel_stage||'')}</span>
          <span class="pill">${esc(record.platform||'')}</span>
          <span class="pill">${esc(record.format||'')}</span>
          <span class="pill mono">EVI ${(record.evi_score||0).toFixed(1)}</span>
          ${record.content_id?`<span class="pill mono">${esc(record.content_id)}</span>`:''}
        </div>
        <button class="btn ghost" data-close-modal>${ICONS.close}</button>
      </div>

      ${editMode?`<div class="panel2 p-2.5 mb-4 flex items-center gap-2" style="border-color:rgba(124,92,255,.4);background:rgba(124,92,255,.06)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7c5cff" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        <div class="text-[12px] text-[var(--ink)] flex-1"><b>Editing this brief</b> — Save overwrites the active copy only. No new brief is created.</div>
      </div>`:''}

      ${editMode?`
        <div class="mb-4">
          <label class="label">Hook / Title</label>
          <input class="input" data-brief-field="hook" value="${esc(editing?.hook||'')}"/>
        </div>
      `:`<div class="mb-4">
        <div class="flex items-center gap-2 flex-wrap mb-1">
          <div class="text-[18px] font-semibold">${esc(active?.hook||active?.objective||'Brief')}</div>
          <span class="pill accent">Active</span>
        </div>
        ${active?`<div class="text-[11px] text-[var(--ink3)] mono">${esc(formatVariantDateTime(active.savedAt))} · ${esc(variantSourceLabel(active.source))}</div>`:''}
      </div>`}

      <div class="space-y-3">
        ${fields.filter(([k])=>k!=='hook').map(([k,label,type])=>{
          const val = editing[k]||'';
          if(editMode){
            return `<div>
              <label class="label">${label}</label>
              ${type==='textarea'?
                `<textarea class="textarea" data-brief-field="${k}" style="min-height:80px">${esc(val)}</textarea>`
                : `<input class="input" data-brief-field="${k}" value="${esc(val)}"/>`
              }
            </div>`;
          }
          if(!val) return '';
          return `<div>
            <div class="text-[10.5px] uppercase tracking-wider text-[var(--ink3)] font-semibold mb-1">${label}</div>
            <div class="panel2 p-3 text-[12.5px] leading-relaxed whitespace-pre-wrap">${esc(val)}</div>
          </div>`;
        }).join('')}
      </div>

      ${alternates.length?`
        <div class="mt-5 border-t border-[var(--line)] pt-4">
          <button type="button" class="flex items-center gap-2 text-[12px] font-semibold text-[var(--ink2)] hover:text-[var(--ink)] w-full text-left" data-action="toggle-regenerated-copies">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transform:rotate(${showRegenerated?'90deg':'0deg'});transition:transform .15s"><polyline points="9 18 15 12 9 6"/></svg>
            <span class="uppercase tracking-wider">Regenerated copies</span>
            <span class="pill mono" style="padding:1px 6px">${alternates.length}</span>
          </button>
          ${showRegenerated?`
          <div class="text-[11px] text-[var(--ink3)] mt-2 mb-3">The <b class="text-[var(--ink2)]">active</b> brief is above (edit updates it). <b>Regenerate</b> adds another copy here — choose which one is active.</div>
          <div class="space-y-2">
            ${alternates.map(v=>{
              const isActive = v.id === record.activeVariantId;
              return `<div class="panel2 p-3 ${isActive?'glow':''}" style="${isActive?'border-color:rgba(124,92,255,.45)':''}">
                <div class="flex items-start justify-between gap-2 mb-1.5">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap mb-1">
                      ${isActive?`<span class="pill accent">Active</span>`:''}
                      <span class="pill">${esc(variantSourceLabel(v.source))}</span>
                      <span class="text-[11px] text-[var(--ink3)] mono">${esc(formatVariantDateTime(v.savedAt))}</span>
                    </div>
                    <div class="text-[12px] font-medium truncate">${esc(v.hook||v.objective||'(no title)')}</div>
                    <div class="text-[11px] text-[var(--ink2)] mt-0.5 max-h-24 overflow-y-auto whitespace-pre-wrap leading-relaxed">${esc(v.script_copy||v.objective||v.core_message||'')}</div>
                  </div>
                  ${isActive
                    ? `<span class="text-[11px] text-[var(--accent)] font-semibold shrink-0">In use</span>`
                    : `<button type="button" class="btn primary shrink-0" style="padding:4px 10px;font-size:11px" data-set-active-variant="${v.id}">Set as active</button>`}
                </div>
              </div>`;
            }).join('')}
          </div>
          `:''}
        </div>
      `:''}

      <div class="flex justify-between gap-2 mt-5 pt-4 border-t border-[var(--line)]">
        <div class="flex gap-2">
          ${!editMode?`<button class="btn" data-action="copy-brief">${ICONS.copy} Copy Markdown</button>`:''}
        </div>
        <div class="flex gap-2">
          ${editMode?`
            <button class="btn" data-action="cancel-edit-brief">Cancel Edit</button>
            <button class="btn primary" data-action="save-brief-edit">${ICONS.spark} Save</button>
          `:`
            <button class="btn" data-action="edit-brief">${ICONS.edit} Edit</button>
            <button class="btn" data-action="regenerate-brief">${ICONS.refresh} Regenerate</button>
            <button class="btn primary" data-close-modal>Done</button>
          `}
        </div>
      </div>
    </div>
  </div>`;
}

function renderConfirmModal(m){
  return `<div class="modal-backdrop" data-close-modal>
    <div class="panel p-6 w-full max-w-md" onclick="event.stopPropagation()">
      <div class="text-[15px] font-semibold mb-2">${esc(m.title||'Confirm')}</div>
      <div class="text-[12.5px] text-[var(--ink2)] mb-5">${esc(m.body||'')}</div>
      <div class="flex justify-end gap-2">
        <button class="btn" data-close-modal>Cancel</button>
        <button class="btn ${m.danger?'danger':'primary'}" data-action="confirm-yes">${esc(m.confirmLabel||'Yes')}</button>
      </div>
    </div>
  </div>`;
}

function renderLoadingModal(m){
  const log = m.log || [];
  return `<div class="modal-backdrop">
    <div class="panel p-6 max-w-lg w-full">
      <div class="flex items-center gap-3 mb-3">
        <div class="inline-flex w-8 h-8 rounded-full border-2 border-[var(--accent)] border-t-transparent spin shrink-0"></div>
        <div class="flex-1 min-w-0">
          <div class="text-[14px] font-semibold">${esc(m.title||'Working…')}</div>
          <div class="text-[11.5px] text-[var(--ink3)] truncate">${esc(m.body||'')}</div>
        </div>
      </div>
      ${log.length?`<div class="panel2 p-3 mono text-[11px] leading-relaxed max-h-48 overflow-auto scroll" style="background:var(--panel2);color:var(--ink2)">
        ${log.map(l=>`<div class="${l.startsWith('✓')?'text-[var(--good)]':l.startsWith('✗')?'text-[var(--bad)]':'text-[var(--ink2)]'}">${esc(l)}</div>`).join('')}
      </div>`:''}
    </div>
  </div>`;
}

function renderErrorModal(m){
  const log = m.log || [];
  return `<div class="modal-backdrop" data-close-modal>
    <div class="panel p-6 max-w-lg w-full" onclick="event.stopPropagation()">
      <div class="flex items-start justify-between mb-3">
        <div class="flex items-center gap-2.5">
          <div class="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style="background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
          </div>
          <div>
            <div class="text-[14px] font-semibold">${esc(m.title||'Error')}</div>
            <div class="text-[11px] text-[var(--ink3)]">Generation could not complete</div>
          </div>
        </div>
        <button class="btn ghost" data-close-modal>${ICONS.close}</button>
      </div>
      <div class="panel2 p-3 mb-3 text-[12px] text-[var(--bad)] break-words">${esc(m.body||'Unknown error')}</div>
      ${log.length?`<div class="panel2 p-3 mono text-[11px] leading-relaxed max-h-40 overflow-auto scroll mb-4" style="background:var(--panel2);color:var(--ink2)">
        ${log.map(l=>`<div class="${l.startsWith('✓')?'text-[var(--good)]':l.startsWith('✗')?'text-[var(--bad)]':'text-[var(--ink2)]'}">${esc(l)}</div>`).join('')}
      </div>`:''}
      <div class="text-[11px] text-[var(--ink3)] leading-relaxed mb-4">
        Common causes: (1) the model returned malformed JSON, (2) max_tokens was hit mid-response, (3) the API request timed out, or (4) network/auth issue. Open the browser console (Cmd+Opt+I) for the full stack trace.
      </div>
      <div class="flex justify-end gap-2">
        ${m.partial?`<button class="btn" data-action="save-partial">Save ${m.partial} partial posts</button>`:''}
        ${m.canRetry?`<button class="btn primary" data-action="retry-calendar">Retry</button>`:''}
        <button class="btn ${m.canRetry||m.partial?'ghost':'primary'}" data-close-modal>Close</button>
      </div>
    </div>
  </div>`;
}

function renderToast(){
  const colors={ok:'var(--good)',err:'var(--bad)',info:'var(--accent)'};
  return `<div class="fixed bottom-6 right-6 z-[60] panel p-3 px-4 fadein" style="border-color:${colors[state.toast.kind]||'var(--line)'}">
    <div class="text-[12.5px] font-medium" style="color:${colors[state.toast.kind]||'var(--ink)'}">${esc(state.toast.msg)}</div>
  </div>`;
}

function renderSelectBrandHint(msg){
  return `<div class="panel empty">
    <div class="text-[14px] font-semibold mb-1 text-[var(--ink)]">No brand selected</div>
    <div class="text-[12px] mb-4">${esc(msg)}</div>
    <button class="btn" data-nav="brands">Go to Brands →</button>
  </div>`;
}

/* ========= HANDLERS ========= */
function attachHandlers(){
  document.querySelectorAll('[data-nav]').forEach(el=>{
    el.addEventListener('click',()=>{ goto(el.dataset.nav); });
  });
  const sw=document.getElementById('brand-switcher');
  if(sw) sw.addEventListener('change',e=>setActiveBrand(e.target.value));

  document.querySelectorAll('[data-action]').forEach(el=>{
    el.addEventListener('click',(e)=>{ e.stopPropagation(); handleAction(el.dataset.action); });
  });
  // Backdrop click closes modal (only when clicking the backdrop itself)
  document.querySelectorAll('.modal-backdrop[data-close-modal]').forEach(el=>{
    el.addEventListener('click',e=>{ if(e.target===el) closeModal(); });
  });
  // Explicit close buttons
  document.querySelectorAll('button[data-close-modal]').forEach(el=>{
    el.addEventListener('click',e=>{ e.stopPropagation(); closeModal(); });
  });
  document.querySelectorAll('[data-edit-brand]').forEach(el=>el.addEventListener('click',e=>{ e.stopPropagation(); const b=state.brands.find(x=>x.id===el.dataset.editBrand); openModal({kind:'brand-form',data:{...b}}); }));
  document.querySelectorAll('[data-delete-brand]').forEach(el=>el.addEventListener('click',e=>{ e.stopPropagation(); const id=el.dataset.deleteBrand; const b=state.brands.find(x=>x.id===id); openModal({kind:'confirm',title:'Delete brand?',body:`This will permanently remove "${b.name}" and all its calendars + briefs.`,danger:true,confirmLabel:'Delete',onYes:async()=>{ await Store.deleteBrand(id); state.brands=await Store.listBrands(); if(state.activeBrandId===id) state.activeBrandId=null; closeModal(); showToast('Brand deleted','ok'); }}); }));
  document.querySelectorAll('[data-open-brand]').forEach(el=>el.addEventListener('click',e=>{ setActiveBrand(el.dataset.openBrand); state.view='calendar'; loadBrandWorkspace(); }));
  document.querySelectorAll('[data-open-cal]').forEach(el=>el.addEventListener('click',()=>{ const c=state.calendars.find(x=>x.id===el.dataset.openCal); state.activeCalendar=c; render(); }));
  document.querySelectorAll('[data-delete-cal]').forEach(el=>el.addEventListener('click',e=>{ e.stopPropagation(); const id=el.dataset.deleteCal; openModal({kind:'confirm',title:'Delete calendar?',body:'This calendar and its posts will be removed.',danger:true,confirmLabel:'Delete',onYes:async()=>{ await Store.deleteCalendar(state.activeBrandId,id); state.calendars=await Store.listCalendars(state.activeBrandId); if(state.activeCalendar&&state.activeCalendar.id===id) state.activeCalendar=null; closeModal(); showToast('Calendar deleted','ok'); }}); }));
  document.querySelectorAll('[data-scroll-to-post]').forEach(el=>{
    const go=()=>scrollToPostRow(Number(el.dataset.scrollToPost));
    el.addEventListener('click',e=>{ e.stopPropagation(); go(); });
    el.addEventListener('keydown',e=>{
      if(e.key==='Enter' || e.key===' '){ e.preventDefault(); go(); }
    });
  });
  document.querySelectorAll('[data-post-detail]').forEach(el=>el.addEventListener('click',()=>{ const i=Number(el.dataset.postDetail); openModal({kind:'post-detail',data:state.activeCalendar.posts[i]}); }));
  document.querySelectorAll('[data-gen-brief-post]').forEach(el=>el.addEventListener('click',e=>{
    e.stopPropagation();
    const i=Number(el.dataset.genBriefPost);
    openModal({kind:'post-detail', data:state.activeCalendar.posts[i], briefFlow:true});
  }));
  document.querySelectorAll('[data-view-brief]').forEach(el=>el.addEventListener('click',async e=>{
    e.stopPropagation();
    const [bid,id]=el.dataset.viewBrief.split('|');
    let b=(state.briefs||[]).find(x=>x.id===id);
    if(!b){ const briefs=await Store.listBriefs(bid); b=briefs.find(x=>x.id===id); }
    if(b) openModal({kind:'view-brief',data:b});
  }));
  document.querySelectorAll('[data-delete-brief]').forEach(el=>el.addEventListener('click',e=>{e.stopPropagation(); const [bid,id]=el.dataset.deleteBrief.split('|'); openModal({kind:'confirm',title:'Delete brief?',danger:true,body:'This brief will be permanently removed.',confirmLabel:'Delete',onYes:async()=>{ await Store.deleteBrief(bid,id); state.allBriefs=await Store.listAllBriefs(); closeModal(); showToast('Brief deleted','ok'); }});}));
  document.querySelectorAll('[data-set-active-variant]').forEach(el=>el.addEventListener('click',e=>{
    e.stopPropagation();
    setBriefVariantActive(el.dataset.setActiveVariant);
  }));

  // Channel selector handlers (in Generate Calendar modal)
  document.querySelectorAll('[data-chan-step]').forEach(el=>el.addEventListener('click',e=>{
    e.preventDefault(); e.stopPropagation();
    const [key,delta]=el.dataset.chanStep.split('|');
    const cur=Number(state._chanSel[key]||0);
    const next=Math.max(0,Math.min(999,cur+Number(delta)));
    state._chanSel[key]=next;
    render();
  }));
  document.querySelectorAll('[data-chan-input]').forEach(el=>el.addEventListener('change',e=>{
    const key=el.dataset.chanInput;
    const v=Math.max(0,Math.min(999,Number(el.value)||0));
    state._chanSel[key]=v;
    render();
  }));
  document.querySelectorAll('[data-chan-toggle]').forEach(el=>el.addEventListener('click',e=>{
    e.preventDefault();
    const key=el.dataset.chanToggle;
    const cur=Number(state._chanSel[key]||0);
    if(cur>0){ state._chanSel[key]=0; }
    else { state._chanSel[key]=Math.max(3,Math.round((Number(state._chanDays||30))/10)); }
    render();
  }));
  document.querySelectorAll('[data-chan-action]').forEach(el=>el.addEventListener('click',e=>{
    e.preventDefault();
    const a=el.dataset.chanAction;
    if(a==='clear'){ Object.keys(state._chanSel).forEach(k=>state._chanSel[k]=0); }
    if(a==='reset'){ state._chanSel=null; }
    render();
  }));
  const chanDaysEl=document.querySelector('[data-chan-days]');
  if(chanDaysEl) chanDaysEl.addEventListener('change',e=>{
    state._chanDays=Number(e.target.value);
    render();
  });

  // Brief edit field changes — keep state in sync without re-render (preserves cursor)
  document.querySelectorAll('[data-brief-field]').forEach(el=>el.addEventListener('input',e=>{
    if(state._briefEdit) state._briefEdit[el.dataset.briefField] = el.value;
  }));
  document.querySelectorAll('[data-post-field]').forEach(el=>el.addEventListener('input',e=>{
    if(state._postEdit){
      const k = el.dataset.postField;
      state._postEdit[k] = (k==='evi_score') ? Number(el.value) : el.value;
    }
  }));

  // Version restore handlers
  document.querySelectorAll('[data-action="restore-post-version"]').forEach(el=>el.addEventListener('click',e=>{
    e.stopPropagation();
    const idx=Number(el.dataset.versionIdx);
    restorePostVersion(idx);
  }));

  // Close download dropdown on outside click
  if(state._dlMenuOpen){
    setTimeout(()=>{
      const handler = (e)=>{
        if(!e.target.closest('.dl-wrap')){
          state._dlMenuOpen = false;
          document.removeEventListener('click', handler);
          render();
        }
      };
      document.addEventListener('click', handler);
    }, 0);
  }

  // All Posts table — sort header clicks
  document.querySelectorAll('[data-post-sort]').forEach(el=>el.addEventListener('click',e=>{
    e.preventDefault();
    state._postsFilter = state._postsFilter || {};
    const key = el.dataset.postSort;
    if(state._postsFilter.sortKey === key){
      state._postsFilter.sortDir = state._postsFilter.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state._postsFilter.sortKey = key;
      state._postsFilter.sortDir = 'asc';
    }
    render();
  }));

  // All Posts table — dropdown filter changes
  document.querySelectorAll('[data-post-filter]').forEach(el=>el.addEventListener('change',e=>{
    state._postsFilter = state._postsFilter || {};
    const key = el.dataset.postFilter;
    state._postsFilter[key] = el.value || null;
    render();
  }));

  // All Posts table — search box (debounced via input event)
  const searchEl = document.getElementById('posts-search');
  if(searchEl){
    searchEl.addEventListener('input', e=>{
      state._postsFilter = state._postsFilter || {};
      state._postsFilter.q = e.target.value;
      // Debounce by skipping render if user is still typing fast
      clearTimeout(window._postsSearchTimer);
      window._postsSearchTimer = setTimeout(()=>render(), 150);
    });
  }
}

function goto(view){
  state.view=view;
  if(view==='briefs'){ Store.listAllBriefs().then(b=>{ state.allBriefs=b; render(); }); return; }
  render();
}

async function setActiveBrand(id){ state.activeBrandId=id||null; state.activeCalendar=null; await loadBrandWorkspace(); }
async function loadBrandWorkspace(){ if(!state.activeBrandId){ render(); return; } const [cs,bs,t]=await Promise.all([Store.listCalendars(state.activeBrandId),Store.listBriefs(state.activeBrandId),Store.getTrends(state.activeBrandId)]); state.calendars=cs; state.briefs=bs; state.trends=t; if(!state.activeCalendar&&cs.length) state.activeCalendar=cs[0]; render(); }
function openModal(m){
  if(m?.kind==='view-brief' && m.data) m = {...m, data: normalizeBrief(m.data)};
  state.modal=m;
  render();
}
function closeModal(){
  state.modal=null;
  state._chanSel=null; state._chanDays=null;
  state._briefEdit=null; state._briefEditVariantId=null;
  state._briefShowRegenerated=false;
  state._postEdit=null; state._postShowHist=false;
  render();
}

async function handleAction(a){
  if(a==='new-brand') return openModal({kind:'brand-form',data:{}});
  if(a==='save-brand') return saveBrandFromForm();
  if(a==='generate-calendar') return openModal({kind:'generate-calendar'});
  if(a==='run-calendar') return runCalendar();
  if(a==='gen-briefs') return runAutoBriefs();
  if(a==='brief-from-post') return briefFromCurrentPost();
  if(a==='fetch-trends') return runFetchTrends();
  if(a==='toggle-download-menu'){ state._dlMenuOpen = !state._dlMenuOpen; render(); return; }
  if(a==='export-csv'){ state._dlMenuOpen=false; exportCSV(); return; }
  if(a==='export-md'){ state._dlMenuOpen=false; exportMarkdown(); return; }
  if(a==='export-xlsx'){ state._dlMenuOpen=false; exportXLSX(); return; }
  if(a==='export-pdf'){ state._dlMenuOpen=false; exportPDF(); return; }
  if(a==='clear-post-filters'){
    state._postsFilter = null;
    render();
    return;
  }
  if(a==='copy-brief') return copyBriefMarkdown();
  if(a==='retry-calendar'){ closeModal(); openModal({kind:'generate-calendar'}); return; }

  // Brief edit / save / regenerate
  if(a==='edit-brief'){
    const record = normalizeBrief(state.modal.data);
    const active = getActiveVariant(record);
    if(!active){ showToast('No active brief to edit','err'); return; }
    state._briefEditVariantId = record.activeVariantId;
    state._briefEdit = {...active};
    render();
    return;
  }
  if(a==='cancel-edit-brief'){ state._briefEdit = null; state._briefEditVariantId = null; render(); return; }
  if(a==='save-brief-edit') return saveBriefEdit();
  if(a==='regenerate-brief') return regenerateBrief();
  if(a==='toggle-regenerated-copies'){ state._briefShowRegenerated = !state._briefShowRegenerated; render(); return; }

  // Post edit / save / regenerate
  if(a==='edit-post'){ state._postEdit = {...state.modal.data}; render(); return; }
  if(a==='cancel-edit-post'){ state._postEdit = null; render(); return; }
  if(a==='save-post-edit') return savePostEdit();
  if(a==='regenerate-post') return regeneratePost();
  if(a==='toggle-post-history'){ state._postShowHist = !state._postShowHist; render(); return; }
  if(a==='restore-post-version'){ return; /* handled below */ }
  if(a==='save-partial'){
    const m=state.modal;
    if(!m||!m.calendarData) return;
    const cal={id:'cal_'+Date.now(),title:m.calendarData.title+' (partial)',startDate:m.calendarData.start,days:m.calendarData.days,focus:m.calendarData.focus,posts:m.calendarData.posts};
    try{
      await Store.saveCalendar(m.brandId,cal);
      state.calendars=await Store.listCalendars(m.brandId);
      state.activeCalendar=state.calendars.find(c=>c.id===cal.id)||state.calendars[0];
      closeModal();
      showToast(`Partial saved · ${cal.posts.length} posts`,'info');
    }catch(e){ showToast('Save failed: '+e.message,'err'); }
    return;
  }
  if(a==='confirm-yes') return state.modal?.onYes&&state.modal.onYes();
}

async function saveBrandFromForm(){
  const get=id=>document.getElementById(id)?.value?.trim()||'';
  const data={
    id:state.modal.data.id,
    name:get('f-name'), website_url:get('f-website_url'), vertical:get('f-vertical'),
    location:get('f-location'), business_model:get('f-business_model'), price_sensitivity_tier:get('f-price_sensitivity_tier'),
    purchase_cycle_length:get('f-purchase_cycle_length'), avg_transaction_value:get('f-avg_transaction_value'),
    time_horizon:get('f-time_horizon'),
    target_customer_profile:get('f-target_customer_profile'), growth_objective:get('f-growth_objective'),
    product_placement_context:get('f-product_placement_context'), brand_voice:get('f-brand_voice'),
  };
  if(!data.name){ showToast('Brand name is required','err'); return; }
  try{
    const saved=await Store.saveBrand(data);
    state.brands=await Store.listBrands();
    if(!state.activeBrandId) state.activeBrandId=saved.id;
    closeModal();
    showToast(data.id?'Brand updated':'Brand created','ok');
  }catch(e){
    showToast('Save failed: '+(e.message||e),'err');
    console.error('Brand save error:',e);
  }
}

async function runCalendar(){
  let brand, title, start, days, focus, channelMix;
  try {
    brand = state.brands.find(b=>b.id===state.activeBrandId);
    if(!brand){ showToast('No active brand selected','err'); return; }
    title = document.getElementById('g-title')?.value?.trim() || (brand.name+' '+monthName(new Date()));
    start = document.getElementById('g-start')?.value || todayISO();
    days = Number(document.getElementById('g-days')?.value || 30);
    focus = document.getElementById('g-focus')?.value?.trim() || '';
    // Read channel quotas from selector state
    channelMix = {};
    const sel = state._chanSel || {};
    for(const k of Object.keys(sel)){ if(Number(sel[k])>0) channelMix[k] = Number(sel[k]); }
    if(!Object.keys(channelMix).length){
      showToast('Select at least one channel with post quantity > 0','err');
      return;
    }
  } catch(e){
    showToast('Form read error: '+e.message,'err');
    console.error('Form error:',e);
    return;
  }

  closeModal();

  // Build batches — each batch is a date range with proportional channel quotas
  const totalPosts = Object.values(channelMix).reduce((s,v)=>s+v,0);
  const chunkSize=6;
  const chunks=[];
  for(let i=0;i<days;i+=chunkSize){
    const sd=new Date(start); sd.setDate(sd.getDate()+i);
    const length = Math.min(chunkSize,days-i);
    // Proportionally allocate channel posts to this batch
    const ratio = length/days;
    const batchMix = {};
    let allocated = 0;
    for(const [k,v] of Object.entries(channelMix)){
      const a = Math.round(v*ratio);
      batchMix[k] = a;
      allocated += a;
    }
    chunks.push({
      startDay:i+1,
      endDay:Math.min(i+chunkSize,days),
      startDate:sd.toISOString().slice(0,10),
      length,
      mix: batchMix,
      total: allocated
    });
  }
  // Reconcile rounding errors so total matches exactly
  let runningTotal = chunks.reduce((s,c)=>s+c.total,0);
  let diff = totalPosts - runningTotal;
  // Distribute diff to last chunks, by largest channel first
  while(diff !== 0 && chunks.length){
    const last = chunks[chunks.length-1];
    const channels = Object.keys(channelMix).sort((a,b)=>channelMix[b]-channelMix[a]);
    for(const c of channels){
      if(diff > 0){ last.mix[c]=(last.mix[c]||0)+1; last.total++; diff--; }
      else if(diff < 0 && (last.mix[c]||0)>0){ last.mix[c]--; last.total--; diff++; }
      if(diff===0) break;
    }
    if(diff!==0) break; // safety
  }

  const log = [];
  const setLoading = (body) => {
    state.modal = {kind:'loading', title:'Generating calendar…', body, log: [...log]};
    render();
  };
  setLoading(`Preparing ${chunks.length} batches · ${totalPosts} posts across ${Object.keys(channelMix).length} channels…`);

  const allPosts=[];
  let chunkIdx=0;
  for(const ch of chunks){
    chunkIdx++;
    if(ch.total===0){ log.push(`▸ Batch ${chunkIdx}/${chunks.length} skipped (0 posts allocated)`); continue; }
    const mixDesc = Object.entries(ch.mix).filter(([_,v])=>v>0).map(([k,v])=>`${k}:${v}`).join(' · ');
    log.push(`▸ Batch ${chunkIdx}/${chunks.length} · ${ch.total} posts · ${mixDesc}`);
    setLoading(`Batch ${chunkIdx} of ${chunks.length} · ${ch.total} posts · days ${ch.startDay}–${ch.endDay}`);
    const prompt=buildCalendarPrompt(brand,{
      title,start:ch.startDate,days:ch.length,focus,
      batchInfo:`Batch ${chunkIdx} of ${chunks.length} (overall day ${ch.startDay}-${ch.endDay} of ${days})`,
      totalDays:days,
      channelMix: ch.mix,
      batchTotal: ch.total
    });
    try{
      const json=await callClaudeJSON(prompt,{max_tokens:16000});
      let posts;
      if(Array.isArray(json)) posts = json;
      else if(json.posts && Array.isArray(json.posts)) posts = json.posts;
      else if(json.calendar && Array.isArray(json.calendar)) posts = json.calendar;
      else if(json.content && Array.isArray(json.content)) posts = json.content;
      else {
        // Maybe model returned a single post object — wrap it
        if(json.date && json.platform) posts = [json];
        else throw new Error('No posts array found. Got keys: '+Object.keys(json||{}).join(', '));
      }
      if(!posts.length) throw new Error('Empty post array returned by model');
      log[log.length-1] = `✓ Batch ${chunkIdx}/${chunks.length} — ${posts.length} posts`;
      allPosts.push(...posts);
    }catch(e){
      const errMsg = e.message || String(e);
      log[log.length-1] = `✗ Batch ${chunkIdx}/${chunks.length} FAILED — ${errMsg}`;
      console.error('Calendar batch error:',e);
      // Show error modal with details (don't auto-close)
      state.modal = {kind:'error', title:`Batch ${chunkIdx} failed`, body:errMsg, log:[...log], canRetry:true, partial:allPosts.length, brandId:brand.id, calendarData:{title,start,days,focus,posts:allPosts}};
      render();
      return;
    }
  }

  log.push(`▸ Saving calendar with ${allPosts.length} posts…`);
  setLoading('Saving…');

  const cal={id:'cal_'+Date.now(),title,startDate:start,days,focus,posts:allPosts};
  try{
    await Store.saveCalendar(brand.id,cal);
    state.calendars=await Store.listCalendars(brand.id);
    state.activeCalendar=state.calendars.find(c=>c.id===cal.id)||state.calendars[0];
    closeModal();
    showToast(`Calendar generated · ${allPosts.length} posts`,'ok');
  }catch(e){
    state.modal = {kind:'error', title:'Save failed', body:e.message, log:[...log,`✗ Save error: ${e.message}`]};
    render();
  }
}

function buildCalendarPrompt(brand,opts){
  const funnelRatio = brand.business_model === 'B2C' ? '45/30/25' : (brand.business_model === 'B2G' ? '50/35/15' : '40/35/25');
  const mix = opts.channelMix || {};
  const mixLines = Object.entries(mix).filter(([_,v])=>v>0).map(([k,v])=>`  - ${k}: EXACTLY ${v} posts`).join('\n');
  const totalRequired = opts.batchTotal || Object.values(mix).reduce((s,v)=>s+v,0);

  return `# ROLE
You are a McKinsey Senior Partner & Global Lead of Social Media Content Strategy. Your deliverables combine customer-centric strategy, vertical economics, hyper-local intelligence, advanced virality/sentiment analytics, and funnel architecture. They must withstand CMO scrutiny, creative director validation, platform algorithm realities, and procurement/compliance standards.

# TASK
${opts.batchInfo?`THIS IS ${opts.batchInfo}. Generate posts ONLY for this ${opts.days}-day window of the larger ${opts.totalDays}-day plan.`:`Generate a ${opts.days}-day funnel-mapped, EVI-scored content calendar.`}

# BRAND BRIEF
- Name: ${brand.name}
- Website: ${brand.website_url||'-'}
- Vertical: ${brand.vertical||'-'}
- Location: ${brand.location||'-'}
- Business Model: ${brand.business_model||'B2C'}
- Price Tier: ${brand.price_sensitivity_tier||'Mid-Market'}
- Purchase Cycle: ${brand.purchase_cycle_length||'-'}
- AOV/ACV: ${brand.avg_transaction_value||'-'}
- Customer Profile: ${brand.target_customer_profile||'-'}
- Growth Objective: ${brand.growth_objective||'-'}
- Product Context: ${brand.product_placement_context||'Lead Gen'}
- Brand Voice: ${brand.brand_voice||'professional, on-brand'}
- Start Date: ${opts.start}
- Calendar Title: ${opts.title}
${opts.focus?`- Special Focus: ${opts.focus}`:''}

# CHANNEL QUOTAS (MANDATORY — exact counts)
This batch must produce EXACTLY ${totalRequired} total posts, distributed precisely:
${mixLines}

These counts are non-negotiable. Each channel produces exactly the number specified. Do not add posts for channels not listed.

# STRATEGY FRAMEWORK (from McKinsey Senior Partner Edition v2.0)

## A. Funnel Distribution (strict ratio for ${brand.business_model||'B2C'})
- TOFU (Awareness): ${funnelRatio.split('/')[0]}% — Reach, Saves, Shares, Profile Visits
- MOFU (Consideration): ${funnelRatio.split('/')[1]}% — Engagement Rate, Dwell Time, Link Clicks
- BOFU (Conversion): ${funnelRatio.split('/')[2]}% — CTR, Conversion Rate, Lead Volume

Apply this ratio across the channel mix above.

## B. Platform-Specific Posting Behavior
- Instagram: Reels for TOFU, Carousels for MOFU/Educate, Stories for BOFU/Urgency
- LinkedIn: Document Post / Carousel for MOFU/Educate, Long-form text for thought leadership, Video for BOFU/Social Proof
- TikTok: Native vertical Reel format, hook in first 1.5s, trending audio + on-screen text
- YouTube: Long-form for thought leadership; Shorts for TOFU teasers
- Facebook: Reels + native video, community-tone copy
- X: Threads for Data-Driven hooks, single posts for Pattern Interrupt
- Threads: Conversational long-text, replies-driven, lighter B2C/D2C tone

## C. Intent Classification (every post tagged)
- Educate: How-to, frameworks, data insights → Saves, Watch Time
- Entertain: Humor, storytelling, trends → Rewatch Rate, Shares
- Validate: Proof, testimonials, case studies → Comments, Saves
- Inspire: Vision, transformation, values → Shares, Follows
- Convert: Offer, demo, booking, purchase → CTR, Form Submissions

## D. Hook Architecture Matrix
- Pattern Interrupt ("Stop X. Do Y."): TOFU/Educate → TikTok, Reels, Shorts
- Curiosity Gap ("The #1 mistake 83% of [role] make..."): TOFU/Inspire → LinkedIn, X, IG
- Pain-Agitate-Solve: MOFU/Validate → LinkedIn, YouTube
- Data-Driven ("We analyzed 10K campaigns. Result..."): MOFU/Educate → All
- Social Proof ("How [client] achieved [result]"): BOFU/Convert → LinkedIn, IG, YT
- Urgency/Scarcity ("Only 48 hours left..."): BOFU/Convert → Stories, TikTok, FB

## E. EVI Scoring (Engagement Velocity Index, 0-10)
EVI = (Hook Strength + Emotional Resonance + Shareability + Platform Fit) / 4
- Hook Strength: 9-10 stops scroll; +0.5 for specific number; +0.5 platform-native; -1.0 if >7 words for video
- Emotional Resonance: 9-10 identity/transformation; 7-8 curiosity/aspiration/FOMO
- Shareability: 9-10 universal pain or belief validation
- Platform Fit: how well format matches platform native behavior
Target EVI ≥ 7.0 for priority pieces.

# OUTPUT REQUIREMENTS

Return a JSON object with this exact structure:
{
  "posts": [
    {
      "date": "YYYY-MM-DD (incrementing from ${opts.start} within this batch's date range)",
      "day": "Mon|Tue|Wed|Thu|Fri|Sat|Sun",
      "platform": "must be one of the channels in the quota above",
      "funnel_stage": "TOFU|MOFU|BOFU",
      "intent": "Educate|Entertain|Validate|Inspire|Convert",
      "hook_type": "Pattern Interrupt|Curiosity Gap|Pain-Agitate-Solve|Data-Driven|Social Proof|Urgency/Scarcity",
      "content_id": "YYYYMMDD_PLAT_NN (codes: IG/LI/TT/YT/FB/X/TH for Threads)",
      "format": "Reel|Carousel|Static|Story|Short|Long-form Video|Thread|Live|Document Post",
      "hook": "production-ready 8-15 word headline, specific to ${brand.name}",
      "caption_preview": "2-3 line caption max 220 chars, fold-optimized first line",
      "creative_direction": "concrete shot/slide/layout direction max 200 chars",
      "visual_specs": "style + color + dimensions max 120 chars",
      "cta": "exact CTA text",
      "tracking_url": "https://${brand.website_url||'example.com'}/?utm_source=PLAT&utm_medium=FORMAT&utm_campaign=${slug(opts.title)}_FUNNEL",
      "segment": "which audience segment",
      "evi_score": 7.5,
      "sentiment": "Curious|Authoritative|Playful|Empathetic|Urgent|Inspiring",
      "status": "Draft"
    }
  ]
}

# CRITICAL RULES
1. The "posts" array MUST contain EXACTLY ${totalRequired} posts (verify count before responding)
2. Each platform's count MUST match the quota above exactly
3. Every hook is production-grade — no placeholders like "[your topic]"
4. Caption_preview first line is the hook truncated for fold preview
5. JSON must be syntactically valid: escape internal quotes with \\", escape newlines with \\n
6. No trailing commas. No markdown code fences. Start response with { and end with }`;
}

async function runAutoBriefs(){
  if(!state.activeCalendar) return;
  const top=[...state.activeCalendar.posts].sort((a,b)=>(b.evi_score||0)-(a.evi_score||0)).slice(0,4);
  closeModal(); openModal({kind:'loading',title:'Generating creative briefs…',body:`Building 4 production-grade briefs for top-EVI posts.`});
  try{
    let made=0;
    for(const p of top){
      const brief=await generateBriefForPost(p);
      const hadBrief = !!findBriefForPost(p);
      await addBriefVariantForPost(state.activeBrandId, p, brief, 'generated', { activate: !hadBrief });
      made++;
    }
    state.briefs=await Store.listBriefs(state.activeBrandId);
    state.allBriefs=await Store.listAllBriefs();
    closeModal(); showToast(`${made} briefs generated`,'ok');
  }catch(e){ closeModal(); showToast('Brief generation failed: '+e.message,'err'); }
}

async function briefFromPost(post, opts={}){
  if(!post||!state.activeBrandId) return;
  const stayOnCalendar=!!opts.stayOnCalendar;
  if(!stayOnCalendar) closeModal();
  openModal({kind:'loading',title:'Generating brief…',body:'Building a McKinsey-grade creative brief from this post.'});
  try{
    const brief=await generateBriefForPost(post);
    brief.content_id=brief.content_id||post.content_id||'';
    const hadBrief = !!findBriefForPost(post);
    const saved = await addBriefVariantForPost(state.activeBrandId, post, brief, 'generated', { activate: !hadBrief });
    closeModal();
    if(stayOnCalendar){
      render();
      showToast(hadBrief ? 'New brief copy saved — Set as active in View Brief' : 'Brief generated and set as active','ok');
    }else{
      openModal({kind:'view-brief',data:saved});
      showToast(hadBrief ? 'New copy added — choose Set as active below' : 'Brief generated','ok');
    }
  }catch(e){ closeModal(); showToast('Failed: '+e.message,'err'); if(stayOnCalendar) render(); }
}

async function briefFromCurrentPost(){
  const stayOnCalendar=!!state.modal?.briefFlow;
  return briefFromPost(state.modal.data, {stayOnCalendar});
}

async function generateBriefForPost(post){
  const brand=state.brands.find(b=>b.id===state.activeBrandId);
  const prompt=`Generate a CMO-ready creative brief.

BRAND: ${brand.name} | ${brand.vertical||''} | ${brand.business_model||''} | ${brand.location||''}
TARGET: ${brand.target_customer_profile||''}

POST:
- Content ID: ${post.content_id||''}
- Date: ${post.date||''}
- Platform: ${post.platform||''}
- Format: ${post.format||''}
- Funnel: ${post.funnel_stage||''}
- Intent: ${post.intent||''}
- Hook Type: ${post.hook_type||''}
- Hook: ${post.hook||''}
- Caption: ${post.caption_preview||''}
- CTA: ${post.cta||''}
- EVI: ${post.evi_score||''}

Return JSON with these EXACT keys (all strings except evi_score, funnel_stage, platform, format which mirror input):
- content_id, platform, format, funnel_stage, evi_score
- hook (the headline)
- objective (one sentence — what this piece must achieve)
- target_audience (who sees this + their mindset at this funnel moment)
- core_message (the 1 thing they walk away believing/feeling)
- script_copy (for video: shot-by-shot with timing; for carousel: slide-by-slide; for static: headline+body+CTA. Be detailed.)
- visual_direction (style, color hex if relevant, text overlays font/size/position, b-roll, talent direction)
- audio_direction (music genre+tempo+licensing source, voice tone+speed, SFX)
- technical_specs (dimensions like 1080x1920, format MP4/JPG, max file size, captions WCAG-compliant burned-in)
- cta_block (primary CTA text + secondary engagement prompt + destination URL with UTM)
- compliance (disclosures required, claims verified, brand guidelines, accessibility)`;
  const json=await callClaudeJSON(prompt,{max_tokens:4096});
  return {
    content_id:post.content_id,platform:post.platform,format:post.format,funnel_stage:post.funnel_stage,
    evi_score:post.evi_score,hook:json.hook||post.hook,
    objective:json.objective,target_audience:json.target_audience,core_message:json.core_message,
    script_copy:json.script_copy,visual_direction:json.visual_direction,audio_direction:json.audio_direction,
    technical_specs:json.technical_specs,cta_block:json.cta_block,compliance:json.compliance,
  };
}

/* ===== BRIEF VARIANTS (save / regenerate / set active) ===== */
async function refreshBriefsState(brandId){
  state.briefs = await Store.listBriefs(brandId);
  state.allBriefs = await Store.listAllBriefs();
}

async function persistBriefRecord(brandId, record){
  const updated = normalizeBrief({ ...record, isActive: true });
  const active = getActiveVariant(updated);
  if(active) syncBriefRecordFromVariant(updated, active);
  await Store.saveBrief(brandId, updated);
  await refreshBriefsState(brandId);
  return updated;
}

async function addBriefVariantForPost(brandId, post, content, source, { activate = false } = {}){
  const contentId = content.content_id || post?.content_id || '';
  const lookup = post || { content_id: contentId, platform: content.platform, hook: content.hook, format: content.format, funnel_stage: content.funnel_stage };
  let record = findBriefForPost(lookup);
  const variant = {
    id: newVariantId(),
    ...extractBriefContent(content),
    savedAt: Date.now(),
    source,
  };
  if(record){
    record = normalizeBrief(record);
    record = {
      ...record,
      variants: [...record.variants, variant],
      activeVariantId: activate ? variant.id : record.activeVariantId,
      savedAt: Date.now(),
      isActive: true,
    };
  }else{
    record = {
      ...extractBriefContent(content),
      brandId,
      content_id: contentId,
      variants: [variant],
      activeVariantId: variant.id,
      createdAt: Date.now(),
      savedAt: Date.now(),
      isActive: true,
    };
  }
  return persistBriefRecord(brandId, record);
}

async function setBriefVariantActive(variantId){
  const current = normalizeBrief(state.modal.data);
  const variant = current.variants?.find(v=>v.id === variantId);
  if(!variant){ showToast('Brief copy not found','err'); return; }
  const updated = {
    ...current,
    activeVariantId: variantId,
    savedAt: Date.now(),
    isActive: true,
  };
  syncBriefRecordFromVariant(updated, variant);
  try{
    const saved = await persistBriefRecord(current.brandId, updated);
    state._briefEdit = null;
    state.modal = { kind:'view-brief', data: saved };
    render();
    showToast('Active brief updated · exports will use this copy','ok');
  }catch(e){ showToast('Could not set active: '+e.message,'err'); }
}

async function saveBriefEdit(){
  const current = normalizeBrief(state.modal.data);
  const edited = state._briefEdit;
  if(!current || !edited) return;
  const editId = state._briefEditVariantId || current.activeVariantId;
  const variants = current.variants.map(v=>{
    if(v.id !== editId) return v;
    return {
      ...v,
      ...extractBriefContent(edited),
      savedAt: Date.now(),
    };
  });
  const updated = {
    ...current,
    variants,
    activeVariantId: editId,
    createdAt: current.createdAt,
    savedAt: Date.now(),
  };
  syncBriefRecordFromVariant(updated, getActiveVariant(updated));
  try{
    const saved = await persistBriefRecord(current.brandId, updated);
    state._briefEdit = null;
    state._briefEditVariantId = null;
    state.modal = { kind:'view-brief', data: saved };
    render();
    showToast('Brief saved — same copy updated','ok');
  }catch(e){ showToast('Save failed: '+e.message,'err'); console.error(e); }
}

async function regenerateBrief(){
  const current = normalizeBrief(state.modal.data);
  if(!current) return;
  const brand = state.brands.find(b=>b.id===current.brandId);
  if(!brand){ showToast('Source brand not found','err'); return; }
  const brandId = current.brandId;
  const sourcePost = {
    content_id: current.content_id, platform: current.platform, format: current.format,
    funnel_stage: current.funnel_stage, intent: current.intent || '', hook_type: current.hook_type || '',
    hook: current.hook, caption_preview: current.caption_preview || current.hook,
    cta: current.cta_block || '', evi_score: current.evi_score, date: current.date || '',
  };
  closeModal();
  openModal({kind:'loading',title:'Regenerating brief…',body:'Building a fresh copy — your current active brief stays until you switch.',log:[]});
  try{
    const prevActive = state.activeBrandId;
    state.activeBrandId = brandId;
    const fresh = await generateBriefForPost(sourcePost);
    state.activeBrandId = prevActive;
    const saved = await addBriefVariantForPost(brandId, sourcePost, fresh, 'regenerated', { activate: false });
    state._briefEdit = null;
    closeModal();
    state.modal = { kind:'view-brief', data: saved };
    render();
    showToast('New brief copy added — Set as active to use it','ok');
  }catch(e){
    closeModal();
    showToast('Regenerate failed: '+e.message,'err');
    console.error(e);
  }
}

/* ===== POST EDIT / SAVE / REGENERATE / RESTORE ===== */
async function savePostEdit(){
  const current = state.modal.data;
  const edited = state._postEdit;
  if(!current || !edited || !state.activeCalendar){ return; }
  const cal = state.activeCalendar;
  const idx = cal.posts.findIndex(p=>p===current || (p.content_id && p.content_id===current.content_id));
  if(idx === -1){ showToast('Post not found in calendar','err'); return; }
  const versions = current.versions ? [...current.versions] : [];
  const snapshot = {...current}; delete snapshot.versions;
  snapshot.savedAt = current.savedAt || Date.now();
  snapshot.regenerated = false;
  versions.unshift(snapshot);
  const updated = {...current, ...edited, versions, savedAt: Date.now()};
  cal.posts[idx] = updated;
  try{
    await Store.saveCalendar(cal.brandId, cal);
    state.calendars = await Store.listCalendars(cal.brandId);
    state.activeCalendar = state.calendars.find(c=>c.id===cal.id) || cal;
    state._postEdit = null;
    state.modal = {kind:'post-detail', data: updated};
    render();
    showToast('Post saved · v'+(versions.length+1),'ok');
  }catch(e){ showToast('Save failed: '+e.message,'err'); console.error(e); }
}

async function regeneratePost(){
  const current = state.modal.data;
  if(!current || !state.activeCalendar){ return; }
  const cal = state.activeCalendar;
  const brand = state.brands.find(b=>b.id===cal.brandId);
  if(!brand){ showToast('Brand not found','err'); return; }
  openModal({kind:'loading',title:'Regenerating post…',body:'Building a fresh version with the same brand + funnel context.',log:[]});
  try{
    const prompt = `You are a McKinsey Senior Partner of Social Media Content Strategy. Regenerate a single content post.

BRAND: ${brand.name} | ${brand.vertical||''} | ${brand.business_model||''} | ${brand.location||''}
TARGET: ${brand.target_customer_profile||''}
BRAND VOICE: ${brand.brand_voice||''}

KEEP THESE LOCKED:
- Date: ${current.date}
- Platform: ${current.platform}
- Format: ${current.format}
- Funnel Stage: ${current.funnel_stage}
- Content ID: ${current.content_id}

EXPLORE A FRESH ANGLE for these (do not repeat the previous version's angle):
PREVIOUS HOOK: "${current.hook||''}"
PREVIOUS CAPTION: "${current.caption_preview||''}"

Return JSON with these EXACT keys:
hook, caption_preview, intent, hook_type, creative_direction, visual_specs, cta, segment, evi_score, sentiment, status

Be specific, on-brand, production-ready.`;
    const json = await callClaudeJSON(prompt, {max_tokens: 2000});
    // Snapshot
    const versions = current.versions ? [...current.versions] : [];
    const snapshot = {...current}; delete snapshot.versions;
    snapshot.savedAt = current.savedAt || Date.now();
    snapshot.regenerated = false;
    versions.unshift(snapshot);
    const updated = {
      ...current,
      hook: json.hook || current.hook,
      caption_preview: json.caption_preview || current.caption_preview,
      intent: json.intent || current.intent,
      hook_type: json.hook_type || current.hook_type,
      creative_direction: json.creative_direction || current.creative_direction,
      visual_specs: json.visual_specs || current.visual_specs,
      cta: json.cta || current.cta,
      segment: json.segment || current.segment,
      evi_score: typeof json.evi_score === 'number' ? json.evi_score : current.evi_score,
      sentiment: json.sentiment || current.sentiment,
      status: json.status || current.status,
      versions, savedAt: Date.now(), regenerated: true
    };
    const idx = cal.posts.findIndex(p=>p===current || (p.content_id && p.content_id===current.content_id));
    if(idx !== -1) cal.posts[idx] = updated;
    await Store.saveCalendar(cal.brandId, cal);
    state.calendars = await Store.listCalendars(cal.brandId);
    state.activeCalendar = state.calendars.find(c=>c.id===cal.id) || cal;
    closeModal();
    state.modal = {kind:'post-detail', data: updated};
    render();
    showToast('Post regenerated · v'+(versions.length+1),'ok');
  }catch(e){
    closeModal();
    showToast('Regenerate failed: '+e.message,'err');
    console.error(e);
  }
}

async function restorePostVersion(idx){
  const current = state.modal.data;
  if(!current || !current.versions || !current.versions[idx] || !state.activeCalendar) return;
  const target = current.versions[idx];
  const cal = state.activeCalendar;
  const versions = [...current.versions];
  const snapshot = {...current}; delete snapshot.versions;
  snapshot.savedAt = current.savedAt || Date.now();
  versions.unshift(snapshot);
  versions.splice(idx+1, 1);
  const restored = {...target, versions, savedAt: Date.now()};
  const pi = cal.posts.findIndex(p=>p===current || (p.content_id && p.content_id===current.content_id));
  if(pi !== -1) cal.posts[pi] = restored;
  try{
    await Store.saveCalendar(cal.brandId, cal);
    state.calendars = await Store.listCalendars(cal.brandId);
    state.activeCalendar = state.calendars.find(c=>c.id===cal.id) || cal;
    state.modal = {kind:'post-detail', data: restored};
    render();
    showToast('Restored to that version','ok');
  }catch(e){ showToast('Restore failed: '+e.message,'err'); }
}

function closeModalKeepEdits(keep){ /* placeholder for future side-by-side flows */ }

async function runFetchTrends(){
  const brand=state.brands.find(b=>b.id===state.activeBrandId); if(!brand) return;
  openModal({kind:'loading',title:'Running live web search…',body:`Pulling latest signals on ${brand.vertical||'industry'}. ~30-60s.`});
  const prompt=`You are a senior strategy partner. Use web search to research the latest trends, consumer shifts, and competitor moves in this industry, then build content strategy intelligence for the brand.

BRAND: ${brand.name}
VERTICAL: ${brand.vertical||'-'}
LOCATION: ${brand.location||'-'}
BUSINESS MODEL: ${brand.business_model||'-'}
TARGET CUSTOMER: ${brand.target_customer_profile||'-'}

Search the web for:
1. Latest 2025-2026 trends in ${brand.vertical||'this industry'}
2. Consumer behavior shifts in ${brand.location||'this market'}
3. What top competitors in ${brand.vertical||'this category'} are doing on social
4. Emerging content formats and platforms

Return JSON:
{
  "executive_summary": "2-3 sentence partner-level synthesis",
  "emerging_trends": [{"title":"", "detail":"", "source":""}, ... 4-6 items],
  "consumer_shifts": [{"title":"", "detail":"", "source":""}, ... 3-5 items],
  "competitor_moves": [{"title":"", "detail":"", "source":""}, ... 3-5 items],
  "content_opportunities": [{"title":"", "detail":""}, ... 4-6 items, content-specific actions],
  "thought_leadership_angles": [{"angle":"", "rationale":"", "platforms":["LinkedIn","YouTube"]}, ... 5-7 items SPECIFIC to ${brand.name}],
  "sources": ["url1","url2",...]
}`;
  try{
    const txt=await callClaude(prompt,{webSearch:true,max_tokens:8192});
    const json=tolerantJSONParse(txt);
    await Store.saveTrends(brand.id,json);
    state.trends=await Store.getTrends(brand.id);
    closeModal(); showToast('Industry intel refreshed','ok');
  }catch(e){ closeModal(); showToast('Fetch failed: '+e.message,'err'); console.error('Trends error:',e); }
}

// Get the same filtered+sorted post set the user sees in the All Posts table
function getExportPosts(){
  const c = state.activeCalendar;
  if(!c) return {posts:[], calendar:null};
  // Strip the synthetic _idx field added by applyPostFilters
  const filtered = applyPostFilters(c.posts).map(p=>{ const {_idx, ...rest} = p; return rest; });
  return {posts: filtered, calendar: c};
}

// Same columns as PDF report (CSV, MD, XLSX, PDF)
const REPORT_EXPORT_COLS = [
  {key:'date', label:'Date'},
  {key:'day', label:'Day'},
  {key:'platform', label:'Platform'},
  {key:'funnel_stage', label:'Stage'},
  {key:'hook_headline', label:'Hook / Headline'},
  {key:'format', label:'Format'},
  {key:'intent', label:'Intent'},
  {key:'evi_score', label:'EVI'},
  {key:'cta', label:'CTA'},
  {key:'hook_type', label:'Hook Type'},
  {key:'brief_script_copy', label:'Brief Script / Copy'},
];

/** Caption fold line often repeats hook — split so exports show hook once, then rest of caption. */
function splitHookHeadline(hook, caption){
  const h = String(hook||'').trim();
  const c = String(caption||'').trim();
  if(!h && !c) return { hook:'', caption:'' };
  if(!c) return { hook:h, caption:'' };
  if(!h) return { hook:'', caption:c };
  if(c === h) return { hook:h, caption:'' };
  const lines = c.split(/\r?\n/);
  const first = lines[0].trim();
  const norm = (s)=>s.replace(/\s+/g,' ').toLowerCase();
  if(norm(first) === norm(h)) {
    const rest = lines.slice(1).join('\n').trim();
    return { hook:h, caption:rest };
  }
  if(c.startsWith(h)) {
    let rest = c.slice(h.length).replace(/^[\s.:;,\-–—]+/, '').trim();
    if(!rest) return { hook:h, caption:'' };
    const restLines = rest.split(/\r?\n/);
    if(norm(restLines[0].trim()) === norm(h)) rest = restLines.slice(1).join('\n').trim();
    return { hook:h, caption:rest };
  }
  return { hook:h, caption:c };
}

function formatHookHeadlinePlain(hook, caption){
  const { hook:h, caption:rest } = splitHookHeadline(hook, caption);
  if(!h) return rest;
  if(!rest) return h;
  return `${h}\n${rest}`;
}

function enrichPostsForExport(posts){
  return posts.map(p=>{
    const brief = getActiveBriefForPost(p);
    const row = {...p};
    const parts = splitHookHeadline(p.hook, p.caption_preview);
    row.export_hook = parts.hook;
    row.export_caption = parts.caption;
    row.hook_headline = formatHookHeadlinePlain(p.hook, p.caption_preview);
    row.brief_script_copy = brief ? (brief.script_copy ?? '') : '';
    return row;
  });
}

function exportCellValue(row, col){
  let v = row[col.key];
  if(v == null) return '';
  if(col.key === 'evi_score' && typeof v === 'number') return v.toFixed(1);
  if(typeof v === 'number') return v;
  return String(v);
}

function exportRowsToAoa(rows){
  const header = REPORT_EXPORT_COLS.map(c=>c.label);
  const body = rows.map(p=>REPORT_EXPORT_COLS.map(c=>exportCellValue(p, c)));
  return [header, ...body];
}

function briefToMarkdown(brief){
  return `**Platform:** ${brief.platform||''} | **Format:** ${brief.format||''} | **Funnel:** ${brief.funnel_stage||''} | **EVI:** ${brief.evi_score ?? ''}\n\n## Hook\n${brief.hook||''}\n\n## Objective\n${brief.objective||''}\n\n## Target Audience\n${brief.target_audience||''}\n\n## Core Message\n${brief.core_message||''}\n\n## Script / Copy\n${brief.script_copy||''}\n\n## Visual Direction\n${brief.visual_direction||''}\n\n## Audio Direction\n${brief.audio_direction||''}\n\n## Technical Specs\n${brief.technical_specs||''}\n\n## CTA\n${brief.cta_block||''}\n\n## Compliance\n${brief.compliance||''}\n`;
}

function requireExportData(){
  const {posts, calendar} = getExportPosts();
  if(!calendar){ showToast('No calendar selected','err'); return null; }
  if(!posts.length){ showToast('No posts to export (filters may be hiding them)','err'); return null; }
  return {posts, calendar};
}

function exportFilename(calendar, posts, ext){
  return `${slug(calendar.title)}_${posts.length}posts.${ext}`;
}

function buildCSVContent(posts){
  const rows = enrichPostsForExport(posts);
  const header = REPORT_EXPORT_COLS.map(c=>c.label).join(',');
  const body = rows.map(p=>REPORT_EXPORT_COLS.map(c=>{
    let v = exportCellValue(p, c);
    if(typeof v === 'number') v = String(v);
    v = String(v||'').replace(/"/g,'""');
    return `"${v}"`;
  }).join(','));
  return '\ufeff' + [header, ...body].join('\n');
}

function mdColumnWidth(col){
  const px = {
    date: 96, day: 72, platform: 100, funnel_stage: 78, hook_headline: 340, format: 110, intent: 140,
    evi_score: 56, cta: 220, hook_type: 120, brief_script_copy: 420,
  };
  return px[col.key] || 150;
}

function mdEscapeHtml(s){
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function mdHookHeadlineHtml(row){
  const h = row.export_hook ?? '';
  const c = row.export_caption ?? '';
  if(!h && !c) return '';
  if(h && c) return `<strong>${mdEscapeHtml(h)}</strong><br/>${mdEscapeHtml(c).replace(/\r?\n/g,'<br/>')}`;
  if(h) return `<strong>${mdEscapeHtml(h)}</strong>`;
  return mdEscapeHtml(c).replace(/\r?\n/g,'<br/>');
}

function mdExportCellHtml(row, col){
  if(col.key === 'hook_headline') return mdHookHeadlineHtml(row);
  const v = exportCellValue(row, col);
  const s = v == null ? '' : (typeof v === 'number' ? String(v) : String(v));
  return mdEscapeHtml(s).replace(/\r?\n/g,'<br/>');
}

function buildMarkdownContent(posts, calendar){
  const rows = enrichPostsForExport(posts);
  const briefCount = rows.filter(p=>String(p.brief_script_copy||'').trim()).length;
  const colgroup = REPORT_EXPORT_COLS.map(c=>
    `<col style="min-width:${mdColumnWidth(c)}px;width:${mdColumnWidth(c)}px"/>`
  ).join('\n    ');
  const thead = `<tr>${REPORT_EXPORT_COLS.map(c=>`<th>${mdEscapeHtml(c.label)}</th>`).join('')}</tr>`;
  const tbody = rows.map(p=>`<tr>${REPORT_EXPORT_COLS.map(c=>`<td>${mdExportCellHtml(p,c)}</td>`).join('')}</tr>`).join('\n    ');
  return `# ${calendar.title}

_${posts.length} posts · ${briefCount} with brief script · exported ${new Date().toLocaleString()}_

<!-- Same columns as PDF / CSV / XLSX. Scroll horizontally if needed. -->

<div class="export-table-wrap">

<style>
  .export-table-wrap { overflow-x: auto; max-width: 100%; margin: 1em 0; }
  .export-table-wrap table { border-collapse: collapse; table-layout: fixed; width: max-content; min-width: 100%; font-size: 13px; line-height: 1.45; }
  .export-table-wrap th { background: #1f2937; color: #fff; padding: 8px 10px; text-align: left; font-weight: 600; vertical-align: bottom; white-space: normal; }
  .export-table-wrap td { border: 1px solid #e5e7eb; padding: 8px 10px; vertical-align: top; word-wrap: break-word; overflow-wrap: anywhere; white-space: pre-wrap; }
  .export-table-wrap tr:nth-child(even) td { background: #f8fafc; }
  .export-table-wrap td strong { font-weight: 700; color: #111827; }
</style>

<table>
  <colgroup>
    ${colgroup}
  </colgroup>
  <thead>
    ${thead}
  </thead>
  <tbody>
    ${tbody}
  </tbody>
</table>

</div>
`;
}

function buildXLSXWorkbook(posts, calendar){
  const rows = enrichPostsForExport(posts);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(exportRowsToAoa(rows));
  const widths = REPORT_EXPORT_COLS.map(c=>{
    if(c.key==='hook_headline' || c.key==='brief_script_copy') return {wch:55};
    if(c.key==='cta') return {wch:32};
    if(c.key==='date') return {wch:11};
    if(c.key==='day' || c.key==='evi_score') return {wch:10};
    return {wch:18};
  });
  ws['!cols'] = widths;
  ws['!freeze'] = {xSplit:0, ySplit:1};
  XLSX.utils.book_append_sheet(wb, ws, 'Posts');
  return wb;
}

function buildPDFReportHtml(posts, calendar){
  const rows = enrichPostsForExport(posts);
  const brand = state.brands.find(b=>b.id===calendar.brandId);
  const totalEvi = rows.reduce((s,p)=>s+(p.evi_score||0),0);
  const avgEvi = rows.length ? (totalEvi/rows.length).toFixed(2) : '0';
  const dist = {TOFU:0,MOFU:0,BOFU:0};
  rows.forEach(p=>{ if(dist[p.funnel_stage]!==undefined) dist[p.funnel_stage]++; });
  const stageColor = (s)=>({TOFU:'#0891b2',MOFU:'#7c3aed',BOFU:'#ea580c'})[s]||'#6b7280';
  const escHtml = (s)=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

  const pdfText = (s)=>escHtml(String(s??'')).replace(/\r?\n/g,'<br/>');
  const pdfHookCell = (row)=>{
    const h = row.export_hook ?? '';
    const c = row.export_caption ?? '';
    if(!h && !c) return '<span class="muted">—</span>';
    let html = '';
    if(h) html += `<strong>${pdfText(h)}</strong>`;
    if(c) html += `<div class="small">${pdfText(c)}</div>`;
    return html;
  };
  const bodyRows = rows.map(p=>{
    const ev = p.evi_score||0;
    const evCls = ev>=7.5?'evi-high':ev>=5.5?'evi-mid':'evi-low';
    const brief = String(p.brief_script_copy||'').trim();
    return `<tr>
      <td>${pdfText(p.date||'')} <div class="small">${pdfText(p.day||'')}</div></td>
      <td><strong>${pdfText(p.platform||'')}</strong></td>
      <td><span class="pill" style="background:${stageColor(p.funnel_stage)}">${pdfText(p.funnel_stage||'')}</span></td>
      <td class="hook-cell">${pdfHookCell(p)}</td>
      <td>${pdfText(p.format||'')}</td>
      <td>${pdfText(p.intent||'')}</td>
      <td class="evi ${evCls}">${ev.toFixed(1)}</td>
      <td class="wrap-cell">${pdfText(p.cta||'')}</td>
      <td class="small">${pdfText(p.hook_type||'')}</td>
      <td class="brief-cell">${brief ? pdfText(brief) : '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<title>${escHtml(calendar.title)}</title>
<style>
  @page { size: A3 landscape; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; color: #111827; margin: 0; font-size: 9px; line-height: 1.4; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 12px; border-bottom: 2px solid #111827; margin-bottom: 14px; }
  .title { font-size: 22px; font-weight: 800; margin: 0 0 4px; color: #111827; }
  .subtitle { font-size: 11px; color: #6b7280; }
  .brand-badge { font-size: 10px; padding: 4px 10px; background: #f3f4f6; border-radius: 99px; font-weight: 600; color: #374151; }
  .stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-bottom: 14px; }
  .stat { padding: 10px 12px; background: #f9fafb; border-radius: 6px; border-left: 3px solid #6366f1; }
  .stat .l { font-size: 9px; text-transform: uppercase; color: #6b7280; font-weight: 600; letter-spacing: .04em; margin-bottom: 2px; }
  .stat .v { font-size: 16px; font-weight: 700; color: #111827; }
  table { width: 100%; border-collapse: collapse; font-size: 9px; table-layout: fixed; }
  th { background: #111827; color: white; padding: 7px 6px; text-align: left; font-weight: 600; font-size: 9px; text-transform: uppercase; letter-spacing: .03em; }
  td { padding: 6px; border-bottom: 1px solid #e5e7eb; vertical-align: top; word-wrap: break-word; overflow-wrap: anywhere; white-space: pre-wrap; }
  tr:nth-child(even) td { background: #fafafa; }
  .pill { display: inline-block; padding: 1px 6px; border-radius: 99px; font-size: 8px; font-weight: 600; color: white; white-space: nowrap; }
  .evi { font-family: 'SF Mono', Menlo, monospace; font-weight: 700; white-space: nowrap; }
  .evi-high { color: #059669; } .evi-mid { color: #d97706; } .evi-low { color: #dc2626; }
  .footer { margin-top: 14px; padding-top: 8px; border-top: 1px solid #e5e7eb; font-size: 8px; color: #9ca3af; display: flex; justify-content: space-between; }
  .hook-cell { width: 20%; }
  .hook-cell strong { font-weight: 700; color: #111827; }
  .wrap-cell { width: 11%; }
  .brief-cell { width: 18%; font-size: 8px; line-height: 1.4; color: #374151; }
  .small { font-size: 8.5px; color: #6b7280; margin-top: 2px; white-space: pre-wrap; }
  .muted { color: #9ca3af; }
  @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } td { page-break-inside: auto; } }
</style></head>
<body>
  <div class="header">
    <div>
      <h1 class="title">${escHtml(calendar.title)}</h1>
      <div class="subtitle">${rows.length} posts · ${escHtml(rows[0]?.date||'')} to ${escHtml(rows[rows.length-1]?.date||'')}${rows.length !== (calendar.posts?.length||0) ? ' · filtered view' : ''}</div>
    </div>
    <div class="brand-badge">${escHtml(brand?.name||'Brand')}</div>
  </div>

  <div class="stats">
    <div class="stat"><div class="l">Total Posts</div><div class="v">${rows.length}</div></div>
    <div class="stat" style="border-color:#0891b2"><div class="l">TOFU</div><div class="v">${dist.TOFU}</div></div>
    <div class="stat" style="border-color:#7c3aed"><div class="l">MOFU</div><div class="v">${dist.MOFU}</div></div>
    <div class="stat" style="border-color:#ea580c"><div class="l">BOFU</div><div class="v">${dist.BOFU}</div></div>
    <div class="stat" style="border-color:#10b981"><div class="l">Avg EVI</div><div class="v">${avgEvi}</div></div>
  </div>

  <table>
    <thead><tr>
      <th style="width:7%">Date</th>
      <th style="width:8%">Platform</th>
      <th style="width:6%">Stage</th>
      <th style="width:20%">Hook / Headline</th>
      <th style="width:8%">Format</th>
      <th style="width:9%">Intent</th>
      <th style="width:5%">EVI</th>
      <th style="width:11%">CTA</th>
      <th style="width:9%">Hook Type</th>
      <th style="width:18%">Brief Script / Copy</th>
    </tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>

  <div class="footer">
    <div>BrandStory Strategy OS</div>
    <div>Generated ${new Date().toLocaleString()}</div>
  </div>

</body></html>`;
}

function exportBriefCount(posts){
  return posts.filter(p=>getActiveBriefForPost(p)).length;
}

function exportCSV(){
  const data = requireExportData();
  if(!data) return;
  const {posts, calendar} = data;
  const filename = exportFilename(calendar, posts, 'csv');
  download(buildCSVContent(posts), filename, 'text/csv;charset=utf-8;');
  const n = exportBriefCount(posts);
  showToast(`Exported ${posts.length} posts${n?` (${n} with briefs)`:''} as CSV`,'ok');
}

function exportXLSX(){
  if(typeof XLSX === 'undefined'){ showToast('Excel library not loaded — try CSV','err'); return; }
  const data = requireExportData();
  if(!data) return;
  const {posts, calendar} = data;
  const wb = buildXLSXWorkbook(posts, calendar);
  XLSX.writeFile(wb, exportFilename(calendar, posts, 'xlsx'));
  const n = exportBriefCount(posts);
  showToast(`Exported ${posts.length} posts${n?` (${n} with briefs)`:''} as Excel`,'ok');
}

function exportPDF(){
  const data = requireExportData();
  if(!data) return;
  const {posts, calendar} = data;
  const html = buildPDFReportHtml(posts, calendar);
  const win = window.open('', '_blank');
  if(!win){
    showToast('Pop-up blocked — please allow pop-ups to download PDF','err');
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  const doPrint = () => setTimeout(() => { try{ win.focus(); win.print(); }catch(e){} }, 250);
  if(win.document.readyState === 'complete') doPrint();
  else win.addEventListener('load', doPrint, { once:true });
  const n = exportBriefCount(posts);
  showToast(`PDF preview opened${n?` (${n} with brief script)`:""} · Landscape · Save as PDF`,'ok');
}

function exportMarkdown(){
  const data = requireExportData();
  if(!data) return;
  const {posts, calendar} = data;
  download(buildMarkdownContent(posts, calendar), exportFilename(calendar, posts, 'md'), 'text/markdown');
  const n = exportBriefCount(posts);
  showToast(`Exported ${posts.length} posts${n?` (${n} with briefs)`:''} as Markdown`,'ok');
}

function copyBriefMarkdown(){
  const active = getActiveVariant(normalizeBrief(state.modal.data)) || state.modal.data;
  const md=`# Creative Brief — ${active.content_id||state.modal.data?.content_id||''}\n\n${briefToMarkdown(active)}`;
  navigator.clipboard.writeText(md).then(()=>showToast('Brief copied to clipboard','ok')).catch(()=>showToast('Copy failed','err'));
}

/* ========= UTILS ========= */
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c])}
function truncate(s,n){s=String(s||''); return s.length>n?s.slice(0,n)+'…':s}
function initials(s){return String(s||'?').split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase()}
function brandColor(s){const colors=['linear-gradient(135deg,#7c5cff,#22d3ee)','linear-gradient(135deg,#f59e0b,#ef4444)','linear-gradient(135deg,#22c55e,#06b6d4)','linear-gradient(135deg,#a855f7,#ec4899)','linear-gradient(135deg,#0a66c2,#22d3ee)','linear-gradient(135deg,#f97316,#dc2626)']; let h=0; for(const c of String(s||'')) h=(h*31+c.charCodeAt(0))>>>0; return colors[h%colors.length];}
function timeAgo(ms){if(!ms) return '—'; const s=Math.floor((Date.now()-ms)/1000); if(s<60) return 'just now'; if(s<3600) return Math.floor(s/60)+'m ago'; if(s<86400) return Math.floor(s/3600)+'h ago'; if(s<604800) return Math.floor(s/86400)+'d ago'; return new Date(ms).toLocaleDateString();}
function todayISO(){return new Date().toISOString().slice(0,10)}
function monthName(d){return d.toLocaleString('en-US',{month:'long',year:'numeric'})}
function slug(s){return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')}
function avgEVI(posts){if(!posts||!posts.length) return 0; return posts.reduce((s,p)=>s+(p.evi_score||0),0)/posts.length}
function countByFunnel(posts,stage){return (posts||[]).filter(p=>p.funnel_stage===stage).length}
function funnelDistribution(posts){const d={TOFU:0,MOFU:0,BOFU:0}; (posts||[]).forEach(p=>{if(d[p.funnel_stage]!==undefined) d[p.funnel_stage]++}); return d;}
function platformDistribution(posts){const d={}; (posts||[]).forEach(p=>{d[p.platform]=(d[p.platform]||0)+1}); return d;}
function download(content,filename,mime){const blob=new Blob([content],{type:mime}); downloadBlob(blob,filename);}
function downloadBlob(blob,filename){const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=filename; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);}

/* ========= INIT ========= */
(async function init(){
  try{
    state.brands=await Store.listBrands();
    state.allBriefs=await Store.listAllBriefs();
    if(state.brands.length) state.activeBrandId=state.brands[0].id;
    if(state.activeBrandId) await loadBrandWorkspace();
  }catch(e){
    console.error('Init failed:',e);
    showToast('Init error: '+e.message,'err');
  }
  render();
})();
