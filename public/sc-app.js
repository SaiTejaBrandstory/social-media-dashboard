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

/* ========= CONTENT GUARDRAILS (Anti-Repetition System) ========= */
const GUARDRAIL_HOOK_CATEGORIES = [
  'Contrarian','Curiosity Gap','Shock Statistic','Story','Prediction','Mistake',
  'Comparison','Observation','Question','Challenge','Insider Secret','Myth Busting',
];
const GUARDRAIL_FRAMEWORKS = [
  'PAS','AIDA','BAB','Story Arc','Hero Journey','Problem-Solution','Before-After',
  'Myth-Reality','Lessons Learned','Case Study','Prediction','Checklist',
  'Contrarian Opinion','Open Loop','Reverse Story',
];
const GUARDRAIL_ANGLES = [
  'Educational','Opinion','Trend','Story','Case Study','Data Driven','Psychology',
  'Customer POV','Founder POV','Future Prediction','Myth Busting','Competitive',
];
const GUARDRAIL_CONTENT_ANGLES = ['Educational','Contrarian','Story','Myth-busting','Behind-the-scenes'];
const GUARDRAIL_EMOTIONAL_TRIGGERS = ['Curiosity','Aspiration','Fear','Trust','Pride'];
const GUARDRAIL_AUDIENCE_AWARENESS = ['Unaware','Problem-aware','Solution-aware'];
const GUARDRAIL_PERSPECTIVES = ['Founder','Customer','Industry Expert','Observer'];
const GUARDRAIL_BUSINESS_OBJECTIVES = [
  'Awareness','Consideration','Trust Building','Lead Generation','Conversion','Retention',
];
const GUARDRAIL_TONE_MATRIX = [
  ['Educational','Conversational'],['Authority','Analytical'],['Storytelling','Emotional'],
  ['Premium','Minimalist'],['Humorous','Insightful'],['Inspirational','Strategic'],
  ['Documentary','Investigative'],['Founder Voice','Personal'],['Journalistic','Objective'],
  ['Contrarian','Bold'],
];
const GUARDRAIL_BANNED_PHRASES = [
  'we help businesses grow','unlock your potential','transform your business today',
  "in today's competitive landscape","whether you're a startup or enterprise",
  'unlock the power of','game-changing solution','did you know','here are 3 ways',
  'stop doing this','most businesses','revolutionize your','take your business to the next level',
  'cutting-edge solution','synergy','leverage your','disrupt the industry',
];
const SIMILARITY_THRESHOLD = 0.35;

function normalizeCompareText(s){
  return String(s||'').toLowerCase().replace(/[^\w\s]/g,' ').replace(/\s+/g,' ').trim();
}
function getWordSet(s){
  return new Set(normalizeCompareText(s).split(' ').filter(w=>w.length>2));
}
function jaccardSimilarity(a,b){
  const setA=getWordSet(a), setB=getWordSet(b);
  if(!setA.size&&!setB.size) return 0;
  let inter=0;
  for(const w of setA) if(setB.has(w)) inter++;
  const union=setA.size+setB.size-inter;
  return union?inter/union:0;
}
function maxTextSimilarity(text,corpus){
  if(!text||!corpus?.length) return 0;
  let max=0;
  for(const item of corpus){
    const cmp=typeof item==='string'?item:(item.text||item.hook||item.caption_preview||'');
    if(!cmp) continue;
    const sim=jaccardSimilarity(text,cmp);
    if(sim>max) max=sim;
  }
  return max;
}
function containsBannedPhrase(text){
  const n=normalizeCompareText(text);
  return GUARDRAIL_BANNED_PHRASES.some(p=>n.includes(p));
}
function pickRandom(arr,exclude=[]){
  const pool=arr.filter(x=>!exclude.includes(x));
  return pool[Math.floor(Math.random()*pool.length)]||arr[0];
}
function shuffleArray(arr){
  const a=[...arr];
  for(let i=a.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

function collectContentHistory(calendars,briefs,currentPosts=[]){
  const posts=[], hooks=[], scripts=[], metadata=[];
  const addPost=p=>{
    if(!p) return;
    posts.push(p);
    if(p.hook) hooks.push({text:p.hook, hook_type:p.hook_type||p.hook_category, hook_category:p.hook_category||p.hook_type});
    if(p.generation_meta) metadata.push(p.generation_meta);
  };
  for(const cal of (calendars||[])){
    for(const p of (cal.posts||[])) addPost(p);
  }
  for(const b of (briefs||[])){
    const nb=normalizeBrief(b);
    for(const v of (nb.variants||[])){
      if(v.script_copy) scripts.push({text:v.script_copy, tone_primary:v.tone_primary, tone_secondary:v.tone_secondary});
      if(v.hook) hooks.push({text:v.hook, hook_type:v.hook_type});
      if(v.generation_meta) metadata.push(v.generation_meta);
    }
    const active=getActiveVariant(nb);
    if(active?.script_copy&&!scripts.some(s=>s.text===active.script_copy))
      scripts.push({text:active.script_copy, tone_primary:active.tone_primary, tone_secondary:active.tone_secondary});
  }
  for(const p of currentPosts) addPost(p);
  return {
    posts: posts.slice(0,50),
    hooks: hooks.slice(0,100),
    scripts: scripts.slice(0,20),
    metadata: metadata.slice(0,100),
  };
}

function buildGenerationMeta(post,assignment){
  return {
    content_id: post.content_id||'',
    hook_type: post.hook_type||post.hook_category||'',
    hook_category: post.hook_category||post.hook_type||'',
    tone: post.tone_primary?`${post.tone_primary}+${post.tone_secondary}`:'',
    tone_primary: post.tone_primary||'',
    tone_secondary: post.tone_secondary||'',
    framework: post.content_framework||assignment?.framework||'',
    angle: post.content_angle||post.creative_angle||assignment?.angle||'',
    creative_angle: post.creative_angle||assignment?.creative_angle||'',
    emotional_trigger: post.emotional_trigger||assignment?.emotional_trigger||'',
    objective: post.business_objective||post.objective||assignment?.business_objective||'',
    cta_type: post.cta_type||'',
    perspective: post.perspective||assignment?.perspective||'',
    audience_awareness: post.audience_awareness||assignment?.audience_awareness||'',
    keywords: (post.hook||'').split(/\s+/).slice(0,6).filter(w=>w.length>3),
    generated_at: Date.now(),
  };
}

function getRecentFrameworkUsage(metadata,limit=20){
  const counts={};
  for(const m of (metadata||[]).slice(0,limit)){
    const fw=m.framework||'';
    if(fw) counts[fw]=(counts[fw]||0)+1;
  }
  return counts;
}
function getHookCategoryFrequency(hooks){
  const counts={};
  for(const h of (hooks||[])){
    const cat=h.hook_category||h.hook_type||'Unknown';
    counts[cat]=(counts[cat]||0)+1;
  }
  return counts;
}
function getRecentCombos(metadata,limit=20){
  return new Set((metadata||[]).slice(0,limit).map(m=>
    `${m.angle||''}|${m.framework||''}|${m.emotional_trigger||''}`
  ));
}
function getRecentToneCombos(scripts,limit=15){
  return new Set((scripts||[]).slice(0,limit).map(s=>
    `${s.tone_primary||''}|${s.tone_secondary||''}`
  ));
}

function selectVariationPlan(history,count,alreadyGenerated=[]){
  const meta=[...(alreadyGenerated||[]).map(p=>p.generation_meta).filter(Boolean), ...(history.metadata||[])];
  const hooks=[...(alreadyGenerated||[]).map(p=>({text:p.hook,hook_type:p.hook_type})), ...(history.hooks||[])];
  const fwUsage=getRecentFrameworkUsage(meta);
  const hookFreq=getHookCategoryFrequency(hooks);
  const totalHooks=Math.max(hooks.length,1);
  const usedCombos=getRecentCombos(meta);
  const lastAngle=meta[0]?.angle||'';
  const assignments=[];
  const usedInBatch=new Set();

  for(let i=0;i<count;i++){
    let angle, framework, trigger, hookCat, perspective, awareness, objective, creativeAngle;
    let attempts=0;
    do{
      angle=pickRandom(GUARDRAIL_CONTENT_ANGLES,[lastAngle,...Array.from(usedInBatch).filter(k=>k.startsWith('a:')).map(k=>k.slice(2))]);
      creativeAngle=pickRandom(GUARDRAIL_ANGLES,[meta[0]?.creative_angle||'']);
      framework=pickRandom(GUARDRAIL_FRAMEWORKS,Object.entries(fwUsage).filter(([_,c])=>c>=2).map(([k])=>k));
      trigger=pickRandom(GUARDRAIL_EMOTIONAL_TRIGGERS);
      const overused=Object.entries(hookFreq).filter(([_,c])=>c/totalHooks>0.15).map(([k])=>k);
      hookCat=pickRandom(GUARDRAIL_HOOK_CATEGORIES,overused);
      perspective=pickRandom(GUARDRAIL_PERSPECTIVES);
      awareness=pickRandom(GUARDRAIL_AUDIENCE_AWARENESS);
      objective=pickRandom(GUARDRAIL_BUSINESS_OBJECTIVES);
      attempts++;
    }while(attempts<40 && (
      usedCombos.has(`${angle}|${framework}|${trigger}`) ||
      usedInBatch.has(`a:${angle}`) ||
      usedInBatch.has(`f:${framework}`) ||
      usedInBatch.has(`h:${hookCat}`)
    ));
    usedInBatch.add(`a:${angle}`); usedInBatch.add(`f:${framework}`); usedInBatch.add(`h:${hookCat}`);
    assignments.push({angle,creative_angle:creativeAngle,framework,emotional_trigger:trigger,
      hook_category:hookCat,perspective,audience_awareness:awareness,business_objective:objective});
  }
  return assignments;
}

function selectToneCombo(history){
  const used=getRecentToneCombos(history.scripts);
  const shuffled=shuffleArray(GUARDRAIL_TONE_MATRIX);
  for(const [primary,secondary] of shuffled){
    const key=`${primary}|${secondary}`;
    if(!used.has(key)) return {tone_primary:primary,tone_secondary:secondary};
  }
  return {tone_primary:pickRandom(GUARDRAIL_TONE_MATRIX.map(t=>t[0])), tone_secondary:pickRandom(GUARDRAIL_TONE_MATRIX.map(t=>t[1]))};
}

const FORMAT_COPY_MARKERS={
  carousel:/\b(slide\s*[#\d:]|\bslide\s+\d+|swipe\s+(left|through|to)|carousel|cover\s+slide|slide\s+deck|slides?\s*\d+\s*[-–—]\s*\d+)\b/i,
  video:/\b(9:16|vertical\s+video|first\s*1\.?5\s*s|b-?roll|shot\s*[#\d]|cut\s+to|on-?screen\s+text|pattern\s+interrupt|hook\s+in\s+first|timestamp\s*0:)/i,
  thread:/\b(tweet\s*\d|thread\s*\(|^\s*1\/\d+|post\s*1\s*of\s*\d+|🧵)\b/im,
  staticOnly:/\b(headline\s+on\s+image|single\s+static|one\s+image\s+post)\b/i,
};

function getFormatCopyMismatchReasons(post){
  const fmt=String(post.format||'').trim();
  const text=`${post.hook||''} ${post.caption_preview||''} ${post.creative_direction||''}`;
  const reasons=[];
  const carouselLike=fmt==='Carousel'||fmt==='Document Post';
  const videoLike=fmt==='Reel'||fmt==='Short'||fmt==='Live';
  const threadLike=fmt==='Thread';
  const hasCarousel=FORMAT_COPY_MARKERS.carousel.test(text);
  const hasVideo=FORMAT_COPY_MARKERS.video.test(text);
  const hasThread=FORMAT_COPY_MARKERS.thread.test(text);

  if(videoLike&&hasCarousel&&!hasVideo)
    reasons.push(`copy uses slide/carousel language but format is ${fmt} — rewrite as video/reel script`);
  if(carouselLike&&hasVideo&&!hasCarousel)
    reasons.push(`copy uses video shot-list language but format is ${fmt} — rewrite as slide-by-slide`);
  if(threadLike&&hasCarousel&&!hasThread)
    reasons.push(`copy uses carousel slides but format is ${fmt} — rewrite as numbered thread`);
  if(threadLike&&hasVideo&&!hasThread&&!carouselLike)
    reasons.push(`copy uses video language but format is Thread — rewrite as chained posts`);
  if(fmt==='Static'&&hasCarousel)
    reasons.push('copy uses multi-slide structure but format is Static — single image/text only');
  return reasons;
}

function getFormatCreativePromptRules(format,platform){
  const guide=FORMAT_COPY_GUIDANCE[format]||'Match the assigned format exactly.';
  const bans={
    Reel:'Do NOT write slide 1/slide 2, carousel, or swipe.',
    Short:'Do NOT write carousel slides or document sections.',
    Carousel:'Do NOT write video shot timestamps or b-roll lists without slides.',
    'Document Post':'Use professional slide/section headers, not Reel hooks.',
    Static:'Do NOT write multi-slide or shot-by-shot video directions.',
    Thread:'Do NOT write carousel slides — use numbered thread posts.',
    Live:'Focus on live run-of-show, not static carousel.',
  };
  return `Platform: ${platform||'—'} | Format: ${format||'—'}\n${guide}\n${bans[format]||'No other format\'s structure.'}`;
}

function getBriefScriptGuideForFormat(format,platform,toneCombo){
  const t=`${toneCombo.tone_primary}+${toneCombo.tone_secondary} tone`;
  const guides={
    Reel:`Shot-by-shot vertical video script with timestamps (0:00-0:03 hook, etc.) in ${t}. Include on-screen text + audio notes. NO slide numbers.`,
    Short:`YouTube Short script under 60s, one idea, ${t}. Fast cuts, loop ending. NO carousel slides.`,
    Carousel:`Slide-by-slide copy (Slide 1:, Slide 2:, … up to 8 slides) in ${t}. NO video shot lists.`,
    'Document Post':`LinkedIn document sections (Section 1:, Section 2:, …) in ${t}. Professional, scannable. NO Reel timestamps.`,
    Static:`Single post: headline on image + body + CTA in ${t}. NO slides or shot lists.`,
    Story:`Frame-by-frame Story sequence (Frame 1:, Frame 2:, …) in ${t}. Short, urgent. NO carousel deck.`,
    Thread:`Numbered thread (1/, 2/, … or Post 1:, Post 2:) in ${t}. NO slides or video b-roll.`,
    Live:`Live run-of-show: opening hook, segments, Q&A, CTA in ${t}. NO carousel.`,
  };
  return guides[format]||`Write script_copy for ${platform} ${format} in ${t}. Structure MUST match ${format} only.`;
}

function validatePostContent(post,history,currentBatch=[]){
  const reasons=[];
  const hook=post.hook||'';
  const caption=post.caption_preview||'';
  const combined=`${hook} ${caption}`;

  const postCorpus=[...(history.posts||[]).map(p=>p.hook||''), ...(currentBatch||[]).filter(p=>p!==post).map(p=>p.hook||'')];
  const hookCorpus=[...(history.hooks||[]).map(h=>h.text||''), ...(currentBatch||[]).filter(p=>p!==post).map(p=>p.hook||'')];

  if(maxTextSimilarity(hook,hookCorpus)>SIMILARITY_THRESHOLD) reasons.push('hook too similar to prior hooks');
  if(maxTextSimilarity(combined,postCorpus)>SIMILARITY_THRESHOLD) reasons.push('content too similar to prior posts');
  if(containsBannedPhrase(combined)) reasons.push('contains banned generic phrasing');
  reasons.push(...getFormatCopyMismatchReasons(post));

  const meta=post.generation_meta||{};
  const recentMeta=[...(currentBatch||[]).map(p=>p.generation_meta).filter(Boolean), ...(history.metadata||[])];
  const combo=`${meta.angle||post.content_angle||''}|${meta.framework||post.content_framework||''}|${meta.emotional_trigger||post.emotional_trigger||''}`;
  const recentCombos=getRecentCombos(recentMeta,20);
  if(combo!=='||' && recentCombos.has(combo)) reasons.push('repeated angle+framework+trigger combo');

  return {valid:!reasons.length, reasons};
}

function buildAntiRepetitionSection(history,alreadyGenerated,variationPlan,dateSchedule,postSlots){
  const recentHooks=[...(alreadyGenerated||[]).slice(-15).map(p=>p.hook), ...(history.hooks||[]).slice(0,20).map(h=>h.text)].filter(Boolean);
  const recentCaptions=[...(alreadyGenerated||[]).slice(-10).map(p=>p.caption_preview), ...(history.posts||[]).slice(0,10).map(p=>p.caption_preview)].filter(Boolean);
  const hookList=recentHooks.slice(0,30).map((h,i)=>`${i+1}. "${h}"`).join('\n')||'(none yet)';
  const capList=recentCaptions.slice(0,15).map((c,i)=>`${i+1}. "${String(c).slice(0,80)}"`).join('\n')||'(none yet)';

  const planLines=(variationPlan||[]).map((v,i)=>{
    const slot=(postSlots||[])[i];
    const ds=dateSchedule?.[i];
    const slotPart=slot?` | Platform=${slot.platform} | Format="${slot.format}" [LOCKED]`:'';
    const datePart=ds?` | Date=${ds.date} (${ds.day}) [use exactly]`:'';
    return `Post ${i+1}: Angle=${v.angle} | Framework=${v.framework} | Trigger=${v.emotional_trigger} | HookCategory=${v.hook_category} | Perspective=${v.perspective} | Awareness=${v.audience_awareness} | Objective=${v.business_objective} | CreativeAngle=${v.creative_angle}${slotPart}${datePart}`;
  }).join('\n');

  return `# CONTENT UNIQUENESS GUARDRAILS (MANDATORY)

## Senior Copywriter Persona
You are a Senior Brand Copywriter with 15+ years at Ogilvy, Wieden+Kennedy, Leo Burnett, and DDB.
Before writing each post, internally answer: business objective? expected audience action? emotional response? unique perspective?
Reject generic statements, clichés, motivational fluff, and meaningless buzzwords.

## Anti-Repetition Rules
- Similarity to prior content must stay BELOW 35%. Do NOT reuse hooks, angles, examples, or phrasing from below.
- Never use the same Angle + Framework + Emotional Trigger combo from the last 20 outputs.
- Same framework cannot appear more than 2 times in the last 20 outputs.
- No hook category may exceed 15% frequency across recent history.
- Do NOT repeat the same creative angle in consecutive outputs.
- BANNED openers/patterns: "Did you know", "Here are 3 ways", "Stop doing this", "Most businesses", corporate jargon.

## Already Generated Hooks (DO NOT REPEAT OR PARAPHRASE)
${hookList}

## Recent Captions (AVOID SAME STRUCTURE/IDEAS)
${capList}

## Per-Post Variation Assignments (FOLLOW EXACTLY — one row per post in order)
${planLines||'(assign unique combinations per post yourself)'}

## Human-Like Copy Filter
Remove: AI transitions, repeated sentence structures, overused CTAs.
Add: specificity, unexpected observations, concrete examples, human language.

## Business Objective Alignment
Every post must map to: Awareness | Consideration | Trust Building | Lead Generation | Conversion | Retention.
Before finalizing each post, confirm: "How does this support the assigned business objective?"

## Creative Director Review (internal — regenerate if any score < 8, total < 42/50)
Score each post: Originality, Strategic Alignment, Hook Strength, Emotional Impact, Platform Fit (each /10).

Golden rule: Create strategically distinct persuasion — unique angle, fresh hook mechanism, senior copywriter voice — NOT generic social media filler.`;
}

async function regenerateCalendarPost(post,brand,history,assignment,reasons){
  const avoidHooks=[...(history.hooks||[]).slice(0,30).map(h=>h.text), post.hook].filter(Boolean).slice(0,20);
  const prompt=`You are a Senior Brand Copywriter (15+ years, Ogilvy/W+K/Leo Burnett/DDB). Regenerate ONE calendar post that is strategically distinct.

BRAND: ${brand.name} | ${brand.vertical||''} | ${brand.business_model||''}
BRAND TONE: ${brand.brand_tone||brand.brand_tone_personality||brand.brand_voice||'professional'}
BRAND PERSONALITY: ${brand.brand_personality||'-'}
LANGUAGE: ${brand.brand_language||'Global English'} (all copy must match this locale)
TARGET: ${brand.target_customer_profile||''}

KEEP LOCKED: date=${post.date}, platform=${post.platform}, format=${post.format}, funnel=${post.funnel_stage}, content_id=${post.content_id}

ASSIGNED VARIATION (mandatory):
- Content Angle: ${assignment?.angle||'Contrarian'}
- Creative Angle: ${assignment?.creative_angle||'Opinion'}
- Framework: ${assignment?.framework||'PAS'}
- Emotional Trigger: ${assignment?.emotional_trigger||'Curiosity'}
- Hook Category: ${assignment?.hook_category||'Contrarian'}
- Perspective: ${assignment?.perspective||'Founder'}
- Audience Awareness: ${assignment?.audience_awareness||'Problem-aware'}
- Business Objective: ${assignment?.business_objective||'Consideration'}

REJECTION REASONS: ${(reasons||[]).join('; ')||'too similar to prior content'}

# FORMAT & COPY (MANDATORY — do not change format)
${getFormatCreativePromptRules(post.format,post.platform)}

AVOID THESE HOOKS ENTIRELY:
${avoidHooks.map((h,i)=>`${i+1}. "${h}"`).join('\n')}

BANNED: generic fluff, clichés, "Did you know", "Here are 3 ways", "Most businesses", "unlock your potential".

Return JSON with EXACT keys:
hook, caption_preview, intent, hook_type, hook_category, content_angle, creative_angle, content_framework, emotional_trigger, perspective, audience_awareness, business_objective, creative_direction, visual_specs, cta, segment, evi_score, sentiment, status

hook_type and hook_category must match assigned Hook Category.`;
  const json=await callClaudeJSON(prompt,{max_tokens:2500,temperature:0.75});
  const merged={...post,...json,
    hook_type:json.hook_category||json.hook_type||assignment?.hook_category||post.hook_type,
    hook_category:json.hook_category||json.hook_type||assignment?.hook_category,
    content_angle:json.content_angle||assignment?.angle,
    creative_angle:json.creative_angle||assignment?.creative_angle,
    content_framework:json.content_framework||assignment?.framework,
    emotional_trigger:json.emotional_trigger||assignment?.emotional_trigger,
    perspective:json.perspective||assignment?.perspective,
    audience_awareness:json.audience_awareness||assignment?.audience_awareness,
    business_objective:json.business_objective||assignment?.business_objective,
  };
  merged.platform=post.platform;
  merged.format=post.format;
  merged.date=post.date;
  merged.day=post.day;
  merged.content_id=post.content_id;
  merged.generation_meta=buildGenerationMeta(merged,assignment);
  return merged;
}

function lockPostSlotFields(post){
  post.platform=normalizeCalendarPlatform(post.platform);
  return post;
}

function resolveChannelFormat(channelFormats,platform){
  if(!channelFormats) return null;
  const canon=normalizeCalendarPlatform(platform);
  return channelFormats[canon]||channelFormats[platform]||null;
}

/** @deprecated single-format calendars only */
function lockPostPlatformFormat(post,channelFormats){
  lockPostSlotFields(post);
  const fmt=resolveChannelFormat(channelFormats,post.platform);
  if(fmt&&!post.format) post.format=fmt;
  return post;
}

function enforceAllPostFormats(posts){
  if(!posts?.length) return {posts, mismatches:0};
  let mismatches=0;
  for(const p of posts){
    const before=p.format;
    lockPostSlotFields(p);
    if(before&&p.format&&before!==p.format) mismatches++;
  }
  return {posts, mismatches};
}

async function validateAndFixBatchPosts(posts,brand,history,alreadyGenerated,variationPlan,log){
  const fixed=[];
  for(let i=0;i<posts.length;i++){
    let post={...posts[i]};
    lockPostSlotFields(post);
    const lockedPlatform=post.platform;
    const lockedFormat=post.format;
    const assignment=variationPlan[i]||selectVariationPlan(history,1,alreadyGenerated)[0];
    post.hook_type=post.hook_category||post.hook_type||assignment.hook_category;
    post.hook_category=post.hook_category||post.hook_type||assignment.hook_category;
    post.content_angle=post.content_angle||assignment.angle;
    post.creative_angle=post.creative_angle||assignment.creative_angle;
    post.content_framework=post.content_framework||assignment.framework;
    post.emotional_trigger=post.emotional_trigger||assignment.emotional_trigger;
    post.perspective=post.perspective||assignment.perspective;
    post.audience_awareness=post.audience_awareness||assignment.audience_awareness;
    post.business_objective=post.business_objective||assignment.business_objective;
    post.generation_meta=buildGenerationMeta(post,assignment);

    let check=validatePostContent(post,history,[...alreadyGenerated,...fixed]);
    let retries=0;
    while(!check.valid && retries<2){
      log.push(`  ↻ Regenerating post ${i+1} (${check.reasons.join(', ')})`);
      try{
        post=await regenerateCalendarPost(post,brand,history,assignment,check.reasons);
        post.platform=lockedPlatform;
        post.format=lockedFormat;
        check=validatePostContent(post,history,[...alreadyGenerated,...fixed]);
      }catch(e){
        log.push(`  ⚠ Regen failed for post ${i+1}: ${e.message}`);
        break;
      }
      retries++;
    }
    post.platform=lockedPlatform;
    post.format=lockedFormat;
    fixed.push(post);
  }
  return fixed;
}

/* ========= STATE ========= */
const state={ view:'brands', brands:[], activeBrandId:null, calendars:[], activeCalendar:null, briefs:[], trends:null, allBriefs:[], loading:false, modal:null, toast:null, _saveBrandInFlight:false };

function setState(p){ Object.assign(state,p); render(); }

let _renderQueued=false;
let _modalRenderQueued=false;
let _renderedView=null;
let _analyticsKey=null;

function ensureAppChrome(){
  const root=document.getElementById('app');
  if(!root) return null;
  if(!root.querySelector('#app-shell')){
    root.innerHTML='<div id="app-shell"></div><div id="modal-host"></div>';
  }
  return {shell:root.querySelector('#app-shell'), modalHost:root.querySelector('#modal-host')};
}

function render(opts={}){
  if(opts.modalOnly){
    if(_modalRenderQueued) return;
    _modalRenderQueued=true;
    requestAnimationFrame(()=>{
      _modalRenderQueued=false;
      renderModalImpl();
    });
    return;
  }
  if(_renderQueued) return;
  _renderQueued=true;
  requestAnimationFrame(()=>{
    _renderQueued=false;
    renderImpl();
  });
}

function renderSync(opts={}){
  _renderQueued=false;
  _modalRenderQueued=false;
  if(opts.modalOnly) renderModalImpl();
  else renderImpl();
}

function renderModalImpl(){
  const chrome=ensureAppChrome();
  if(!chrome?.modalHost){ renderImpl(); return; }
  chrome.modalHost.innerHTML=state.modal?renderModal():'';
  afterRenderModal();
}

function afterRenderModal(){
  if(state.modal?.kind==='brand-form') patchBrandSaveButton();
}

function clearModalState(){
  state.modal=null;
  state._saveBrandInFlight=false;
  state._chanPlan=null;
  state._chanSel=null;
  state._chanFormats=null;
  state._chanDays=null;
  state._briefEdit=null;
  state._briefEditVariantId=null;
  state._briefShowRegenerated=false;
  state._postEdit=null;
  state._focusPostField=null;
  state._newPost=null;
}

/** Close overlay only (cheap). Use clearModalState()+render() when main content changed. */
function closeModal(){
  clearModalState();
  render({modalOnly:true});
}

function refreshUI(){
  clearModalState();
  render();
}

function ensureToastHost(){
  let host=document.getElementById('app-toast-host');
  if(!host){
    host=document.createElement('div');
    host.id='app-toast-host';
    host.className='pointer-events-none';
    host.style.cssText='position:fixed;bottom:24px;right:24px;z-index:70';
    document.body.appendChild(host);
  }
  return host;
}

function paintToast(){
  const host=ensureToastHost();
  if(!state.toast){ host.innerHTML=''; return; }
  const colors={ok:'var(--good)',err:'var(--bad)',info:'var(--accent)'};
  const border=colors[state.toast.kind]||'var(--line)';
  const color=colors[state.toast.kind]||'var(--ink)';
  host.innerHTML=`<div class="panel p-3 px-4 fadein pointer-events-auto" style="border-color:${border}">
    <div class="text-[12.5px] font-medium" style="color:${color}">${esc(state.toast.msg)}</div>
  </div>`;
}

function showToast(msg,kind='ok',durMs){
  state.toast={msg,kind};
  paintToast();
  const dur=durMs||(kind==='err'?7000:3500);
  clearTimeout(window._toastTimer);
  window._toastTimer=setTimeout(()=>{ state.toast=null; paintToast(); }, dur);
}

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
function renderImpl(){
  const chrome=ensureAppChrome();
  const root=document.getElementById('app');
  if(!chrome?.shell||!root) return;

  const focused = document.activeElement;
  const focusedId = focused?.id;
  const cursorPos = (focusedId === 'posts-search') ? focused.selectionStart : null;
  const viewChanged = state._renderedView !== state.view;
  state._renderedView = state.view;
  const contentAnim = viewChanged ? ' fadein' : '';

  chrome.shell.innerHTML=`
    <div class="flex min-h-screen">
      ${renderSidebar()}
      <main class="flex-1 min-w-0">
        ${renderTopbar()}
        <div class="p-6${contentAnim}" id="content">${renderView()}</div>
      </main>
    </div>
  `;
  chrome.modalHost.innerHTML=state.modal?renderModal():'';
  afterRender();
  if(state.view==='analytics') drawAnalyticsOnce();

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
      ${state.view==='calendar'&&brand?`<button class="btn primary" data-action="generate-calendar" ${!isBrandProfileComplete(brand)?'disabled title="Complete required brand profile first"':''}>${ICONS.spark} Generate Calendar</button>`:''}
      ${state.view==='trends'&&brand?`<button class="btn primary" data-action="fetch-trends" ${!isBrandProfileComplete(brand)?'disabled title="Complete required brand profile first"':''}>${ICONS.refresh} ${state.trends?'Refresh':'Fetch'} Trends</button>`:''}
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
      const incomplete=!isBrandProfileComplete(b);
      const missingLabels=getBrandMissingRequired(b).map(m=>m.label).join(', ');
      return `
      <div class="panel p-5 fadein${incomplete?' brand-card-incomplete':''}">
        <div class="flex items-start justify-between mb-3">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-11 h-11 rounded-xl flex items-center justify-center text-white font-bold text-[15px] shrink-0" style="background:${brandColor(b.name)}">${initials(b.name||'?')}</div>
            <div class="min-w-0">
              <div class="font-semibold text-[14px] truncate">${esc(b.name||'Unnamed brand')}</div>
              <div class="text-[11.5px] text-[var(--ink3)] truncate">${esc(b.website_url||'no domain')}</div>
            </div>
          </div>
          <div class="flex gap-1">
            <button class="btn ghost" style="padding:5px 7px" data-edit-brand="${b.id}" title="Edit">${ICONS.edit}</button>
            <button class="btn ghost danger" style="padding:5px 7px" data-delete-brand="${b.id}" title="Delete">${ICONS.trash}</button>
          </div>
        </div>
        <div class="flex flex-wrap gap-1.5 mb-3">
          ${incomplete?`<span class="pill brand-pill-incomplete">Incomplete profile</span>`:''}
          <span class="pill">${esc(b.business_model||'B2C')}</span>
          <span class="pill">${esc(b.price_sensitivity_tier||'Mid-Market')}</span>
          ${b.vertical?`<span class="pill accent">${esc(b.vertical.length>22?b.vertical.slice(0,22)+'…':b.vertical)}</span>`:''}
        </div>
        ${incomplete?`<div class="text-[11.5px] text-[var(--bad)] mb-3 leading-relaxed">Missing: ${esc(missingLabels)}</div>`:''}
        <div class="text-[11.5px] text-[var(--ink2)] leading-relaxed mb-4 line-clamp-2" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(b.target_customer_profile||'No customer profile yet')}</div>
        <div class="flex items-center justify-between">
          <div class="text-[10.5px] text-[var(--ink3)]">Updated ${lastUpd}</div>
          <button class="btn ${incomplete?'':'primary'}" style="padding:6px 11px;font-size:12px" data-open-brand="${b.id}">${incomplete?'Complete profile →':'Open →'}</button>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function renderIncompleteBrandBanner(brand){
  const missing=getBrandMissingRequired(brand).map(m=>m.label);
  return `<div class="brand-form-error-banner mb-4" role="alert">
    <div class="font-semibold mb-1">Brand profile incomplete</div>
    <div class="font-normal opacity-90">This brand was saved before required fields were enforced. Add: <strong>${esc(missing.join(', '))}</strong> before generating calendars or trends.</div>
    <button type="button" class="btn mt-3" data-edit-brand="${brand.id}">Complete profile</button>
  </div>`;
}

/* ----- CALENDAR VIEW ----- */
function renderCalendarView(){
  const brand=state.brands.find(b=>b.id===state.activeBrandId);
  if(!brand) return renderSelectBrandHint('Pick a brand to view its content calendars');
  if(!isBrandProfileComplete(brand)){
    return renderIncompleteBrandBanner(brand)+`
    <div class="panel empty mt-4">
      <div class="text-[13px] text-[var(--ink2)]">Existing calendars stay saved, but new generation needs a complete brand profile.</div>
    </div>`;
  }
  const cals=state.calendars||[];
  const active=state.activeCalendar;
  const sidebarOpen = !state._calSidebarCollapsed;
  const calList = cals.length ? `<div class="space-y-2 cal-sidebar-list">${cals.map(c=>`
          <div class="panel2 p-3 ${active&&active.id===c.id?'glow':''}">
            <div class="flex items-center justify-between mb-1 gap-1">
              <div class="text-[12.5px] font-semibold truncate min-w-0 cursor-pointer" data-open-cal="${c.id}">${esc(c.title||'Untitled plan')}</div>
              <button type="button" class="btn ghost danger shrink-0" style="padding:3px 5px" data-delete-cal="${c.id}" title="Delete calendar">${ICONS.trash}</button>
            </div>
            <div class="cursor-pointer" data-open-cal="${c.id}">
              <div class="text-[10.5px] text-[var(--ink3)]">${c.posts?c.posts.length:0} posts · ${timeAgo(c.createdAt)}</div>
              <div class="flex flex-wrap gap-1 mt-2">
                <span class="pill tofu">T ${countByFunnel(c.posts,'TOFU')}</span>
                <span class="pill mofu">M ${countByFunnel(c.posts,'MOFU')}</span>
                <span class="pill bofu">B ${countByFunnel(c.posts,'BOFU')}</span>
              </div>
            </div>
          </div>`).join('')}</div>` : `
          <div class="text-[12px] text-[var(--ink3)]">No calendars yet. Click <b class="text-[var(--ink2)]">Generate Calendar</b> to create the first one.</div>`;

  return `
    <div class="cal-layout ${sidebarOpen?'':'cal-layout-collapsed'}">
      <aside class="cal-sidebar panel p-4 self-start" aria-hidden="${sidebarOpen?'false':'true'}">
        <div class="flex items-center justify-between mb-3 gap-2">
          <div class="flex items-center gap-2 min-w-0">
            ${ICONS.calendar}
            <div class="text-[12px] font-semibold text-[var(--ink2)] uppercase tracking-wider">Calendars</div>
            <span class="pill mono">${cals.length}</span>
          </div>
          <button type="button" class="cal-sidebar-toggle" data-action="toggle-cal-sidebar" title="Hide calendars" aria-label="Hide calendars">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
        </div>
        ${calList}
      </aside>
      <div class="cal-main min-w-0">
        ${!sidebarOpen?`<button type="button" class="btn cal-sidebar-open-btn mb-3" data-action="toggle-cal-sidebar" title="Show calendars">
          ${ICONS.calendar}<span>Calendars</span><span class="pill mono">${cals.length}</span>
        </button>`:''}
        ${active?renderCalendarDetailMain(active,brand):`
          <div class="panel empty">
            <div class="text-[14px] font-semibold mb-1 text-[var(--ink)]">Select a calendar</div>
            <div class="text-[12px]">Pick one from the list${sidebarOpen?' on the left':''}, or generate a new 30-day plan.</div>
          </div>
        `}
      </div>
    </div>
  `;
}

function renderCalendarDetailMain(c,brand){
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
        <div class="flex flex-wrap gap-2 justify-end">
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

    <div class="panel p-4 mb-4 ${state._calendarEditMode?'ring-1 ring-[var(--accent-soft2)]':''}" style="${state._calendarEditMode?'background:rgba(124,92,255,.03)':''}">
      <div class="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <div class="flex items-center gap-2 flex-wrap">
          <div class="text-[12px] font-semibold text-[var(--ink2)] uppercase tracking-wider">30-Day View</div>
          ${state._calendarEditMode?`<span class="pill accent">Editing</span>`:''}
        </div>
        <div class="flex items-center gap-2 flex-wrap">
          <div class="flex gap-1.5">
            <span class="pill tofu">TOFU</span><span class="pill mofu">MOFU</span><span class="pill bofu">BOFU</span>
          </div>
          <button type="button" class="btn ${state._calendarEditMode?'primary':''}" data-action="toggle-calendar-edit">
            ${state._calendarEditMode?ICONS.close+' Done':ICONS.edit+' Edit calendar'}
          </button>
        </div>
      </div>
      ${state._calendarEditMode?`<div class="text-[11px] text-[var(--ink3)] mb-2">Use <b class="text-[var(--ink2)]">+</b> to add a post on a day. <b class="text-[var(--ink2)]">×</b> removes a post.</div>`:''}
      ${renderMonthGrid(c, posts)}
    </div>

    ${renderAllPostsPanel(posts)}
  `;
}

function renderAllPostsPanel(posts){
  return `
    <div class="panel p-0" id="all-posts-panel">
      <div class="flex items-center justify-between p-4 flex-wrap gap-2">
        <div class="flex items-center gap-2">
          <div class="text-[12px] font-semibold text-[var(--ink2)] uppercase tracking-wider">All Posts</div>
          ${renderFilterChipCount(posts)}
        </div>
        <div class="flex items-center gap-2">
          <input class="input" id="posts-search" placeholder="Search hook, CTA, segment…" value="${esc(state._postsFilter?.q||'')}" style="width:280px;padding:6px 11px;font-size:12px"/>
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
  'tone_primary','tone_secondary','generation_meta','calendar_id',
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
  if(!post?.content_id||!briefs.length) return null;
  let matches=briefs.filter(b=>b.content_id===post.content_id);
  if(post.calendar_id)
    matches=matches.filter(b=>b.calendar_id===post.calendar_id);
  const postFormat=String(post.format||'').trim();
  if(postFormat)
    matches=matches.filter(b=>!b.format||b.format===postFormat);
  if(!matches.length) return null;
  const flagged=matches.filter(b=>b.isActive===true);
  const pool=flagged.length?flagged:matches;
  const record=pool.reduce((best,b)=>briefActivityScore(b)>briefActivityScore(best)?b:best,pool[0]);
  return normalizeBrief(record);
}

function resolvePostFormatForBrief(post){
  const plat=normalizeCalendarPlatform(post?.platform);
  const fromPost=String(post?.format||'').trim();
  if(fromPost) return {platform:plat,format:fromPost};
  const cal=state.activeCalendar;
  const plan=cal?.channelPlan;
  if(plan){
    const fmts=plan[plat]||plan[post?.platform];
    const keys=fmts?Object.keys(fmts).filter(f=>Number(fmts[f])>0):[];
    if(keys.length===1) return {platform:plat,format:keys[0]};
  }
  const fromCal=cal?.channelFormats?.[plat]||cal?.channelFormats?.[post?.platform];
  if(fromCal) return {platform:plat,format:fromCal};
  return {platform:plat,format:getDefaultChannelFormat(plat)};
}

function getBriefFormatMismatchReasons(brief){
  if(!brief?.format) return [];
  return getFormatCopyMismatchReasons({
    format:brief.format,
    hook:'',
    caption_preview:'',
    creative_direction:`${brief.script_copy||''} ${brief.visual_direction||''}`,
  });
}

function applyPostFilters(posts){
  const f = state._postsFilter || {};
  let result = posts.map((p,originalIdx)=>({...p,calendarIdx:originalIdx,_idx:originalIdx}));
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
    if(sortKey === 'evi_score' || sortKey === 'slno'){
      const nKey = sortKey === 'slno' ? 'calendarIdx' : 'evi_score';
      av = a[nKey]||0; bv = b[nKey]||0;
    }
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
    <div class="posts-table-wrap scroll">
      <table class="posts-table">
        <thead>
          <tr>
            <th class="col-num">
              <button type="button" class="th-sort" data-post-sort="slno">Sl. No. ${sortIcon('slno')}</button>
            </th>
            <th class="col-date">
              <button type="button" class="th-sort" data-post-sort="date">Date ${sortIcon('date')}</button>
            </th>
            <th class="col-platform">
              <button type="button" class="th-sort" data-post-sort="platform">Platform ${sortIcon('platform')}</button>
              ${dropdown('platform', platforms, f.platform, 'All')}
            </th>
            <th class="col-stage">
              <button type="button" class="th-sort" data-post-sort="funnel_stage">Stage ${sortIcon('funnel_stage')}</button>
              ${dropdown('funnel_stage', stages, f.funnel_stage, 'All')}
            </th>
            <th class="col-hook">
              <button type="button" class="th-sort" data-post-sort="hook">Hook / Headline ${sortIcon('hook')}</button>
            </th>
            <th class="col-format">
              <button type="button" class="th-sort" data-post-sort="format">Format ${sortIcon('format')}</button>
              ${dropdown('format', formats, f.format, 'All')}
            </th>
            <th class="col-intent">
              <button type="button" class="th-sort" data-post-sort="intent">Intent ${sortIcon('intent')}</button>
              ${dropdown('intent', intents, f.intent, 'All')}
            </th>
            <th class="col-evi">
              <button type="button" class="th-sort" data-post-sort="evi_score">EVI ${sortIcon('evi_score')}</button>
              ${dropdown('eviRange', eviRanges, f.eviRange, 'All')}
            </th>
            <th class="col-cta">
              <button type="button" class="th-sort" data-post-sort="cta">CTA ${sortIcon('cta')}</button>
            </th>
            <th class="col-actions">
              <div class="text-[10px] uppercase tracking-wider font-semibold mb-1.5" style="line-height:1.3">Generate Brief</div>
              <button type="button" class="btn primary" data-action="gen-briefs-all" style="padding:5px 10px;font-size:10.5px;white-space:nowrap;width:100%;max-width:160px;justify-content:center">${ICONS.spark} Generate All</button>
            </th>
            <th class="col-brief">Brief</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.length ? filtered.map(p=>{
            const brief=getActiveBriefForPost(p);
            const sl = (p.calendarIdx ?? p._idx ?? 0) + 1;
            return `<tr id="post-row-${p._idx}" data-post-row="${p._idx}">
            <td class="mono text-[var(--ink3)] text-center">${sl}</td>
            <td class="mono text-[var(--ink2)]">${esc(p.date||'')}</td>
            <td><span class="pill">${esc(p.platform||'')}</span></td>
            <td><span class="pill ${(p.funnel_stage||'').toLowerCase()}">${esc(p.funnel_stage||'')}</span></td>
            ${renderHookTableCell(p)}
            <td class="text-[var(--ink2)]">${esc(p.format||'')}</td>
            <td class="text-[var(--ink2)] col-intent">${esc(p.intent||'')}</td>
            <td class="col-evi"><div class="flex items-center gap-2"><span class="mono text-[12px]">${(p.evi_score||0).toFixed(1)}</span><div class="ev-bar w-14"><div class="ev-fill" style="width:${Math.min(100,(p.evi_score||0)*10)}%"></div></div></div></td>
            <td class="text-[var(--ink2)] col-cta">${esc(p.cta||'')}</td>
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
          }).join('') : `<tr><td colspan="11" class="text-center text-[var(--ink3)] py-8 text-[12px]">No posts match the current filters. <button class="text-[var(--accent)] underline ml-2" data-action="clear-post-filters">Clear filters</button></td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function renderHookTableCell(p){
  const editing = state._inlineHookEditIdx === p._idx;
  if(editing){
    const draft = state._inlineHookDraft != null ? state._inlineHookDraft : (p.hook || '');
    return `<td class="col-hook hook-cell-editing">
      <div class="hook-inline-edit">
        <input type="text" class="input hook-inline-input" data-inline-hook-input value="${esc(draft)}" placeholder="Hook / headline"/>
        <div class="hook-inline-actions">
          <button type="button" class="btn primary" style="padding:4px 10px;font-size:11px" data-action="save-inline-hook" data-post-idx="${p._idx}">Save</button>
          <button type="button" class="btn" style="padding:4px 10px;font-size:11px" data-action="cancel-inline-hook">Cancel</button>
        </div>
      </div>
    </td>`;
  }
  return `<td class="col-hook">
    <div class="hook-cell">
      <span class="hook-cell-text font-medium cursor-pointer hover:text-[var(--accent)]" data-post-detail="${p._idx}">${esc(p.hook || '')}</span>
      <button type="button" class="hook-edit-btn" data-edit-hook="${p._idx}" title="Edit hook" aria-label="Edit hook">${ICONS.edit}</button>
    </div>
  </td>`;
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

const POST_FIELD_OPTIONS = {
  platform: ['Instagram','LinkedIn','TikTok','YouTube','Facebook','X','Threads'],
  format: ['Reel','Carousel','Static','Story','Short','Long-form Video','Thread','Live','Document Post'],
  funnel_stage: ['TOFU','MOFU','BOFU'],
  intent: ['Educate','Entertain','Validate','Inspire','Convert'],
  hook_type: GUARDRAIL_HOOK_CATEGORIES,
  sentiment: ['Curious','Authoritative','Playful','Empathetic','Urgent','Inspiring'],
};

const ADD_POST_REQUIRED_FIELDS = [
  'platform','format','funnel_stage','intent','hook_type','hook','caption_preview',
  'cta','sentiment','segment','creative_direction','visual_specs','tracking_url',
];

function dayNameFromDate(dateStr){
  const d = new Date(dateStr + 'T12:00:00');
  if(Number.isNaN(d.getTime())) return '';
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
}

/** Evenly map postCount slots across numDays (first post → start, last → end of range). */
function buildEvenDateSchedule(postCount, startISO, numDays){
  if(!postCount || !numDays || !startISO) return [];
  const startD=new Date(startISO+'T12:00:00');
  if(Number.isNaN(startD.getTime())) return [];
  const schedule=[];
  for(let i=0;i<postCount;i++){
    const dayIndex=postCount===1?0:Math.min(numDays-1,Math.floor((i*numDays)/postCount));
    const d=new Date(startD);
    d.setDate(d.getDate()+dayIndex);
    const iso=d.toISOString().slice(0,10);
    schedule.push({date:iso,day:dayNameFromDate(iso)});
  }
  return schedule;
}

function applyDateScheduleToPosts(posts, schedule, startIndex=0){
  if(!posts?.length||!schedule?.length) return posts;
  posts.forEach((p,i)=>{
    const slot=schedule[startIndex+i];
    if(!slot) return;
    p.date=slot.date;
    p.day=slot.day;
  });
  return posts;
}

function renumberCalendarContentIds(posts){
  if(!posts?.length) return posts;
  const calId=posts[0]?.calendar_id||state.activeCalendar?.id||'';
  const assigned=[];
  for(const p of posts){
    p.content_id=generateContentId(p.date,p.platform,assigned,calId||undefined);
    assigned.push(p);
  }
  return posts;
}

function distributePostsAcrossCalendarDays(posts, startDate, numDays){
  if(!posts?.length||!numDays) return posts;
  const schedule=buildEvenDateSchedule(posts.length,startDate,numDays);
  applyDateScheduleToPosts(posts,schedule,0);
  return renumberCalendarContentIds(posts);
}

function buildCalendarDayRange(calendar){
  const posts = calendar?.posts || [];
  let start = calendar?.startDate;
  let numDays = Number(calendar?.days) || 0;
  const dated = posts.map(p=>p.date).filter(Boolean).sort();
  if(!start && dated.length) start = dated[0];
  if(!numDays){
    if(start && dated.length){
      const s = new Date(start + 'T12:00:00');
      const e = new Date(dated[dated.length - 1] + 'T12:00:00');
      numDays = Math.max(30, Math.round((e - s) / 86400000) + 1);
    } else numDays = 30;
  }
  if(!start) start = new Date().toISOString().slice(0, 10);
  const days = [];
  const startD = new Date(start + 'T12:00:00');
  for(let i = 0; i < numDays; i++){
    const d = new Date(startD);
    d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    days.push({ date: iso, day: dayNameFromDate(iso) });
  }
  return days;
}

function platformCode(platform){
  return ({ Instagram:'IG', LinkedIn:'LI', TikTok:'TT', YouTube:'YT', Facebook:'FB', X:'X', Threads:'TH' })[platform] || 'XX';
}

function generateContentId(date, platform, posts, calendarId){
  const d = String(date || '').replace(/-/g, '');
  const code = platformCode(platform);
  const calTag=calendarId?String(calendarId).replace(/^cal_/,'').slice(-10):'';
  const prefix=calTag?`C${calTag}_`:'';
  const sameDay=(posts||[]).filter(p=>p.platform===platform&&String(p.date||'').slice(0,10)===String(date).slice(0,10));
  return `${prefix}${d}_${code}_${String(sameDay.length+1).padStart(2,'0')}`;
}

function stampCalendarOnPosts(posts,calendarId){
  if(!posts?.length||!calendarId) return posts;
  const assigned=[];
  for(const p of posts){
    p.calendar_id=calendarId;
    lockPostSlotFields(p);
    p.content_id=generateContentId(p.date,p.platform,assigned,calendarId);
    assigned.push(p);
  }
  return posts;
}

function defaultNewPost(date, day){
  const brand = state.brands.find(b=>b.id === state.activeBrandId);
  const site = (brand?.website_url || 'example.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return {
    date,
    day,
    platform: '',
    format: '',
    funnel_stage: 'TOFU',
    intent: 'Educate',
    hook_type: 'Contrarian',
    hook: '',
    caption_preview: '',
    cta: '',
    evi_score: 7,
    sentiment: 'Curious',
    segment: '',
    creative_direction: '',
    visual_specs: '',
    tracking_url: `https://${site}/?utm_source=PLAT&utm_medium=FORMAT&utm_campaign=manual`,
    status: 'Draft',
  };
}

function openAddPostModal(date, day){
  state._newPost = defaultNewPost(date, day);
  openModal({ kind:'add-post', data: { date, day } });
}

function readNewPostFromForm(){
  const base = state._newPost ? { ...state._newPost } : {};
  document.querySelectorAll('[data-new-post-field]').forEach(el=>{
    const k = el.dataset.newPostField;
    if(!k) return;
    if(el.type === 'number') base[k] = el.value === '' ? '' : Number(el.value);
    else base[k] = el.value;
  });
  return base;
}

function validateNewPost(p){
  for(const k of ADD_POST_REQUIRED_FIELDS){
    if(!String(p[k] ?? '').trim()) return k;
  }
  const ev = Number(p.evi_score);
  if(p.evi_score === '' || p.evi_score == null || Number.isNaN(ev)) return 'evi_score';
  if(ev < 0 || ev > 10) return 'evi_score';
  return null;
}

function newPostFieldLabel(key){
  return ({
    platform:'Platform', format:'Format', funnel_stage:'Funnel stage', intent:'Intent',
    hook_type:'Hook type', hook:'Hook / headline', caption_preview:'Caption preview', cta:'CTA',
    sentiment:'Sentiment', segment:'Segment', creative_direction:'Creative direction',
    visual_specs:'Visual specs', tracking_url:'Tracking URL', evi_score:'EVI score',
  })[key] || key;
}

function renderNewPostSelect(field, label, p){
  const opts = POST_FIELD_OPTIONS[field] || [];
  const val = p[field] || '';
  return `<div>
    <label class="label">${label} *</label>
    <select class="select" data-new-post-field="${field}" required>
      <option value="">— Select —</option>
      ${opts.map(o=>`<option value="${esc(o)}" ${val===o?'selected':''}>${esc(o)}</option>`).join('')}
    </select>
  </div>`;
}

function renderAddPostModal(m){
  const p = state._newPost || defaultNewPost(m.data?.date, m.data?.day);
  return `<div class="modal-backdrop" data-close-modal>
    <div class="panel p-6 w-full max-w-3xl max-h-[92vh] overflow-auto scroll" onclick="event.stopPropagation()">
      <div class="flex items-start justify-between mb-4 gap-3">
        <div>
          <div class="text-[16px] font-semibold">Add post</div>
          <div class="text-[12px] text-[var(--ink3)] mt-0.5">${esc(m.data?.day||'')} · ${esc(m.data?.date||'')} · All fields required</div>
        </div>
        <button type="button" class="btn ghost" data-close-modal>${ICONS.close}</button>
      </div>

      <div class="grid grid-cols-2 gap-3 mb-3">
        ${renderNewPostSelect('platform', 'Platform', p)}
        ${renderNewPostSelect('format', 'Format', p)}
        ${renderNewPostSelect('funnel_stage', 'Stage', p)}
        ${renderNewPostSelect('intent', 'Intent', p)}
        ${renderNewPostSelect('hook_type', 'Hook type', p)}
        ${renderNewPostSelect('sentiment', 'Sentiment', p)}
      </div>

      <div class="mb-3">
        <label class="label">Hook / headline *</label>
        <input class="input" data-new-post-field="hook" value="${esc(p.hook||'')}" required/>
      </div>
      <div class="mb-3">
        <label class="label">Caption preview *</label>
        <textarea class="textarea" data-new-post-field="caption_preview" required style="min-height:72px">${esc(p.caption_preview||'')}</textarea>
      </div>
      <div class="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label class="label">CTA *</label>
          <input class="input" data-new-post-field="cta" value="${esc(p.cta||'')}" required/>
        </div>
        <div>
          <label class="label">Segment *</label>
          <input class="input" data-new-post-field="segment" value="${esc(p.segment||'')}" required/>
        </div>
        <div>
          <label class="label">EVI score *</label>
          <input class="input mono" type="number" step="0.1" min="0" max="10" data-new-post-field="evi_score" value="${p.evi_score ?? 7}" required/>
        </div>
        <div>
          <label class="label">Status</label>
          <input class="input" data-new-post-field="status" value="${esc(p.status||'Draft')}"/>
        </div>
        <div class="col-span-2">
          <label class="label">Tracking URL *</label>
          <input class="input" data-new-post-field="tracking_url" value="${esc(p.tracking_url||'')}" required/>
        </div>
      </div>
      <div class="mb-3">
        <label class="label">Creative direction *</label>
        <textarea class="textarea" data-new-post-field="creative_direction" required style="min-height:64px">${esc(p.creative_direction||'')}</textarea>
      </div>
      <div class="mb-3">
        <label class="label">Visual specs *</label>
        <textarea class="textarea" data-new-post-field="visual_specs" required style="min-height:64px">${esc(p.visual_specs||'')}</textarea>
      </div>

      <div class="flex justify-end gap-2 pt-4 border-t border-[var(--line)]">
        <button type="button" class="btn" data-action="cancel-add-post">Cancel</button>
        <button type="button" class="btn primary" data-action="save-new-post">${ICONS.spark} Save post</button>
      </div>
    </div>
  </div>`;
}

async function saveNewPost(){
  if(!state.activeCalendar) return;
  const draft = readNewPostFromForm();
  draft.date = state._newPost?.date || draft.date;
  draft.day = state._newPost?.day || dayNameFromDate(draft.date);
  const missing = validateNewPost(draft);
  if(missing){
    showToast(`Please fill in: ${newPostFieldLabel(missing)}`, 'err');
    return;
  }
  const cal = state.activeCalendar;
  if(!cal.brandId) cal.brandId = state.activeBrandId;
  const post = {
    ...draft,
    evi_score: Number(draft.evi_score),
    content_id: generateContentId(draft.date, draft.platform, cal.posts || [], cal.id),
    savedAt: Date.now(),
  };
  cal.posts = cal.posts || [];
  cal.posts.push(post);
  cal.posts.sort((a,b)=>(a.date||'').localeCompare(b.date||'') || (a.platform||'').localeCompare(b.platform||''));
  const contentId = post.content_id;
  try{
    await Store.saveCalendar(cal.brandId || state.activeBrandId, cal);
    state.calendars = await Store.listCalendars(cal.brandId || state.activeBrandId);
    state.activeCalendar = state.calendars.find(c=>c.id === cal.id) || cal;
    state._newPost = null;
    clearModalState();
    render();
    showToast('Post added to calendar', 'ok');
    const idx = (state.activeCalendar.posts || []).findIndex(p=>p.content_id === contentId);
    if(idx >= 0) setTimeout(()=>scrollToPostRow(idx), 400);
  }catch(e){
    cal.posts = cal.posts.filter(p=>p !== post);
    showToast('Save failed: ' + e.message, 'err');
  }
}

function renderMonthGrid(calendar, posts){
  const editMode = !!state._calendarEditMode;
  const days = buildCalendarDayRange(calendar);
  const byDate = {};
  (posts || []).forEach((p, idx)=>{
    const k = (p.date || '').slice(0, 10);
    if(!k) return;
    (byDate[k] = byDate[k] || []).push({ post:p, idx });
  });
  if(!days.length) return '<div class="empty">No calendar range to display.</div>';
  let html = '<div class="grid grid-cols-7 gap-2">';
  for(const slot of days){
    const d = slot.date;
    const day = new Date(d + 'T12:00:00');
    const dayLabel = Number.isNaN(day.getTime()) ? d : day.getDate();
    const dow = slot.day || dayNameFromDate(d);
    const items = byDate[d] || [];
    html += `<div class="day-cell">
      <div class="day-cell-head">
        <div class="dnum">${esc(dow)} ${esc(String(dayLabel))}</div>
        ${editMode?`<button type="button" class="day-add-btn" data-add-post-date="${esc(d)}" title="Add post on ${esc(d)}">+</button>`:''}
      </div>`;
    items.slice(0, editMode ? 8 : 4).forEach(({ post:p, idx })=>{
      const label = `<b>${esc(p.platform||'')}</b> · ${esc(truncate(p.hook||'', editMode ? 28 : 38))}`;
      if(editMode){
        html += `<div class="post post-cal-row ${(p.funnel_stage||'').toLowerCase()}">
          <div class="post-cal-body" title="${esc(p.hook||'')}">${label}</div>
          <button type="button" class="post-edit-hook-btn" data-edit-hook="${idx}" title="Edit hook">${ICONS.edit}</button>
          <button type="button" class="post-del-btn" data-delete-post-idx="${idx}" title="Delete post">${ICONS.trash}</button>
        </div>`;
      }else{
        html += `<div class="post post-cal-click ${(p.funnel_stage||'').toLowerCase()}" data-scroll-to-post="${idx}" role="button" tabindex="0" title="View in All Posts table">${label}</div>`;
      }
    });
    const cap = editMode ? 8 : 4;
    if(items.length > cap) html += `<div class="text-[10px] text-[var(--ink3)] mt-1">+${items.length - cap} more</div>`;
    html += '</div>';
  }
  html += '</div>';
  return html;
}

async function deleteCalendarPost(postIdx){
  const cal = state.activeCalendar;
  if(!cal?.posts || postIdx < 0 || postIdx >= cal.posts.length) return;
  const post = cal.posts[postIdx];
  const label = truncate(post.hook || post.platform || 'this post', 80);
  openModal({
    kind:'confirm',
    title:'Delete post?',
    body:`Remove "${label}" from this calendar? This cannot be undone.`,
    danger:true,
    confirmLabel:'Delete',
    onYes: async ()=>{
      const contentId = post.content_id;
      cal.posts.splice(postIdx, 1);
      if(!cal.brandId) cal.brandId = state.activeBrandId;
      try{
        await Store.saveCalendar(cal.brandId, cal);
        state.calendars = await Store.listCalendars(cal.brandId);
        state.activeCalendar = state.calendars.find(c=>c.id === cal.id) || cal;
        clearModalState();
        render();
        showToast('Post removed', 'ok');
      }catch(e){
        showToast('Delete failed: ' + e.message, 'err');
      }
    },
  });
}

/* ----- BRIEFS LIBRARY ----- */
function renderBriefsView(){
  const all=state.allBriefs||[];
  if(!all.length){
    return `<div class="panel empty">
      <div class="text-[14px] font-semibold mb-1 text-[var(--ink)]">No briefs yet</div>
      <div class="text-[12px] mb-4">Generate a calendar, then use <b class="text-[var(--ink2)]">Generate All Briefs</b> on a post to populate this library.</div>
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
  if(!isBrandProfileComplete(brand)){
    return renderIncompleteBrandBanner(brand);
  }
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

async function drawAnalyticsOnce(){
  if(state.view!=='analytics') return;
  const key=`${state.brands.length}:${(state.brands||[]).map(b=>b.id).sort().join(',')}`;
  const stats=document.getElementById('analytics-stats');
  if(_analyticsKey===key && stats?.children?.length) return;
  _analyticsKey=key;
  await drawAnalytics();
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
  if(m.kind==='add-post') return renderAddPostModal(m);
  if(m.kind==='view-brief') return renderBriefDetailModal(m);
  if(m.kind==='confirm') return renderConfirmModal(m);
  if(m.kind==='loading') return renderLoadingModal(m);
  if(m.kind==='error') return renderErrorModal(m);
  return '';
}

const BRAND_LANGUAGE_OPTIONS=[
  'US English','UK English','Australian English','Canadian English','New Zealand English',
  'Indian English','Singapore English','South African English','Middle East English','Global English',
];

function buildBrandContextBlock(brand){
  if(!brand) return '';
  const lang=brand.brand_language||'Global English';
  const tone=brand.brand_tone||brand.brand_tone_personality||brand.brand_voice||'-';
  const personality=brand.brand_personality||'-';
  const voiceExtra=brand.brand_voice?`\n- Additional Voice Notes: ${brand.brand_voice}`:'';
  return `# BRAND PROFILE (from brand setup — every post must reflect this)
- Brand Name: ${brand.name||'-'}
- Website: ${brand.website_url||'-'}
- Vertical / Sub-segment: ${brand.vertical||'-'}
- Location: ${brand.location||'-'}
- Business Model: ${brand.business_model||'B2C'}
- Price Tier: ${brand.price_sensitivity_tier||'Mid-Market'}
- Purchase Cycle: ${brand.purchase_cycle_length||'-'}
- Avg Transaction Value: ${brand.avg_transaction_value||'-'}
- Time Horizon: ${brand.time_horizon||'30'} days
- Target Customer Profile: ${brand.target_customer_profile||'-'}
- Growth Objective: ${brand.growth_objective||'-'}
- Product / Placement Context: ${brand.product_placement_context||'Lead Gen'}
- Brand Tone: ${tone}
- Brand Personality: ${personality}
- Brand Language: ${lang} (MANDATORY — all hooks, captions, and CTAs must use this locale: spelling, idioms, date/number formats, cultural references)${voiceExtra}`;
}

function renderBrandContextPreview(brand){
  const rows=[
    ['Target customer', brand.target_customer_profile],
    ['Growth objective', brand.growth_objective],
    ['Vertical', brand.vertical],
    ['Location', brand.location],
    ['Business model', brand.business_model],
    ['Brand tone', brand.brand_tone||brand.brand_tone_personality],
    ['Brand personality', brand.brand_personality],
    ['Language', brand.brand_language],
    ['Voice notes', brand.brand_voice],
  ].filter(([,v])=>String(v||'').trim());
  if(!rows.length) return '';
  return `<div class="panel2 p-3 mb-1">
    <div class="text-[10px] uppercase tracking-wider text-[var(--ink3)] font-semibold mb-2">Brand profile used for generation</div>
    <div class="space-y-1.5 text-[11.5px] text-[var(--ink2)] leading-relaxed">
      ${rows.map(([k,v])=>`<div><span class="text-[var(--ink3)]">${esc(k)}:</span> ${esc(String(v).slice(0,200))}${String(v).length>200?'…':''}</div>`).join('')}
    </div>
  </div>`;
}

function renderBrandFormModal(m){
  const b=m.data||{};
  const reqLabel=(text)=>`<label class="label">${esc(text)}<span class="req-asterisk" aria-hidden="true">*</span></label>`;
  const optLabel=(text)=>`<label class="label">${esc(text)}</label>`;
  return `<div class="modal-backdrop" data-close-modal>
    <div class="panel p-6 w-full max-w-3xl max-h-[88vh] overflow-auto" onclick="event.stopPropagation()">
      <div class="flex items-center justify-between mb-5">
        <div>
          <div class="text-[16px] font-semibold">${b.id?'Edit Brand':'New Brand'}</div>
          <div class="text-[11.5px] text-[var(--ink3)]">Fields marked with <span class="req-asterisk">*</span> are required${b.id && !isBrandProfileComplete(b)?' — this brand still has missing required fields':''}</div>
        </div>
        <button class="btn ghost" data-close-modal>${ICONS.close}</button>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>${reqLabel('Brand Name')}<input class="input" id="f-name" data-brand-required value="${esc(b.name||'')}" placeholder="Acme Brands" required/></div>
        <div>${optLabel('Website URL')}<input class="input" id="f-website_url" value="${esc(b.website_url||'')}" placeholder="https://acme.com"/></div>
        <div>${optLabel('Vertical / Sub-segment')}<input class="input" id="f-vertical" value="${esc(b.vertical||'')}" placeholder="D2C protein supplements"/></div>
        <div>${optLabel('Location (Country → City)')}<input class="input" id="f-location" value="${esc(b.location||'')}" placeholder="India → Bangalore"/></div>
        <div>${optLabel('Business Model')}<select class="select" id="f-business_model">${['B2B','B2C','B2G','D2C','Marketplace'].map(o=>`<option ${o===(b.business_model||'B2C')?'selected':''}>${o}</option>`).join('')}</select></div>
        <div>${optLabel('Price Tier')}<select class="select" id="f-price_sensitivity_tier">${['Premium','Mid-Market','Value','Discount'].map(o=>`<option ${o===(b.price_sensitivity_tier||'Mid-Market')?'selected':''}>${o}</option>`).join('')}</select></div>
        <div>${optLabel('Purchase Cycle')}<input class="input" id="f-purchase_cycle_length" value="${esc(b.purchase_cycle_length||'')}" placeholder="14 days / 3 months"/></div>
        <div>${optLabel('Avg Transaction Value')}<input class="input" id="f-avg_transaction_value" value="${esc(b.avg_transaction_value||'')}" placeholder="₹1,800 AOV"/></div>
        <div>${optLabel('Time Horizon')}<select class="select" id="f-time_horizon">${['30','60','90','180','365'].map(o=>`<option value="${o}" ${o===String(b.time_horizon||'30')?'selected':''}>${o} days</option>`).join('')}</select></div>
        <div class="md:col-span-2">${reqLabel('Target Customer Profile')}<textarea class="textarea" id="f-target_customer_profile" data-brand-required placeholder="Demographics + psychographics + decision role" required>${esc(b.target_customer_profile||'')}</textarea></div>
        <div class="md:col-span-2">${reqLabel('Growth Objective')}<textarea class="textarea" id="f-growth_objective" data-brand-required placeholder="2x leads in 90 days from Bangalore + Mumbai" required>${esc(b.growth_objective||'')}</textarea></div>
        <div class="md:col-span-2">${reqLabel('Brand Tone')}<textarea class="textarea" id="f-brand_tone" data-brand-required placeholder="e.g. Bold, witty, authoritative, warm, playful — how the brand sounds" required style="min-height:64px">${esc(b.brand_tone||b.brand_tone_personality||'')}</textarea></div>
        <div class="md:col-span-2">${reqLabel('Brand Personality')}<textarea class="textarea" id="f-brand_personality" data-brand-required placeholder="e.g. The savvy friend, the trusted expert, the rebel challenger — who the brand is" required style="min-height:64px">${esc(b.brand_personality||'')}</textarea></div>
        <div>${reqLabel('Brand Language')}<select class="select" id="f-brand_language" data-brand-required required>
          <option value="" ${!b.brand_language?'selected':''} disabled>Select language…</option>
          ${BRAND_LANGUAGE_OPTIONS.map(o=>`<option value="${esc(o)}" ${o===(b.brand_language||'')?'selected':''}>${esc(o)}</option>`).join('')}
        </select></div>
        <div>${optLabel('Product Placement Context')}<select class="select" id="f-product_placement_context">${['E-comm','Lead Gen','App Install','Retail Pickup','B2B Sales'].map(o=>`<option ${o===(b.product_placement_context||'Lead Gen')?'selected':''}>${o}</option>`).join('')}</select></div>
        <div>${optLabel('Additional Voice Notes')}<input class="input" id="f-brand_voice" value="${esc(b.brand_voice||'')}" placeholder="Optional extra nuance beyond tone & personality"/></div>
      </div>
      <div class="flex justify-end gap-2 mt-6">
        <button type="button" class="btn" data-close-modal ${state._saveBrandInFlight?'disabled':''}>Cancel</button>
        <button type="button" class="btn primary" data-action="save-brand" ${state._saveBrandInFlight?'disabled':''}>${state._saveBrandInFlight?'Saving…':(b.id?'Save Changes':'Create Brand')}</button>
      </div>
    </div>
  </div>`;
}

const CALENDAR_CONTENT_DIRECTION_FIELD={id:'g-content-direction',message:'Content direction is required — describe what this calendar should achieve.'};

/** Platform → post format options (value = stored in post.format for generation) */
const CHANNEL_FORMAT_OPTIONS={
  Instagram:[
    {label:'Reel',value:'Reel'},{label:'Carousel',value:'Carousel'},{label:'Static Post',value:'Static'},
    {label:'Story',value:'Story'},{label:'Live',value:'Live'},
  ],
  Facebook:[
    {label:'Reel',value:'Reel'},{label:'Video Post',value:'Reel'},{label:'Carousel',value:'Carousel'},
    {label:'Static Post',value:'Static'},{label:'Story',value:'Story'},{label:'Live',value:'Live'},
  ],
  LinkedIn:[
    {label:'Document Post',value:'Document Post'},{label:'Carousel',value:'Carousel'},{label:'Static Post',value:'Static'},
    {label:'Video',value:'Reel'},{label:'Live',value:'Live'},{label:'Newsletter Article',value:'Long-form Video'},
  ],
  YouTube:[
    {label:'Short',value:'Short'},{label:'Long-form Video',value:'Long-form Video'},
    {label:'Community Post',value:'Static'},{label:'Live Stream',value:'Live'},
  ],
  TikTok:[
    {label:'Video',value:'Reel'},{label:'Story',value:'Story'},{label:'Live',value:'Live'},
  ],
  X:[
    {label:'Post',value:'Static'},{label:'Thread',value:'Thread'},{label:'Video',value:'Reel'},
    {label:'Poll',value:'Static'},{label:'Space (Live)',value:'Live'},
  ],
  Threads:[
    {label:'Text Post',value:'Static'},{label:'Carousel',value:'Carousel'},{label:'Video',value:'Reel'},
    {label:'Reply Thread',value:'Thread'},
  ],
};

const CALENDAR_PLATFORM_ORDER=['Instagram','Facebook','LinkedIn','YouTube','TikTok','X','Threads'];

const PLATFORM_CANONICAL={
  instagram:'Instagram',ig:'Instagram',
  facebook:'Facebook',fb:'Facebook',
  linkedin:'LinkedIn',li:'LinkedIn',
  youtube:'YouTube',yt:'YouTube',
  tiktok:'TikTok',tt:'TikTok',
  twitter:'X',x:'X',
  threads:'Threads',th:'Threads',
};

function normalizeCalendarPlatform(platform){
  const raw=String(platform||'').trim();
  if(!raw) return raw;
  const hit=CALENDAR_PLATFORM_ORDER.find(p=>p.toLowerCase()===raw.toLowerCase());
  if(hit) return hit;
  const key=raw.toLowerCase().replace(/[^a-z0-9]/g,'');
  return PLATFORM_CANONICAL[key]||raw;
}

function getDefaultChannelFormat(platform){
  return CHANNEL_FORMAT_OPTIONS[platform]?.[0]?.value||'Reel';
}

function getChanPlanDefaults(businessModel){
  const bm=businessModel||'B2C';
  const plans={
    B2B:{LinkedIn:{'Document Post':8,'Carousel':4,'Reel':3},YouTube:{Short:4,'Long-form Video':2},X:{Thread:4,Static:4},Instagram:{Reel:2,Carousel:2}},
    B2C:{Instagram:{Reel:8,Carousel:4,Story:2},TikTok:{Reel:10},YouTube:{Short:3,'Long-form Video':2},Facebook:{Reel:3,Carousel:2},X:{Thread:2,Static:1},Threads:{Static:2,Carousel:1}},
    D2C:{Instagram:{Reel:10,Carousel:4,Story:2},TikTok:{Reel:10},YouTube:{Short:3,'Long-form Video':2},Facebook:{Reel:3,Carousel:1},Threads:{Carousel:3,Reel:2}},
    B2G:{LinkedIn:{'Document Post':8,Carousel:4,Static:2},Facebook:{Carousel:4,Reel:4},X:{Thread:4,Static:2},YouTube:{Short:3,'Long-form Video':1},Instagram:{Carousel:2,Reel:2}},
    Marketplace:{Instagram:{Reel:8,Carousel:4},TikTok:{Reel:6},YouTube:{Short:2,'Long-form Video':2},Facebook:{Carousel:3,Reel:3},LinkedIn:{Carousel:2,'Document Post':2},X:{Thread:2,Static:2}},
  };
  return JSON.parse(JSON.stringify(plans[bm]||plans.B2C));
}

function migrateLegacyChanToPlan(){
  const plan={};
  const sel=state._chanSel||{};
  const fmts=state._chanFormats||{};
  for(const [platform,count] of Object.entries(sel)){
    const n=Number(count)||0;
    if(n>0) plan[platform]={[fmts[platform]||getDefaultChannelFormat(platform)]:n};
  }
  return plan;
}

function ensureChanPlanState(){
  if(state._chanPlan) return state._chanPlan;
  if(state._chanSel&&Object.values(state._chanSel).some(v=>Number(v)>0)){
    state._chanPlan=migrateLegacyChanToPlan();
    return state._chanPlan;
  }
  const brand=state.brands.find(b=>b.id===state.activeBrandId);
  state._chanPlan=getChanPlanDefaults(brand?.business_model);
  return state._chanPlan;
}

function platformTotalFromPlan(plan,platform){
  const fmts=plan?.[platform]||{};
  return Object.values(fmts).reduce((s,v)=>s+(Number(v)||0),0);
}

function getTotalPostsFromPlan(plan){
  return Object.keys(plan||{}).reduce((s,p)=>s+platformTotalFromPlan(plan,p),0);
}

function activePlatformCountFromPlan(plan){
  return Object.keys(plan||{}).filter(p=>platformTotalFromPlan(plan,p)>0).length;
}

function slotKey(platform,format){
  return `${normalizeCalendarPlatform(platform)}|${format}`;
}

function parseChanPlatformFormat(key){
  const s=String(key||'');
  const sep=s.indexOf('|');
  if(sep<0) return {platform:'',format:''};
  return {platform:s.slice(0,sep),format:s.slice(sep+1)};
}

function sanitizeChanPlan(plan){
  const out={};
  for(const [platform,fmts] of Object.entries(plan||{})){
    const row={};
    for(const [format,count] of Object.entries(fmts||{})){
      const n=Math.max(0,Math.min(999,Number(count)||0));
      if(n>0) row[format]=n;
    }
    if(Object.keys(row).length) out[platform]=row;
  }
  return out;
}

function buildChannelEntries(plan){
  const entries=[];
  const seen=new Set();
  for(const platform of CALENDAR_PLATFORM_ORDER){
    const fmts=plan?.[platform];
    if(!fmts) continue;
    for(const [format,count] of Object.entries(fmts)){
      const n=Number(count)||0;
      if(n>0){
        entries.push({platform,format,count:n});
        seen.add(platform);
      }
    }
  }
  for(const [platform,fmts] of Object.entries(plan||{})){
    if(seen.has(platform)) continue;
    for(const [format,count] of Object.entries(fmts)){
      const n=Number(count)||0;
      if(n>0) entries.push({platform:normalizeCalendarPlatform(platform),format,count:n});
    }
  }
  return entries;
}

function buildPostSlotsFromEntries(entries){
  const slots=[];
  for(const e of entries||[]){
    for(let i=0;i<e.count;i++) slots.push({platform:e.platform,format:e.format});
  }
  return slots;
}

function activeFormatsForPlatform(plan,platform){
  const fmts=plan?.[platform]||{};
  return new Set(
    Object.entries(fmts).filter(([,c])=>Number(c)>0).map(([format])=>format)
  );
}

function pruneChanPlatformZeros(plan,platform){
  const fmts=plan?.[platform];
  if(!fmts) return;
  for(const [format,count] of Object.entries(fmts)){
    if(!(Number(count)>0)) delete fmts[format];
  }
  if(!Object.keys(fmts).length) delete plan[platform];
}

function nextUnusedFormatForPlatform(plan,platform){
  const used=activeFormatsForPlatform(plan,platform);
  const opts=CHANNEL_FORMAT_OPTIONS[platform]||[];
  return opts.find(o=>!used.has(o.value))||null;
}

function captureChanPlanFromUI(){
  const plan={};
  const root=document.getElementById('modal-host')||document;
  root.querySelectorAll('[data-chan-fmt-input]').forEach(inp=>{
    const {platform,format}=parseChanPlatformFormat(inp.dataset.chanFmtInput);
    const n=Math.max(0,Math.min(999,Number(inp.value)||0));
    if(!platform||!format) return;
    if(n>0){
      if(!plan[platform]) plan[platform]={};
      plan[platform][format]=n;
    }
  });
  const captured=sanitizeChanPlan(plan);
  const fallback=sanitizeChanPlan(ensureChanPlanState());
  const merged=Object.keys(captured).length?captured:fallback;
  state._chanPlan=merged;
  return merged;
}

function summarizeCalendarGenerationPlan(chanPlan,days,contentDirection){
  const lines=[];
  for(const e of buildChannelEntries(chanPlan)){
    const label=CHANNEL_FORMAT_OPTIONS[e.platform]?.find(o=>o.value===e.format)?.label||e.format;
    lines.push(`${e.platform} ${e.count}× ${label}`);
  }
  const dir=String(contentDirection||'').trim();
  return [
    `${getTotalPostsFromPlan(chanPlan)} posts · ${days} days · ${activePlatformCountFromPlan(chanPlan)} platforms`,
    lines.length?lines.join(' · '):'',
    dir?`Direction: ${dir.slice(0,120)}${dir.length>120?'…':''}`:'',
  ].filter(Boolean).join('\n');
}

/** Distribute each platform+format count across day-chunks (largest remainder — never all-zero when total > 0). */
function buildCalendarBatches(fullEntries,days,start,chunkSize=6){
  const numChunks=Math.max(1,Math.ceil(days/chunkSize));
  const chunks=[];
  for(let i=0;i<numChunks;i++){
    const dayOffset=i*chunkSize;
    const length=Math.min(chunkSize,days-dayOffset);
    const sd=new Date(start);
    sd.setDate(sd.getDate()+dayOffset);
    chunks.push({
      startDay:dayOffset+1,
      endDay:Math.min(dayOffset+chunkSize,days),
      startDate:sd.toISOString().slice(0,10),
      length,
      entries:[],
      total:0,
    });
  }

  for(const entry of fullEntries||[]){
    const total=Number(entry.count)||0;
    if(total<=0) continue;
    const weights=chunks.map(c=>c.length/days);
    const raw=weights.map(w=>w*total);
    const floors=raw.map(r=>Math.floor(r));
    let remainder=total-floors.reduce((s,n)=>s+n,0);
    const counts=[...floors];
    const order=raw.map((r,i)=>({i,frac:r-floors[i]})).sort((a,b)=>b.frac-a.frac);
    for(let k=0;remainder>0&&k<order.length;k++){
      counts[order[k%order.length].i]++;
      remainder--;
    }
    counts.forEach((count,ci)=>{
      if(count<=0) return;
      const ch=chunks[ci];
      let row=ch.entries.find(e=>e.platform===entry.platform&&e.format===entry.format);
      if(!row){
        row={platform:entry.platform,format:entry.format,count:0};
        ch.entries.push(row);
      }
      row.count+=count;
      ch.total+=count;
    });
  }

  const planned=fullEntries.reduce((s,e)=>s+(Number(e.count)||0),0);
  const allocated=chunks.reduce((s,c)=>s+c.total,0);
  if(planned>0&&allocated===0){
    const first=chunks[0];
    for(const entry of fullEntries){
      if(!entry.count) continue;
      first.entries.push({platform:entry.platform,format:entry.format,count:entry.count});
      first.total+=entry.count;
    }
    for(let i=1;i<chunks.length;i++){
      chunks[i].entries=[];
      chunks[i].total=0;
    }
  }

  return chunks;
}

function buildFormatContentGuidanceFromPlan(plan){
  const lines=[];
  for(const e of buildChannelEntries(plan||{})){
    const guide=FORMAT_COPY_GUIDANCE[e.format];
    if(guide) lines.push(`- **${e.platform} · ${e.format}** (${e.count} posts): ${guide}`);
  }
  if(!lines.length) return '';
  return `# FORMAT CONTENT GUIDANCE (MANDATORY)
${lines.join('\n')}
Each post must use the structure for its assigned platform + format.`;
}

function renderChanFormatLines(platform,plan){
  pruneChanPlatformZeros(plan,platform);
  const fmts=plan[platform]||{};
  const entries=Object.entries(fmts).filter(([,c])=>Number(c)>0);
  if(!entries.length) return '';
  const opts=CHANNEL_FORMAT_OPTIONS[platform]||[];
  return `<div class="chan-format-lines space-y-1 mt-1 mb-1">
    ${entries.map(([format,count])=>{
      const optHtml=opts.map(o=>`<option value="${esc(o.value)}" ${o.value===format?'selected':''}>${esc(o.label)}</option>`).join('');
      return `<div class="chan-format-line flex items-center gap-1.5 flex-wrap" data-chan-format-row="${esc(platform)}">
        <select class="select chan-format-select" data-chan-format-pick="${esc(platform)}" data-chan-format-was="${esc(format)}" style="min-width:118px;max-width:140px">${optHtml}</select>
        <button class="stepper" data-chan-fmt-step="${esc(platform)}|${esc(format)}|-1" ${count<=0?'disabled':''}>−</button>
        <input class="stepper-input" type="number" min="0" max="999" value="${count}" data-chan-fmt-input="${esc(platform)}|${esc(format)}"/>
        <button class="stepper" data-chan-fmt-step="${esc(platform)}|${esc(format)}|1">+</button>
        <button type="button" class="btn ghost chan-remove-fmt" data-chan-remove-format="${esc(platform)}|${esc(format)}" title="Remove format" ${entries.length<=1?'disabled':''}>×</button>
      </div>`;
    }).join('')}
    ${nextUnusedFormatForPlatform(plan,platform)?`<button type="button" class="btn ghost text-[11px] mt-0.5" style="padding:4px 10px" data-chan-add-format="${esc(platform)}">+ Add format</button>`:''}
  </div>`;
}

function applyBatchPostSlots(posts,batchEntries,dateSchedule){
  const slots=buildPostSlotsFromEntries(batchEntries);
  if(!slots.length) return posts;

  const buckets={};
  for(const p of posts){
    const k=slotKey(p.platform,p.format);
    if(!buckets[k]) buckets[k]=[];
    buckets[k].push(p);
  }

  const used=new Set();
  const takeForSlot=(platform,format)=>{
    const k=slotKey(platform,format);
    for(const p of buckets[k]||[]){
      if(!used.has(p)){ used.add(p); return p; }
    }
    for(const p of posts){
      if(!used.has(p)){ used.add(p); return p; }
    }
    return null;
  };

  const result=[];
  let dateIdx=0;
  for(const slot of slots){
    const p=takeForSlot(slot.platform,slot.format);
    if(!p) continue;
    p.platform=slot.platform;
    p.format=slot.format;
    if(dateSchedule?.[dateIdx]){
      p.date=dateSchedule[dateIdx].date;
      p.day=dateSchedule[dateIdx].day;
    }
    dateIdx++;
    result.push(p);
  }

  return renumberCalendarContentIds(result);
}

const FORMAT_COPY_GUIDANCE={
  Reel:'Vertical video (9:16). Hook in first 1–2 seconds / first line. Caption supports watch completion; mention on-screen text, pacing, pattern interrupt. creative_direction = shots, b-roll, text overlays, length ~15–60s.',
  Short:'YouTube Short / vertical teaser. Ultra-tight hook, one idea, fast cuts, loop-friendly ending. creative_direction = 9:16, under 60s, thumb-stop first frame.',
  Carousel:'Multi-slide swipe post. Hook = slide 1 headline. caption_preview teases slide 2; creative_direction lists 5–10 slide titles + one-line payoff per slide.',
  Static:'Single image or text post. Hook + caption carry the message; creative_direction = layout, headline on image, visual metaphor.',
  Story:'Ephemeral 9:16 frames (3–7 beats). Urgency, stickers, poll, swipe-up CTA. Short punchy lines; creative_direction = frame-by-frame sequence.',
  Thread:'Numbered or chained posts (X/Threads). Hook = tweet 1; caption_preview = thread arc; creative_direction = outline each post in the chain.',
  'Document Post':'LinkedIn document/PDF carousel. Professional, slide-by-slide thought leadership; creative_direction = doc title + section headers.',
  'Long-form Video':'YouTube long-form. Hook promises payoff; caption_preview = chapters/value; creative_direction = intro, sections, B-roll, runtime hint.',
  Live:'Live stream / Space / Live badge. Promote time, topic, guest; hook = why attend now; CTA = reminder, notify, register.',
};

function buildFormatContentGuidanceSection(channelFormats){
  const lines=[];
  for(const [platform,fmt] of Object.entries(channelFormats||{})){
    const guide=FORMAT_COPY_GUIDANCE[fmt];
    if(guide) lines.push(`- **${platform}** (format: ${fmt}): ${guide}`);
  }
  if(!lines.length) return '';
  return `# FORMAT CONTENT GUIDANCE (MANDATORY — copy must match selected type, not generic posts)
${lines.join('\n')}
For each post: hook, caption_preview, and creative_direction MUST read like the format above (Reel ≠ Carousel ≠ Static ≠ Thread). Do not write carousel slide copy for a Reel or a blog-style caption for a Short.`;
}

const GENERATE_CAL_CHANNELS=[
  {key:'Instagram', icon:'📷', color:'#e1306c'},
  {key:'Facebook',  icon:'👤', color:'#1877f2'},
  {key:'LinkedIn',  icon:'💼', color:'#0a66c2'},
  {key:'YouTube',   icon:'▶',  color:'#ff0000'},
  {key:'TikTok',    icon:'♪',  color:'#fff'},
  {key:'X',         icon:'𝕏',  color:'#fff'},
  {key:'Threads',   icon:'@',  color:'#fff'},
];

function renderGenerateCalendarChannelRow(c,plan){
  const platformTotal=platformTotalFromPlan(plan,c.key);
  const active=platformTotal>0;
  return `
  <div class="rounded-lg p-2 ${active?'channel-row-active':'channel-row'}" data-chan-row="${c.key}">
    <div class="flex items-center gap-3">
      <label class="flex items-center gap-2.5 flex-1 cursor-pointer min-w-0" data-chan-toggle="${c.key}">
        <span class="custom-checkbox ${active?'checked':''}">
          ${active?'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3.5"><path d="M5 12l5 5L20 7"/></svg>':''}
        </span>
        <span class="w-6 h-6 rounded-md flex items-center justify-center text-[12px] shrink-0" style="background:${c.color};color:${c.key==='TikTok'||c.key==='X'||c.key==='Threads'?'#000':'#fff'}">${c.icon}</span>
        <span class="text-[13px] font-medium ${active?'text-[var(--ink)]':'text-[var(--ink2)]'}">${c.key}</span>
        ${active?`<span class="text-[11px] text-[var(--ink3)] mono ml-1">${platformTotal} posts</span>`:''}
      </label>
    </div>
    ${active?renderChanFormatLines(c.key,plan):''}
  </div>`;
}

function renderGenerateCalendarChannelList(plan){
  return GENERATE_CAL_CHANNELS.map(c=>renderGenerateCalendarChannelRow(c,plan)).join('');
}

function getGenerateCalendarPlanStats(plan,days){
  const total=getTotalPostsFromPlan(plan);
  const formatRows=buildChannelEntries(plan).length;
  return {
    total,
    perDay:days>0?(total/days).toFixed(1):'0',
    formatRows,
    activePlatforms:activePlatformCountFromPlan(plan),
  };
}

function renderGenerateCalendarStatsGrid(plan,days){
  const s=getGenerateCalendarPlanStats(plan,days);
  return `
  <div class="grid grid-cols-3 gap-2">
    <div class="panel2 p-3 text-center">
      <div class="text-[10px] uppercase tracking-wider text-[var(--ink3)] font-semibold mb-1">Total Posts</div>
      <div class="text-[20px] font-bold mono grad-text">${s.total}</div>
    </div>
    <div class="panel2 p-3 text-center">
      <div class="text-[10px] uppercase tracking-wider text-[var(--ink3)] font-semibold mb-1">Per Day Avg</div>
      <div class="text-[20px] font-bold mono ${s.total>0?'text-[var(--ink)]':'text-[var(--ink3)]'}">${s.perDay}</div>
    </div>
    <div class="panel2 p-3 text-center">
      <div class="text-[10px] uppercase tracking-wider text-[var(--ink3)] font-semibold mb-1">Format lines</div>
      <div class="text-[20px] font-bold mono ${s.formatRows>0?'text-[var(--accent2)]':'text-[var(--ink3)]'}">${s.formatRows}</div>
    </div>
  </div>`;
}

function renderGenerateCalendarSummaryBox(plan,days){
  const s=getGenerateCalendarPlanStats(plan,days);
  if(s.total===0){
    return `<div class="panel2 p-3 text-[11.5px]" style="border-color:rgba(245,158,11,.4);background:rgba(245,158,11,.06);color:#fbbf24">⚠ Select at least one channel and set post quantity before generating.</div>`;
  }
  return `<div class="panel2 p-3 text-[11.5px] text-[var(--ink2)]">
    Will generate <b class="text-[var(--ink)]">${s.total} posts</b> across <b class="text-[var(--ink)]">${s.activePlatforms} platforms</b> and <b class="text-[var(--ink)]">${s.formatRows} format lines</b>, spread over <b class="text-[var(--ink)]">${days} days</b>. Each row’s quantity uses that format (e.g. Reels + Carousels on the same platform). Takes ~${Math.ceil(s.total/12)*30}–${Math.ceil(s.total/12)*60}s.
  </div>`;
}

/** Update channel picker without re-rendering the whole modal (preserves scroll + form fields). */
function patchGenerateCalendarChannelUI(){
  if(state.modal?.kind!=='generate-calendar'){ render({modalOnly:true}); return; }
  const root=document.getElementById('modal-host');
  if(!root) return;
  const listEl=root.querySelector('[data-g-chan-list]');
  if(!listEl){ render({modalOnly:true}); return; }
  const plan=ensureChanPlanState();
  const days=Number(state._chanDays||root.querySelector('#g-days')?.value||30);
  listEl.innerHTML=renderGenerateCalendarChannelList(plan);
  const statsEl=root.querySelector('[data-g-chan-stats]');
  if(statsEl) statsEl.innerHTML=renderGenerateCalendarStatsGrid(plan,days);
  const summaryEl=root.querySelector('[data-g-chan-summary]');
  if(summaryEl) summaryEl.innerHTML=renderGenerateCalendarSummaryBox(plan,days);
  const runBtn=root.querySelector('[data-action="run-calendar"]');
  if(runBtn) runBtn.disabled=getTotalPostsFromPlan(plan)===0;
}

function renderGenerateCalendarModal(m){
  const brand=state.brands.find(b=>b.id===state.activeBrandId);
  const reqLabel=(text)=>`<label class="label">${esc(text)}<span class="req-asterisk" aria-hidden="true">*</span></label>`;
  const plan=ensureChanPlanState();
  const days = Number(state._chanDays||30);
  const stats=getGenerateCalendarPlanStats(plan,days);

  return `<div class="modal-backdrop" data-close-modal>
    <div class="panel p-6 w-full max-w-3xl max-h-[92vh] overflow-auto scroll" data-g-cal-scroll onclick="event.stopPropagation()">
      <div class="flex items-center justify-between mb-4">
        <div>
          <div class="text-[16px] font-semibold">Generate calendar</div>
          <div class="text-[11.5px] text-[var(--ink3)]">${esc(brand.name)} · ${esc(brand.vertical||'')} · <span class="req-asterisk">*</span> required fields</div>
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
            <label class="label" style="margin:0">Channels — multiple formats &amp; quantities per platform</label>
            <div class="flex gap-2">
              <button class="btn ghost" style="padding:4px 9px;font-size:11px" data-chan-action="reset">Reset</button>
              <button class="btn ghost" style="padding:4px 9px;font-size:11px" data-chan-action="clear">Clear all</button>
            </div>
          </div>
          <div class="panel2 p-3 space-y-1.5" data-g-chan-list>
            ${renderGenerateCalendarChannelList(plan)}
          </div>
        </div>

        <div data-g-chan-stats>
          ${renderGenerateCalendarStatsGrid(plan,days)}
        </div>

        <div>${reqLabel('Content direction for this calendar')}<textarea class="textarea" id="g-content-direction" data-calendar-required placeholder="What should this calendar achieve? e.g. Q2 product launch, Diwali sale, hiring push, thought leadership in AI — be specific." required style="min-height:88px">${esc(state._calendarContentDirection||'')}</textarea></div>

        ${renderBrandContextPreview(brand)}

        <div data-g-chan-summary>
          ${renderGenerateCalendarSummaryBox(plan,days)}
        </div>
      </div>

      <div class="flex justify-end gap-2 mt-5">
        <button class="btn" data-close-modal>Cancel</button>
        <button class="btn primary" data-action="run-calendar" ${stats.total===0?'disabled':''}>${ICONS.spark} Run Generation</button>
      </div>
    </div>
  </div>`;
}

function postDetailInsetField(field, value, multiline){
  const v = esc(value || '');
  if(multiline){
    return `<textarea class="post-detail-inset" data-post-field="${field}" rows="4">${v}</textarea>`;
  }
  return `<input class="post-detail-inset" data-post-field="${field}" value="${v}"/>`;
}

function postDetailEditCard(label, field, value, opts={}){
  const { multiline, span2, type, min, max, step } = opts;
  let control;
  if(type === 'number'){
    control = `<input class="post-detail-inset mono" type="number" step="${step||'0.1'}" min="${min??0}" max="${max??10}" data-post-field="${field}" value="${value ?? 0}"/>`;
  } else if(multiline){
    control = postDetailInsetField(field, value, true);
  } else {
    control = postDetailInsetField(field, value, false);
  }
  return `<div class="panel2 p-3 ${span2?'col-span-2':''}">
    <div class="text-[10.5px] uppercase tracking-wider text-[var(--ink3)] font-semibold mb-1.5">${label}</div>
    ${control}
  </div>`;
}

function renderPostDetailBody(post, editing, editMode){
  if(editMode){
    return `
        <div class="mb-3">
          ${postDetailEditCard('Hook / Headline', 'hook', editing.hook, { span2:true })}
        </div>
        <div class="mb-4">
          <div class="text-[10.5px] uppercase tracking-wider text-[var(--ink3)] font-semibold mb-1.5">Caption</div>
          <div class="panel2 p-3">${postDetailInsetField('caption_preview', editing.caption_preview, true)}</div>
        </div>
        <div class="grid grid-cols-2 gap-3 mb-4">
          ${postDetailEditCard('Intent', 'intent', editing.intent)}
          ${postDetailEditCard('Hook Type', 'hook_type', editing.hook_type)}
          ${postDetailEditCard('Sentiment', 'sentiment', editing.sentiment)}
          ${postDetailEditCard('Segment', 'segment', editing.segment)}
          ${postDetailEditCard('CTA', 'cta', editing.cta, { span2:true })}
          ${postDetailEditCard('Tracking', 'tracking_url', editing.tracking_url, { span2:true })}
        </div>
        <div class="mb-3">
          <div class="text-[10.5px] uppercase tracking-wider text-[var(--ink3)] font-semibold mb-1.5">Creative Direction</div>
          <div class="panel2 p-3">${postDetailInsetField('creative_direction', editing.creative_direction, true)}</div>
        </div>
        <div class="mb-4">
          <div class="text-[10.5px] uppercase tracking-wider text-[var(--ink3)] font-semibold mb-1.5">Visual Specs</div>
          <div class="panel2 p-3">${postDetailInsetField('visual_specs', editing.visual_specs, true)}</div>
        </div>
        <div class="grid grid-cols-2 gap-3 mb-3">
          ${postDetailEditCard('EVI Score', 'evi_score', editing.evi_score, { type:'number' })}
          ${postDetailEditCard('Status', 'status', editing.status || 'Draft')}
        </div>`;
  }
  return `
        <div class="text-[16px] font-semibold mb-3 break-words">${esc(post.hook||'')}</div>
        ${post.caption_preview?`<div class="panel2 p-3 mb-4 text-[12.5px] leading-relaxed whitespace-pre-wrap">${esc(post.caption_preview)}</div>`:''}
        <div class="grid grid-cols-2 gap-3 text-[12px] mb-4">
          ${[
            ['Intent',post.intent],['Hook Type',post.hook_type],['Sentiment',post.sentiment],['Segment',post.segment],['CTA',post.cta],['Tracking',post.tracking_url],
          ].map(([k,v])=>v?`<div class="panel2 p-3"><div class="text-[10.5px] uppercase tracking-wider text-[var(--ink3)] font-semibold">${k}</div><div class="text-[12px] mt-0.5 break-words">${esc(v)}</div></div>`:'').join('')}
        </div>
        ${post.creative_direction?`<div class="mb-3"><div class="label">Creative Direction</div><div class="panel2 p-3 text-[12px] leading-relaxed whitespace-pre-wrap">${esc(post.creative_direction)}</div></div>`:''}
        ${post.visual_specs?`<div class="mb-3"><div class="label">Visual Specs</div><div class="panel2 p-3 text-[12px] leading-relaxed whitespace-pre-wrap">${esc(post.visual_specs)}</div></div>`:''}`;
}

function renderPostDetailModal(m){
  const post=m.data;
  const briefFlow=!!m.briefFlow;
  const editMode = !!state._postEdit;
  const editing = editMode ? state._postEdit : post;

  return `<div class="modal-backdrop" data-close-modal>
    <div class="panel p-6 w-full max-w-3xl max-h-[92vh] overflow-auto scroll" onclick="event.stopPropagation()">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="pill ${(post.funnel_stage||'').toLowerCase()}">${esc(post.funnel_stage||'')}</span>
          <span class="pill">${esc(post.platform||'')}</span>
          <span class="pill">${esc(post.format||'')}</span>
          <span class="pill mono">EVI ${(post.evi_score||0).toFixed(1)}</span>
        </div>
        <button class="btn ghost" data-close-modal>${ICONS.close}</button>
      </div>
      <div class="text-[11.5px] text-[var(--ink3)] mono mb-3">${esc(post.content_id||'')} · ${esc(post.date||'')} · ${esc(post.day||'')}</div>

      ${editMode?`<div class="panel2 p-2.5 mb-4 flex items-center gap-2" style="border-color:rgba(124,92,255,.4);background:rgba(124,92,255,.06)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7c5cff" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        <div class="text-[12px] text-[var(--ink)] flex-1"><b>Editing</b> — change any field below, then Save.</div>
      </div>`:''}

      ${renderPostDetailBody(post, editing, editMode)}

      ${briefFlow&&!editMode?`<div class="panel2 p-3 mb-4 text-[12.5px] text-[var(--ink2)]" style="border-color:rgba(124,92,255,.35);background:rgba(124,92,255,.06)">
        Review this post, then generate a production-grade creative brief. You can edit fields first if needed.
      </div>`:''}

      <div class="flex justify-between gap-2 mt-5 pt-4 border-t border-[var(--line)]">
        <div class="flex gap-2">
          ${!editMode?`<button class="btn primary" data-action="brief-from-post">${ICONS.spark} Generate Creative Brief</button>`:''}
        </div>
        <div class="flex gap-2">
          ${editMode?`
            <button class="btn" data-action="cancel-edit-post">Cancel</button>
            <button class="btn primary" data-action="save-post-edit">Save</button>
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

function renderSelectBrandHint(msg){
  return `<div class="panel empty">
    <div class="text-[14px] font-semibold mb-1 text-[var(--ink)]">No brand selected</div>
    <div class="text-[12px] mb-4">${esc(msg)}</div>
    <button class="btn" data-nav="brands">Go to Brands →</button>
  </div>`;
}

/* ========= HANDLERS (delegated once — no re-bind on every render) ========= */
const APP_HANDLERS_VERSION=2;

function bindAppHandlersOnce(){
  if(window.__scAppHandlersV===APP_HANDLERS_VERSION) return;
  window.__scAppHandlersV=APP_HANDLERS_VERSION;
  // Capture phase so modal panel stopPropagation does not block [data-action] clicks
  document.addEventListener('click', onAppClick, true);
  document.addEventListener('change', onAppChange);
  document.addEventListener('input', onAppInput);
  document.addEventListener('keydown', onAppKeydown);
}

function onAppClick(e){
  const backdrop=e.target.closest('.modal-backdrop[data-close-modal]');
  if(backdrop && e.target===backdrop){ closeModal(); return; }

  const closeBtn=e.target.closest('button[data-close-modal]');
  if(closeBtn){ e.stopPropagation(); closeModal(); return; }

  const actionEl=e.target.closest('[data-action]');
  if(actionEl){
    e.stopPropagation();
    if(actionEl.disabled) return;
    handleAction(actionEl.dataset.action);
    return;
  }

  const navEl=e.target.closest('[data-nav]');
  if(navEl){ goto(navEl.dataset.nav); return; }

  const editBrand=e.target.closest('[data-edit-brand]');
  if(editBrand){
    e.stopPropagation();
    const b=state.brands.find(x=>x.id===editBrand.dataset.editBrand);
    openModal({kind:'brand-form',data:{...b}});
    return;
  }

  const delBrand=e.target.closest('[data-delete-brand]');
  if(delBrand){
    e.stopPropagation();
    const id=delBrand.dataset.deleteBrand;
    const b=state.brands.find(x=>x.id===id);
    openModal({kind:'confirm',title:'Delete brand?',body:`This will permanently remove "${b.name}" and all its calendars + briefs.`,danger:true,confirmLabel:'Delete',onYes:async()=>{ await Store.deleteBrand(id); state.brands=await Store.listBrands(); if(state.activeBrandId===id) state.activeBrandId=null; clearModalState(); render(); showToast('Brand deleted','ok'); }});
    return;
  }

  const openBrand=e.target.closest('[data-open-brand]');
  if(openBrand){
    const id=openBrand.dataset.openBrand;
    const b=state.brands.find(x=>x.id===id);
    if(b && !isBrandProfileComplete(b)){
      showToast('Complete required brand fields before opening the calendar','err',5000);
      openModal({kind:'brand-form',data:{...b}});
      return;
    }
    state.view='calendar';
    setActiveBrand(id);
    return;
  }

  const delCal=e.target.closest('[data-delete-cal]');
  if(delCal){
    e.preventDefault();
    e.stopPropagation();
    const id=delCal.dataset.deleteCal;
    const brandId=state.activeBrandId;
    if(!brandId||!id){ showToast('Cannot delete — no brand or calendar selected','err'); return; }
    openModal({kind:'confirm',title:'Delete calendar?',body:'This calendar and its posts will be removed.',danger:true,confirmLabel:'Delete',onYes:async()=>{
      await Store.deleteCalendar(brandId,id);
      state.calendars=await Store.listCalendars(brandId);
      if(state.activeCalendar&&state.activeCalendar.id===id) state.activeCalendar=state.calendars[0]||null;
      clearModalState();
      render();
      showToast('Calendar deleted','ok');
    }});
    return;
  }

  const openCal=e.target.closest('[data-open-cal]');
  if(openCal){
    e.stopPropagation();
    const c=state.calendars.find(x=>x.id===openCal.dataset.openCal);
    state.activeCalendar=c;
    state._calendarEditMode=false;
    render();
    return;
  }

  const scrollPost=e.target.closest('[data-scroll-to-post]');
  if(scrollPost){
    e.stopPropagation();
    scrollToPostRow(Number(scrollPost.dataset.scrollToPost));
    return;
  }

  const addPostDate=e.target.closest('[data-add-post-date]');
  if(addPostDate){
    e.stopPropagation();
    const date=addPostDate.dataset.addPostDate;
    if(date) openAddPostModal(date, dayNameFromDate(date));
    return;
  }

  const delPostIdx=e.target.closest('[data-delete-post-idx]');
  if(delPostIdx){
    e.stopPropagation();
    deleteCalendarPost(Number(delPostIdx.dataset.deletePostIdx));
    return;
  }

  const postDetail=e.target.closest('[data-post-detail]');
  if(postDetail){
    openModal({kind:'post-detail',data:state.activeCalendar.posts[Number(postDetail.dataset.postDetail)]});
    return;
  }

  const editHook=e.target.closest('[data-edit-hook]');
  if(editHook){
    e.stopPropagation();
    const idx=Number(editHook.dataset.editHook);
    if(editHook.closest('.post-cal-row')) openPostHookEdit(idx);
    else startInlineHookEdit(idx);
    return;
  }

  const genBriefPost=e.target.closest('[data-gen-brief-post]');
  if(genBriefPost){
    e.stopPropagation();
    const i=Number(genBriefPost.dataset.genBriefPost);
    openModal({kind:'post-detail',data:state.activeCalendar.posts[i],briefFlow:true});
    return;
  }

  const viewBrief=e.target.closest('[data-view-brief]');
  if(viewBrief){
    e.stopPropagation();
    (async()=>{
      const [bid,id]=viewBrief.dataset.viewBrief.split('|');
      let b=(state.briefs||[]).find(x=>x.id===id);
      if(!b){ const briefs=await Store.listBriefs(bid); b=briefs.find(x=>x.id===id); }
      if(b) openModal({kind:'view-brief',data:b});
    })();
    return;
  }

  const delBrief=e.target.closest('[data-delete-brief]');
  if(delBrief){
    e.stopPropagation();
    const [bid,id]=delBrief.dataset.deleteBrief.split('|');
    openModal({kind:'confirm',title:'Delete brief?',danger:true,body:'This brief will be permanently removed.',confirmLabel:'Delete',onYes:async()=>{ await Store.deleteBrief(bid,id); state.allBriefs=await Store.listAllBriefs(); clearModalState(); render(); showToast('Brief deleted','ok'); }});
    return;
  }

  const setVariant=e.target.closest('[data-set-active-variant]');
  if(setVariant){
    e.stopPropagation();
    setBriefVariantActive(setVariant.dataset.setActiveVariant);
    return;
  }

  if(e.target.closest('[data-chan-format-pick],[data-chan-fmt-input]')) return;

  const chanFmtStep=e.target.closest('[data-chan-fmt-step]');
  if(chanFmtStep){
    e.preventDefault(); e.stopPropagation();
    const parts=chanFmtStep.dataset.chanFmtStep.split('|');
    const platform=parts[0];
    const format=parts.slice(1,-1).join('|');
    const delta=Number(parts[parts.length-1]);
    const plan=ensureChanPlanState();
    if(!plan[platform]) plan[platform]={};
    const cur=Number(plan[platform][format]||0);
    const next=Math.max(0,Math.min(999,cur+delta));
    if(next>0) plan[platform][format]=next;
    else delete plan[platform][format];
    pruneChanPlatformZeros(plan,platform);
    patchGenerateCalendarChannelUI();
    return;
  }

  const chanAddFmt=e.target.closest('[data-chan-add-format]');
  if(chanAddFmt){
    e.preventDefault(); e.stopPropagation();
    const platform=chanAddFmt.dataset.chanAddFormat;
    const plan=ensureChanPlanState();
    const next=nextUnusedFormatForPlatform(plan,platform);
    if(next){
      if(!plan[platform]) plan[platform]={};
      plan[platform][next.value]=3;
    }
    patchGenerateCalendarChannelUI();
    return;
  }

  const chanRemoveFmt=e.target.closest('[data-chan-remove-format]');
  if(chanRemoveFmt){
    e.preventDefault(); e.stopPropagation();
    const {platform,format}=parseChanPlatformFormat(chanRemoveFmt.dataset.chanRemoveFormat);
    const plan=ensureChanPlanState();
    if(plan[platform]) delete plan[platform][format];
    pruneChanPlatformZeros(plan,platform);
    patchGenerateCalendarChannelUI();
    return;
  }

  const chanToggle=e.target.closest('[data-chan-toggle]');
  if(chanToggle){
    e.preventDefault();
    const key=chanToggle.dataset.chanToggle;
    const plan=ensureChanPlanState();
    if(platformTotalFromPlan(plan,key)>0) delete plan[key];
    else plan[key]={[getDefaultChannelFormat(key)]:Math.max(3,Math.round((Number(state._chanDays||30))/10))};
    patchGenerateCalendarChannelUI();
    return;
  }

  const chanAction=e.target.closest('[data-chan-action]');
  if(chanAction){
    e.preventDefault();
    const a=chanAction.dataset.chanAction;
    if(a==='clear') state._chanPlan={};
    if(a==='reset'){ state._chanPlan=null; state._chanSel=null; state._chanFormats=null; }
    patchGenerateCalendarChannelUI();
    return;
  }

  const sortBtn=e.target.closest('[data-post-sort]');
  if(sortBtn && e.target.closest('#all-posts-panel')){
    e.preventDefault(); e.stopPropagation();
    state._postsFilter=state._postsFilter||{};
    const key=sortBtn.getAttribute('data-post-sort');
    if(!key) return;
    if(state._postsFilter.sortKey===key){
      state._postsFilter.sortDir=state._postsFilter.sortDir==='asc'?'desc':'asc';
    }else{
      state._postsFilter.sortKey=key;
      state._postsFilter.sortDir='asc';
    }
    render();
  }
}

function onAppChange(e){
  const el=e.target;
  if(el.dataset.brandRequired){
    if(String(el.value||'').trim()){
      el.classList.remove('field-invalid');
      el.removeAttribute('aria-invalid');
      const anyInvalid=document.querySelector('[data-brand-required].field-invalid');
      if(!anyInvalid) updateBrandFormErrorBanner(null);
    }
  }
  if(el.id==='brand-switcher'){ setActiveBrand(el.value); return; }
  if(el.dataset.chanFormatPick){
    const platform=el.dataset.chanFormatPick;
    const was=el.dataset.chanFormatWas;
    const now=el.value;
    const plan=ensureChanPlanState();
    if(plan[platform]&&was!==now){
      const count=Number(plan[platform][was]||0);
      delete plan[platform][was];
      if(count>0){
        const existing=Number(plan[platform][now]||0);
        plan[platform][now]=existing+count;
      }
      pruneChanPlatformZeros(plan,platform);
    }
    patchGenerateCalendarChannelUI();
    return;
  }
  if(el.dataset.chanFmtInput){
    const {platform,format}=parseChanPlatformFormat(el.dataset.chanFmtInput);
    const n=Math.max(0,Math.min(999,Number(el.value)||0));
    const plan=ensureChanPlanState();
    if(!plan[platform]) plan[platform]={};
    if(n>0) plan[platform][format]=n;
    else delete plan[platform][format];
    pruneChanPlatformZeros(plan,platform);
    patchGenerateCalendarChannelUI();
    return;
  }
  if(el.dataset.chanDays){
    state._chanDays=Number(el.value);
    patchGenerateCalendarChannelUI();
    return;
  }
  if(el.dataset.postFilter){
    state._postsFilter=state._postsFilter||{};
    state._postsFilter[el.dataset.postFilter]=el.value||null;
    render();
  }
}

function onAppInput(e){
  const el=e.target;
  if(el.dataset.brandRequired){
    if(String(el.value||'').trim()){
      el.classList.remove('field-invalid');
      el.removeAttribute('aria-invalid');
      const anyInvalid=document.querySelector('[data-brand-required].field-invalid');
      if(!anyInvalid) updateBrandFormErrorBanner(null);
    }
  }
  if(el.dataset.calendarRequired){
    state._calendarContentDirection=el.value;
    if(String(el.value||'').trim()){
      el.classList.remove('field-invalid');
      el.removeAttribute('aria-invalid');
      updateCalendarGenerateErrorBanner(null);
    }
  }
  if(el.dataset.newPostField){
    if(!state._newPost) return;
    const k=el.dataset.newPostField;
    if(!k) return;
    if(el.type==='number') state._newPost[k]=el.value===''?'':Number(el.value);
    else state._newPost[k]=el.value;
    return;
  }
  if(el.dataset.inlineHookInput){
    state._inlineHookDraft=el.value;
    return;
  }
  if(el.dataset.briefField && state._briefEdit){
    state._briefEdit[el.dataset.briefField]=el.value;
    return;
  }
  if(el.dataset.postField && state._postEdit){
    const k=el.dataset.postField;
    state._postEdit[k]=(k==='evi_score')?Number(el.value):el.value;
    return;
  }
  if(el.id==='posts-search'){
    state._postsFilter=state._postsFilter||{};
    state._postsFilter.q=el.value;
    clearTimeout(window._postsSearchTimer);
    window._postsSearchTimer=setTimeout(()=>render(),150);
  }
}

function onAppKeydown(e){
  const scrollPost=e.target.closest('[data-scroll-to-post]');
  if(scrollPost && (e.key==='Enter' || e.key===' ')){
    e.preventDefault();
    scrollToPostRow(Number(scrollPost.dataset.scrollToPost));
    return;
  }
  if(!e.target.matches('[data-inline-hook-input]')) return;
  if(e.key==='Enter'){ e.preventDefault(); handleAction('save-inline-hook'); }
  if(e.key==='Escape'){ e.preventDefault(); handleAction('cancel-inline-hook'); }
}

function afterRender(){
  afterRenderModal();
  if(state._focusPostField){
    const field=state._focusPostField;
    state._focusPostField=null;
    requestAnimationFrame(()=>{
      const el=document.querySelector(`[data-post-field="${field}"]`);
      if(el){ el.focus(); if(el.select) el.select(); }
    });
  }
  if(state._dlMenuOpen){
    setTimeout(()=>{
      const handler=(ev)=>{
        if(!ev.target.closest('.dl-wrap')){
          state._dlMenuOpen=false;
          document.removeEventListener('click',handler);
          render();
        }
      };
      document.addEventListener('click',handler);
    },0);
  }
}

function patchBrandSaveButton(){
  const btn=document.querySelector('[data-action="save-brand"]');
  if(!btn) return;
  const isEdit=!!state.modal?.data?.id;
  btn.disabled=!!state._saveBrandInFlight;
  btn.textContent=state._saveBrandInFlight?'Saving…':(isEdit?'Save Changes':'Create Brand');
  const cancel=btn.parentElement?.querySelector('[data-close-modal]');
  if(cancel) cancel.disabled=!!state._saveBrandInFlight;
}

function goto(view){
  state.view=view;
  if(view==='briefs'){ Store.listAllBriefs().then(b=>{ state.allBriefs=b; render(); }); return; }
  render();
}

async function setActiveBrand(id){
  state.activeBrandId=id||null;
  state.activeCalendar=null;
  if(id) state.view=state.view||'calendar';
  await loadBrandWorkspace();
}
async function loadBrandWorkspace(){
  if(!state.activeBrandId){ render(); return; }
  const [cs,bs,t]=await Promise.all([
    Store.listCalendars(state.activeBrandId),
    Store.listBriefs(state.activeBrandId),
    Store.getTrends(state.activeBrandId),
  ]);
  state.calendars=cs;
  state.briefs=bs;
  state.trends=t;
  if(!state.activeCalendar&&cs.length) state.activeCalendar=cs[0];
  _analyticsKey=null;
  render();
}
function openModal(m){
  if(m?.kind==='view-brief' && m.data) m = {...m, data: normalizeBrief(m.data)};
  state.modal=m;
  render({modalOnly:true});
  if(m?.kind==='brand-form' && m.data && !isBrandProfileComplete(m.data)){
    requestAnimationFrame(()=>highlightExistingBrandFormGaps(m.data));
  }
}

function highlightExistingBrandFormGaps(brand){
  const missing=getBrandMissingRequired(brand);
  if(!missing.length) return;
  clearBrandFieldErrors();
  const labels=missing.map(m=>m.label).join(', ');
  updateBrandFormErrorBanner(
    brand.id
      ? `This brand is missing required info: ${labels}. Fill the highlighted fields and save.`
      : `Please complete: ${labels}.`
  );
  const root=document.getElementById('modal-host')||document;
  missing.forEach(field=>{
    const el=root.querySelector('#'+field.id)||document.getElementById(field.id);
    if(el){
      el.classList.add('field-invalid');
      el.setAttribute('aria-invalid','true');
    }
  });
  const firstEl=root.querySelector('#'+missing[0].id)||document.getElementById(missing[0].id);
  if(firstEl) scrollToBrandField(firstEl);
}

async function handleAction(a){
  if(a==='new-brand'){
    if(state._saveBrandInFlight) return;
    if(state.modal?.kind==='brand-form' && !state.modal.data?.id) return;
    return openModal({kind:'brand-form',data:{_clientDraftId:'b_'+Math.random().toString(36).slice(2,10)}});
  }
  if(a==='save-brand') return saveBrandFromForm();
  if(a==='generate-calendar'){
    const brand=state.brands.find(b=>b.id===state.activeBrandId);
    if(brand && !isBrandProfileComplete(brand)){
      showToast('Complete required brand profile fields first','err',5000);
      openModal({kind:'brand-form',data:{...brand}});
      return;
    }
    return openModal({kind:'generate-calendar'});
  }
  if(a==='run-calendar') return runCalendar();
  if(a==='gen-briefs-all') return runAutoBriefsAll();
  if(a==='brief-from-post') return briefFromCurrentPost();
  if(a==='fetch-trends'){
    const brand=state.brands.find(b=>b.id===state.activeBrandId);
    if(brand && !isBrandProfileComplete(brand)){
      showToast('Complete required brand profile fields first','err',5000);
      openModal({kind:'brand-form',data:{...brand}});
      return;
    }
    return runFetchTrends();
  }
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
  if(a==='retry-calendar'){
    state.modal={kind:'generate-calendar'};
    state._chanPlan=null;
    state._chanSel=null;
    state._chanFormats=null;
    render({modalOnly:true});
    return;
  }

  // Brief edit / save / regenerate
  if(a==='edit-brief'){
    const record = normalizeBrief(state.modal.data);
    const active = getActiveVariant(record);
    if(!active){ showToast('No active brief to edit','err'); return; }
    state._briefEditVariantId = record.activeVariantId;
    state._briefEdit = {...active};
    render({modalOnly:true});
    return;
  }
  if(a==='cancel-edit-brief'){ state._briefEdit = null; state._briefEditVariantId = null; render({modalOnly:true}); return; }
  if(a==='save-brief-edit') return saveBriefEdit();
  if(a==='regenerate-brief') return regenerateBrief();
  if(a==='toggle-regenerated-copies'){ state._briefShowRegenerated = !state._briefShowRegenerated; render({modalOnly:true}); return; }

  // Post edit / save / regenerate
  if(a==='edit-post' || a==='edit-post-hook'){
    state._postEdit = applyPostUpdate(state.modal.data, {});
    if(a==='edit-post-hook') state._focusPostField = 'hook';
    render({modalOnly:true});
    return;
  }
  if(a==='cancel-edit-post'){ state._postEdit = null; render({modalOnly:true}); return; }
  if(a==='save-post-edit') return savePostEdit();
  if(a==='save-inline-hook') return saveInlineHook(state._inlineHookEditIdx);
  if(a==='cancel-inline-hook'){ state._inlineHookEditIdx = null; state._inlineHookDraft = null; render(); return; }
  if(a==='save-new-post') return saveNewPost();
  if(a==='cancel-add-post'){ state._newPost = null; closeModal(); return; }
  if(a==='toggle-calendar-edit'){
    state._calendarEditMode = !state._calendarEditMode;
    render();
    return;
  }
  if(a==='toggle-cal-sidebar'){
    state._calSidebarCollapsed = !state._calSidebarCollapsed;
    render();
    return;
  }
  if(a==='regenerate-post') return regeneratePost();
  if(a==='save-partial'){
    const m=state.modal;
    if(!m||!m.calendarData) return;
    const dir=m.calendarData.content_direction||m.calendarData.focus||'';
    const cal={id:'cal_'+Date.now(),title:m.calendarData.title+' (partial)',startDate:m.calendarData.start,days:m.calendarData.days,content_direction:dir,focus:dir,posts:m.calendarData.posts};
    try{
      await Store.saveCalendar(m.brandId,cal);
      state.calendars=await Store.listCalendars(m.brandId);
      state.activeCalendar=state.calendars.find(c=>c.id===cal.id)||state.calendars[0];
      clearModalState();
      render();
      showToast(`Partial saved · ${cal.posts.length} posts`,'info');
    }catch(e){ showToast('Save failed: '+e.message,'err'); }
    return;
  }
  if(a==='confirm-yes'){
    const fn=state.modal?.onYes;
    if(!fn) return;
    try{
      await fn();
    }catch(err){
      showToast('Action failed: '+(err.message||err),'err');
      console.error('Confirm action failed:',err);
    }
    return;
  }
}

const BRAND_REQUIRED_FIELDS=[
  {id:'f-name', key:'name', label:'Brand Name', message:'Brand name is required'},
  {id:'f-target_customer_profile', key:'target_customer_profile', label:'Target Customer Profile', message:'Target customer profile is required'},
  {id:'f-growth_objective', key:'growth_objective', label:'Growth Objective', message:'Growth objective is required'},
  {id:'f-brand_tone', key:'brand_tone', label:'Brand Tone', message:'Brand tone is required'},
  {id:'f-brand_personality', key:'brand_personality', label:'Brand Personality', message:'Brand personality is required'},
  {id:'f-brand_language', key:'brand_language', label:'Brand Language', message:'Brand language is required — select e.g. US English or UK English'},
];

function getBrandFieldValue(brand,field){
  if(field.key==='brand_tone')
    return String(brand.brand_tone||brand.brand_tone_personality||brand.brand_voice||'').trim();
  return String(brand[field.key]||'').trim();
}

function getBrandMissingRequired(brand){
  if(!brand) return [...BRAND_REQUIRED_FIELDS];
  return BRAND_REQUIRED_FIELDS.filter(f=>!getBrandFieldValue(brand,f));
}

function isBrandProfileComplete(brand){
  return getBrandMissingRequired(brand).length===0;
}

function clearBrandFieldErrors(){
  document.querySelectorAll('[data-brand-required]').forEach(el=>{
    el.classList.remove('field-invalid');
    el.removeAttribute('aria-invalid');
  });
  updateBrandFormErrorBanner(null);
}

function updateBrandFormErrorBanner(message){
  const panel=document.querySelector('#modal-host .modal-backdrop .panel');
  if(!panel) return;
  let banner=panel.querySelector('#brand-form-error-banner');
  if(!message){
    if(banner) banner.remove();
    return;
  }
  if(!banner){
    banner=document.createElement('div');
    banner.id='brand-form-error-banner';
    banner.className='brand-form-error-banner';
    banner.setAttribute('role','alert');
    const grid=panel.querySelector('.grid');
    if(grid) panel.insertBefore(banner, grid);
    else panel.prepend(banner);
  }
  banner.textContent=message;
}

function scrollToBrandField(el){
  if(!el) return;
  const scrollParent=el.closest('.overflow-auto')||el.closest('.panel');
  requestAnimationFrame(()=>{
    if(scrollParent){
      const parentRect=scrollParent.getBoundingClientRect();
      const elRect=el.getBoundingClientRect();
      const offset=elRect.top-parentRect.top+scrollParent.scrollTop-80;
      scrollParent.scrollTo({top:Math.max(0,offset),behavior:'smooth'});
    }else{
      el.scrollIntoView({behavior:'smooth',block:'center'});
    }
    setTimeout(()=>{ try{ el.focus({preventScroll:true}); }catch(_){ el.focus(); } },350);
  });
}

function updateCalendarGenerateErrorBanner(message){
  const panel=document.querySelector('#modal-host .modal-backdrop .panel');
  if(!panel) return;
  let banner=panel.querySelector('#calendar-form-error-banner');
  if(!message){
    if(banner) banner.remove();
    return;
  }
  if(!banner){
    banner=document.createElement('div');
    banner.id='calendar-form-error-banner';
    banner.className='brand-form-error-banner';
    banner.setAttribute('role','alert');
    const space=panel.querySelector('.space-y-4');
    if(space) space.prepend(banner);
    else panel.prepend(banner);
  }
  banner.textContent=message;
}

function clearCalendarFieldErrors(){
  document.querySelectorAll('[data-calendar-required]').forEach(el=>{
    el.classList.remove('field-invalid');
    el.removeAttribute('aria-invalid');
  });
  updateCalendarGenerateErrorBanner(null);
}

function validateCalendarGenerateForm(){
  clearCalendarFieldErrors();
  const root=document.getElementById('modal-host')||document;
  const field=CALENDAR_CONTENT_DIRECTION_FIELD;
  const el=root.querySelector('#'+field.id)||document.getElementById(field.id);
  const value=String(el?.value||'').trim();
  if(!value){
    if(el){
      el.classList.add('field-invalid');
      el.setAttribute('aria-invalid','true');
    }
    updateCalendarGenerateErrorBanner(field.message);
    showToast(field.message,'err',5000);
    if(el) scrollToBrandField(el);
    return false;
  }
  state._calendarContentDirection=value;
  return true;
}

function validateBrandForm(){
  clearBrandFieldErrors();
  const root=document.getElementById('modal-host')||document;
  let firstInvalid=null;
  let missingCount=0;
  for(const field of BRAND_REQUIRED_FIELDS){
    const el=root.querySelector('#'+field.id)||document.getElementById(field.id);
    if(!el){
      missingCount++;
      if(!firstInvalid) firstInvalid={el:null,message:'Please complete all required fields.'};
      continue;
    }
    const value=String(el.value||'').trim();
    if(!value){
      el.classList.add('field-invalid');
      el.setAttribute('aria-invalid','true');
      missingCount++;
      if(!firstInvalid) firstInvalid={el,message:field.message};
    }
  }
  if(firstInvalid){
    const msg=missingCount>1
      ? `Please fill in ${missingCount} required fields. ${firstInvalid.message}`
      : firstInvalid.message;
    updateBrandFormErrorBanner(msg);
    showToast(firstInvalid.message,'err',5000);
    if(firstInvalid.el) scrollToBrandField(firstInvalid.el);
    return false;
  }
  return true;
}

async function saveBrandFromForm(){
  if(state._saveBrandInFlight) return;
  if(!validateBrandForm()) return;
  const get=id=>document.getElementById(id)?.value?.trim()||'';
  const modalData=state.modal?.data||{};
  const data={
    id:modalData.id||modalData._clientDraftId,
    name:get('f-name'), website_url:get('f-website_url'), vertical:get('f-vertical'),
    location:get('f-location'), business_model:get('f-business_model'), price_sensitivity_tier:get('f-price_sensitivity_tier'),
    purchase_cycle_length:get('f-purchase_cycle_length'), avg_transaction_value:get('f-avg_transaction_value'),
    time_horizon:get('f-time_horizon'),
    target_customer_profile:get('f-target_customer_profile'), growth_objective:get('f-growth_objective'),
    brand_tone:get('f-brand_tone'), brand_personality:get('f-brand_personality'), brand_language:get('f-brand_language'),
    product_placement_context:get('f-product_placement_context'), brand_voice:get('f-brand_voice'),
  };
  state._saveBrandInFlight=true;
  patchBrandSaveButton();
  try{
    const saved=await Store.saveBrand(data);
    state.brands=await Store.listBrands();
    if(!state.activeBrandId) state.activeBrandId=saved.id;
    clearModalState();
    render();
    showToast(modalData.id?'Brand updated':'Brand created','ok');
  }catch(e){
    showToast('Save failed: '+(e.message||e),'err');
    console.error('Brand save error:',e);
  }finally{
    state._saveBrandInFlight=false;
    if(state.modal?.kind==='brand-form') patchBrandSaveButton();
  }
}

async function runCalendar(){
  let brand, title, start, days, contentDirection, chanPlan, fullEntries;
  try {
    brand = state.brands.find(b=>b.id===state.activeBrandId);
    if(!brand){ showToast('No active brand selected','err'); return; }
    if(!isBrandProfileComplete(brand)){
      showToast('Complete required brand profile fields before generating a calendar','err',5000);
      openModal({kind:'brand-form',data:{...brand}});
      return;
    }
    chanPlan=captureChanPlanFromUI();
    fullEntries=buildChannelEntries(chanPlan);
    if(!fullEntries.length){
      showToast('Enable at least one platform and set quantity for a format','err');
      return;
    }
    if(!validateCalendarGenerateForm()) return;
    title = document.getElementById('g-title')?.value?.trim() || (brand.name+' '+monthName(new Date()));
    start = document.getElementById('g-start')?.value || todayISO();
    days = Number(document.getElementById('g-days')?.value || 30);
    contentDirection = state._calendarContentDirection;
  } catch(e){
    showToast('Form read error: '+e.message,'err');
    console.error('Form error:',e);
    return;
  }

  closeModal();

  const totalPosts=getTotalPostsFromPlan(chanPlan);
  if(totalPosts<=0){
    showToast('Set at least one post quantity before generating','err');
    return;
  }
  const chunkSize=6;
  const chunks=buildCalendarBatches(fullEntries,days,start,chunkSize);
  const batchTotal=chunks.reduce((s,c)=>s+c.total,0);

  const log = [];
  if(batchTotal!==totalPosts)
    log.push(`▸ Batch allocation: ${batchTotal} slots across ${chunks.length} batches (plan: ${totalPosts})`);
  const setLoading = (body) => {
    state.modal = {kind:'loading', title:'Generating calendar…', body, log: [...log]};
    render({modalOnly:true});
  };
  const planSummary=summarizeCalendarGenerationPlan(chanPlan,days,contentDirection);
  log.push(`▸ Locked plan (from your selections):\n${planSummary.split('\n').map(l=>'  '+l).join('\n')}`);
  setLoading(`Preparing ${chunks.length} batches…\n${planSummary}`);

  // Load content history for anti-repetition guardrails
  let priorCalendars = state.calendars || [];
  let brandBriefs = state.briefs || [];
  try{
    if(!priorCalendars.length) priorCalendars = await Store.listCalendars(brand.id);
    if(!brandBriefs.length) brandBriefs = await Store.listBriefs(brand.id);
  }catch(_){}
  const contentHistory = collectContentHistory(priorCalendars, brandBriefs, []);
  const fullDateSchedule = buildEvenDateSchedule(totalPosts, start, days);

  const allPosts=[];
  let chunkIdx=0;
  for(const ch of chunks){
    chunkIdx++;
    if(ch.total===0){ log.push(`▸ Batch ${chunkIdx}/${chunks.length} skipped (0 posts allocated)`); continue; }
    const batchPostSlots=buildPostSlotsFromEntries(ch.entries);
    const mixDesc=ch.entries.map(e=>`${e.platform}:${e.count}×${e.format}`).join(' · ');
    log.push(`▸ Batch ${chunkIdx}/${chunks.length} · ${ch.total} posts · ${mixDesc}`);
    setLoading(`Batch ${chunkIdx} of ${chunks.length} · ${ch.total} posts · days ${ch.startDay}–${ch.endDay}`);
    const variationPlan = selectVariationPlan(contentHistory, ch.total, allPosts);
    const batchDateSchedule = fullDateSchedule.slice(allPosts.length, allPosts.length + ch.total);
    const prompt=buildCalendarPrompt(brand,{
      title,start:ch.startDate,days:ch.length,contentDirection,
      calendarStart:start,
      batchInfo:`Batch ${chunkIdx} of ${chunks.length} (overall day ${ch.startDay}-${ch.endDay} of ${days})`,
      totalDays:days,
      channelFormatMix: ch.entries,
      channelPlan: chanPlan,
      postSlots: batchPostSlots,
      batchTotal: ch.total,
      contentHistory,
      alreadyGenerated: allPosts,
      variationPlan,
      dateSchedule: batchDateSchedule,
    });
    try{
      const json=await callClaudeJSON(prompt,{max_tokens:16000,temperature:0.65});
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
      applyDateScheduleToPosts(posts, batchDateSchedule, 0);
      posts=applyBatchPostSlots(posts, ch.entries, batchDateSchedule);
      if(posts.length!==batchPostSlots.length)
        log.push(`  ⚠ Post count ${posts.length} vs expected ${batchPostSlots.length} — matched by platform+format`);
      log.push(`  Validating uniqueness + format-aligned copy for ${posts.length} posts…`);
      posts=await validateAndFixBatchPosts(posts, brand, contentHistory, allPosts, variationPlan, log);
      posts=applyBatchPostSlots(posts, ch.entries, batchDateSchedule);
      for(const p of posts){
        contentHistory.posts.unshift(p);
        if(p.hook) contentHistory.hooks.unshift({text:p.hook, hook_type:p.hook_type, hook_category:p.hook_category});
        if(p.generation_meta) contentHistory.metadata.unshift(p.generation_meta);
      }
      log.push(`✓ Batch ${chunkIdx}/${chunks.length} — ${posts.length} posts (validated)`);
      allPosts.push(...posts);
    }catch(e){
      const errMsg = e.message || String(e);
      log[log.length-1] = `✗ Batch ${chunkIdx}/${chunks.length} FAILED — ${errMsg}`;
      console.error('Calendar batch error:',e);
      // Show error modal with details (don't auto-close)
      state.modal = {kind:'error', title:`Batch ${chunkIdx} failed`, body:errMsg, log:[...log], canRetry:true, partial:allPosts.length, brandId:brand.id, calendarData:{title,start,days,content_direction:contentDirection,focus:contentDirection,channelPlan:chanPlan,posts:allPosts}};
      render({modalOnly:true});
      return;
    }
  }

  distributePostsAcrossCalendarDays(allPosts, start, days);
  enforceAllPostFormats(allPosts);

  if(!allPosts.length){
    const skipped=chunks.filter(c=>c.total===0).length;
    log.push(`✗ No posts generated (${skipped}/${chunks.length} batches had zero allocation or empty model output)`);
    state.modal={kind:'error',title:'No posts generated',body:'Every batch was skipped or returned no posts. Try fewer days, more posts per format, or retry.',log:[...log],canRetry:true,brandId:brand.id};
    render({modalOnly:true});
    return;
  }

  const postsPerDay = days > 0 ? (allPosts.length / days).toFixed(1) : '0';
  log.push(`▸ Dates spread evenly across ${days} days (~${postsPerDay} posts/day)`);
  log.push(`▸ Saving calendar with ${allPosts.length} posts…`);
  setLoading('Saving…');

  const calId='cal_'+Date.now();
  stampCalendarOnPosts(allPosts,calId);
  const cal={id:calId,title,startDate:start,days,content_direction:contentDirection,focus:contentDirection,channelPlan:chanPlan,posts:allPosts};
  try{
    await Store.saveCalendar(brand.id,cal);
    state.calendars=await Store.listCalendars(brand.id);
    state.activeCalendar=state.calendars.find(c=>c.id===cal.id)||state.calendars[0];
    clearModalState();
    render();
    showToast(`Calendar generated · ${allPosts.length} posts. Briefs are not auto-created — use Generate Brief when ready.`,'ok',6000);
  }catch(e){
    state.modal = {kind:'error', title:'Save failed', body:e.message, log:[...log,`✗ Save error: ${e.message}`]};
    render({modalOnly:true});
  }
}

function buildCalendarPrompt(brand,opts){
  const funnelRatio = brand.business_model === 'B2C' ? '45/30/25' : (brand.business_model === 'B2G' ? '50/35/15' : '40/35/25');
  const formatMix=opts.channelFormatMix||buildChannelEntries(opts.channelPlan||{});
  const mixLines=formatMix.filter(e=>e.count>0).map(e=>
    `  - ${e.platform} · ${e.format}: EXACTLY ${e.count} posts`
  ).join('\n');
  const totalRequired=opts.batchTotal||formatMix.reduce((s,e)=>s+e.count,0);
  const guardrails = buildAntiRepetitionSection(opts.contentHistory, opts.alreadyGenerated, opts.variationPlan, opts.dateSchedule, opts.postSlots);
  const postSlotLines=(opts.postSlots||[]).map((s,i)=>{
    const ds=(opts.dateSchedule||[])[i];
    return `  Post ${i+1}: platform="${s.platform}" | format="${s.format}" | date=${ds?.date||''} (${ds?.day||''})`;
  }).join('\n');
  const hookCats = GUARDRAIL_HOOK_CATEGORIES.join('|');
  const dateScheduleLines = (opts.dateSchedule||[]).map((s,i)=>`  Post ${i+1}: ${s.date} (${s.day})`).join('\n');
  const calStart = opts.calendarStart || opts.start;

  return `# ROLE
You are a Senior Brand Copywriter with 15+ years at Ogilvy, Wieden+Kennedy, Leo Burnett, and DDB — AND a McKinsey-caliber Social Media Strategist. Your deliverables combine senior advertising craft, funnel architecture, platform-native behavior, and measurable business outcomes. They must withstand CMO scrutiny and creative director validation.

${guardrails}

# TASK
${opts.batchInfo?`THIS IS ${opts.batchInfo}. Generate posts ONLY for this ${opts.days}-day window of the larger ${opts.totalDays}-day plan.`:`Generate a ${opts.days}-day funnel-mapped, EVI-scored content calendar.`}
Each post MUST follow its assigned variation row (Angle, Framework, Trigger, Hook Category) — no two posts in this batch share the same combination.

${buildBrandContextBlock(brand)}

# CALENDAR RUN
- Calendar Start: ${calStart}
- Batch window starts: ${opts.start}
- Total calendar span: ${opts.totalDays} days
- Calendar Title: ${opts.title}

# DATE DISTRIBUTION (MANDATORY — posts spread evenly across the full ${opts.totalDays}-day calendar)
Do NOT cluster posts on the first few days or use consecutive dates only. Each post uses its assigned date exactly:
${dateScheduleLines || '(one date per post in variation assignments above)'}

# CONTENT DIRECTION (MANDATORY — primary creative brief for this calendar)
Every post must serve this direction while staying faithful to the brand profile above:
${opts.contentDirection || opts.focus || '(missing — should not happen)'}

# CHANNEL QUOTAS (MANDATORY — exact counts)
This batch must produce EXACTLY ${totalRequired} total posts, distributed precisely:
${mixLines}

These counts are non-negotiable. Each platform+format line produces exactly the count specified.

# POST SLOT ASSIGNMENTS (MANDATORY — output posts[] in this exact order; platform + format are LOCKED per row)
${postSlotLines || '(see variation assignments)'}
Do NOT default to Carousel. Match each row's platform AND format exactly.

${buildFormatContentGuidanceFromPlan(opts.channelPlan)||buildFormatContentGuidanceSection(Object.fromEntries(formatMix.map(e=>[e.platform,e.format])))}

# STRATEGY FRAMEWORK

## A. Funnel Distribution (strict ratio for ${brand.business_model||'B2C'})
- TOFU (Awareness): ${funnelRatio.split('/')[0]}% — Reach, Saves, Shares, Profile Visits
- MOFU (Consideration): ${funnelRatio.split('/')[1]}% — Engagement Rate, Dwell Time, Link Clicks
- BOFU (Conversion): ${funnelRatio.split('/')[2]}% — CTR, Conversion Rate, Lead Volume

Apply this ratio across the channel mix above.

## B. Platform-Specific Posting Behavior
IGNORE generic format suggestions below when POST SLOT ASSIGNMENTS or PLATFORM FORMATS already specify a format — user selection wins.
Use POST SLOT ASSIGNMENTS for platform + format per post. Generic hints (only if no slot assigned):
- Instagram: Reels, Carousels, Stories, Static
- LinkedIn: Document Post, Carousel, Video, Static
- TikTok: vertical video
- YouTube: Shorts or Long-form
- Facebook: Reels, video, Carousel
- X: Post, Thread, Video
- Threads: text, Carousel, video

## C. Intent Classification (every post tagged)
- Educate: How-to, frameworks, data insights → Saves, Watch Time
- Entertain: Humor, storytelling, trends → Rewatch Rate, Shares
- Validate: Proof, testimonials, case studies → Comments, Saves
- Inspire: Vision, transformation, values → Shares, Follows
- Convert: Offer, demo, booking, purchase → CTR, Form Submissions

## D. Hook Category Library (use assigned category per post — diversify mechanisms)
${GUARDRAIL_HOOK_CATEGORIES.map(c=>`- ${c}`).join('\n')}

## E. Content Framework Library (use assigned framework per post)
${GUARDRAIL_FRAMEWORKS.join(', ')}

## F. EVI Scoring (Engagement Velocity Index, 0-10)
EVI = (Hook Strength + Emotional Resonance + Shareability + Platform Fit) / 4
Target EVI ≥ 7.0 for priority pieces.

# OUTPUT REQUIREMENTS

Return a JSON object with this exact structure:
{
  "posts": [
    {
      "date": "YYYY-MM-DD — MUST match the assigned Date for this post index in DATE DISTRIBUTION",
      "day": "Mon|Tue|Wed|Thu|Fri|Sat|Sun — must match the calendar weekday for that date",
      "platform": "must be one of the channels in the quota above",
      "funnel_stage": "TOFU|MOFU|BOFU",
      "intent": "Educate|Entertain|Validate|Inspire|Convert",
      "hook_type": "${hookCats}",
      "hook_category": "same as hook_type",
      "content_angle": "Educational|Contrarian|Story|Myth-busting|Behind-the-scenes (match assignment)",
      "creative_angle": "Educational|Opinion|Trend|Story|Case Study|Data Driven|Psychology|Customer POV|Founder POV|Future Prediction|Myth Busting|Competitive",
      "content_framework": "PAS|AIDA|BAB|Story Arc|etc (match assignment)",
      "emotional_trigger": "Curiosity|Aspiration|Fear|Trust|Pride (match assignment)",
      "perspective": "Founder|Customer|Industry Expert|Observer",
      "audience_awareness": "Unaware|Problem-aware|Solution-aware",
      "business_objective": "Awareness|Consideration|Trust Building|Lead Generation|Conversion|Retention",
      "content_id": "YYYYMMDD_PLAT_NN (codes: IG/LI/TT/YT/FB/X/TH for Threads)",
      "format": "Reel|Carousel|Static|Story|Short|Long-form Video|Thread|Live|Document Post",
      "hook": "production-ready 8-15 word headline — ${brand.brand_language||'Global English'} spelling/idiom, tone: ${brand.brand_tone||'on-brand'}, personality: ${brand.brand_personality||'on-brand'}, specific to ${brand.name}",
      "caption_preview": "2-3 line caption max 220 chars, ${brand.brand_language||'Global English'}, fold-optimized first line",
      "creative_direction": "MUST match assigned format (Reel=video shots, Carousel=slides, Static=image layout, etc.) max 200 chars",
      "visual_specs": "style + color + dimensions max 120 chars",
      "cta": "exact CTA text — vary CTA style across posts",
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
2. Each post's date and day MUST match its row in DATE DISTRIBUTION / variation assignments (even spread across all ${opts.totalDays} days)
3. Each post's platform and format MUST match CHANNEL QUOTAS and PLATFORM FORMATS exactly
4. Each platform's count MUST match the quota above exactly
5. Hook, caption_preview, and creative_direction MUST match the post's platform format (see FORMAT CONTENT GUIDANCE)
6. Every hook is production-grade — no placeholders, no banned generic phrases
7. Each post uses its assigned variation row — distinct angle, framework, trigger, hook category
8. No two hooks in this batch may share the same opening words or sentence structure
9. Caption_preview first line complements (not duplicates) the hook
10. JSON must be syntactically valid: escape internal quotes with \\", escape newlines with \\n
11. No trailing commas. No markdown code fences. Start response with { and end with }`;
}

async function runAutoBriefsAll(){
  if(!state.activeCalendar?.posts?.length){
    showToast('No calendar posts to brief','err');
    return;
  }
  const posts = state.activeCalendar.posts;
  const pending = posts.filter(p=>!findBriefForPost(p));
  if(!pending.length){
    showToast('Every post already has a brief','ok');
    return;
  }
  const skipped = posts.length - pending.length;
  const log = [];
  const setLoading = (body)=>{
    state.modal = {kind:'loading', title:'Generating all briefs…', body, log:[...log]};
    render({modalOnly:true});
  };
  setLoading(
    skipped
      ? `Building ${pending.length} briefs (${skipped} skipped — already have a brief).`
      : `Building ${pending.length} production-grade briefs for every post in this calendar.`
  );
  let made = 0;
  try{
    for(let i = 0; i < pending.length; i++){
      const p = pending[i];
      const label = (p.hook || p.content_id || `Post ${i + 1}`).slice(0, 60);
      log.push(`▸ ${i + 1}/${pending.length} · ${label}`);
      setLoading(`Brief ${i + 1} of ${pending.length}…`);
      const brief = await generateBriefForPost(p);
      await addBriefVariantForPost(state.activeBrandId, p, brief, 'generated', { activate: true });
      made++;
      log[log.length - 1] = `✓ ${i + 1}/${pending.length} · ${label}`;
    }
    await refreshBriefsState(state.activeBrandId);
    clearModalState();
    render();
    showToast(`${made} brief${made === 1 ? '' : 's'} generated`,'ok');
  }catch(e){
    await refreshBriefsState(state.activeBrandId);
    clearModalState();
    render();
    showToast(
      made
        ? `Stopped after ${made} brief${made === 1 ? '' : 's'}: ${e.message}`
        : 'Brief generation failed: ' + e.message,
      'err'
    );
  }
}

async function briefFromPost(post, opts={}){
  if(!post||!state.activeBrandId) return;
  const stayOnCalendar=!!opts.stayOnCalendar;
  const {platform,format}=resolvePostFormatForBrief(post);
  openModal({kind:'loading',title:'Generating brief…',body:`Building brief for ${platform} · ${format} (matches your selected format).`});
  try{
    const brief=await generateBriefForPost({...post,platform,format,calendar_id:post.calendar_id||state.activeCalendar?.id});
    brief.content_id=brief.content_id||post.content_id||'';
    const hadBrief = !!findBriefForPost(post);
    const saved = await addBriefVariantForPost(state.activeBrandId, post, brief, 'generated', { activate: !hadBrief });
    await refreshBriefsState(state.activeBrandId);
    if(stayOnCalendar){
      clearModalState();
      render();
      showToast(hadBrief ? 'New brief copy saved — Set as active in View Brief' : 'Brief generated and set as active','ok');
    }else{
      state.modal={kind:'view-brief',data:saved};
      render();
      showToast(hadBrief ? 'New copy added — choose Set as active below' : 'Brief generated','ok');
    }
  }catch(e){ clearModalState(); render(); showToast('Failed: '+e.message,'err'); }
}

async function briefFromCurrentPost(){
  const stayOnCalendar=!!state.modal?.briefFlow;
  return briefFromPost(state.modal.data, {stayOnCalendar});
}

async function regenerateBriefScriptOnly(post,brand,partial,reasons){
  const {platform,format}=resolvePostFormatForBrief(post);
  const toneCombo={tone_primary:partial.tone_primary||'Direct',tone_secondary:partial.tone_secondary||'Confident'};
  const prompt=`Rewrite ONLY script_copy and visual_direction for this creative brief. Everything else stays conceptually the same.

LOCKED — DO NOT CHANGE:
- platform: ${platform}
- format: ${format}
- hook: ${partial.hook||post.hook||''}

REJECTION (fix this): ${(reasons||[]).join('; ')}

${getFormatCreativePromptRules(format,platform)}

script_copy rules: ${getBriefScriptGuideForFormat(format,platform,toneCombo)}

Return JSON: { "script_copy": "...", "visual_direction": "..." }`;
  const json=await callClaudeJSON(prompt,{max_tokens:3000,temperature:0.55});
  return {
    ...partial,
    script_copy:json.script_copy||partial.script_copy,
    visual_direction:json.visual_direction||partial.visual_direction,
    platform,
    format,
  };
}

async function generateBriefForPost(post){
  const brand=state.brands.find(b=>b.id===state.activeBrandId);
  const {platform,format}=resolvePostFormatForBrief(post);
  const lockedPost={
    ...post,
    platform,
    format,
    calendar_id:post.calendar_id||state.activeCalendar?.id||'',
  };
  lockPostSlotFields(lockedPost);

  let briefs=state.briefs||[];
  try{ if(!briefs.length) briefs=await Store.listBriefs(state.activeBrandId); }catch(_){}
  const history=collectContentHistory(state.calendars||[], briefs, state.activeCalendar?.posts||[]);
  const toneCombo=selectToneCombo(history);
  const recentScripts=(history.scripts||[]).slice(0,10).map((s,i)=>`${i+1}. [${s.tone_primary||'?'}+${s.tone_secondary||'?'}] ${String(s.text).slice(0,120)}…`).join('\n')||'(none)';
  const recentHooks=(history.hooks||[]).slice(0,20).map(h=>h.text).filter(Boolean);
  const scriptGuide=getBriefScriptGuideForFormat(format,platform,toneCombo);

  const prompt=`You are a Senior Brand Copywriter. Generate a CMO-ready creative brief.

# LOCKED DELIVERABLE (user selected — non-negotiable)
Platform: ${platform}
Format: ${format}
script_copy MUST be written ONLY for ${format} on ${platform}. Never default to Carousel or slides unless format is Carousel or Document Post.

${getFormatCreativePromptRules(format,platform)}

## script_copy (MANDATORY structure)
${scriptGuide}

## Script tone
Primary: ${toneCombo.tone_primary} | Secondary: ${toneCombo.tone_secondary}
Do not repeat recent script structures:
${recentScripts}

## Brand
${buildBrandContextBlock(brand)}

## Post context
- Content ID: ${lockedPost.content_id||''}
- Calendar ID: ${lockedPost.calendar_id||''}
- Date: ${lockedPost.date||''}
- Funnel: ${lockedPost.funnel_stage||''}
- Hook: ${lockedPost.hook||''}
- Caption: ${lockedPost.caption_preview||''}
- CTA: ${lockedPost.cta||''}

Avoid hooks similar to: ${recentHooks.slice(0,8).map(h=>`"${h}"`).join(', ')||'none'}

Return JSON with EXACT keys:
content_id, platform, format, funnel_stage, evi_score, hook, objective, target_audience, core_message,
script_copy, visual_direction, audio_direction, technical_specs, cta_block, compliance, tone_primary, tone_secondary

platform MUST be "${platform}". format MUST be "${format}".
script_copy and visual_direction MUST match ${format} — NOT slides unless format is Carousel/Document Post.`;

  const json=await callClaudeJSON(prompt,{max_tokens:4096,temperature:0.55});
  let result={
    content_id:lockedPost.content_id,
    calendar_id:lockedPost.calendar_id,
    platform,
    format,
    funnel_stage:lockedPost.funnel_stage,
    evi_score:lockedPost.evi_score,
    hook:json.hook||lockedPost.hook,
    objective:json.objective,
    target_audience:json.target_audience,
    core_message:json.core_message,
    script_copy:json.script_copy,
    visual_direction:json.visual_direction,
    audio_direction:json.audio_direction,
    technical_specs:json.technical_specs,
    cta_block:json.cta_block,
    compliance:json.compliance,
    tone_primary:json.tone_primary||toneCombo.tone_primary,
    tone_secondary:json.tone_secondary||toneCombo.tone_secondary,
  };
  result.platform=platform;
  result.format=format;

  let scriptRetries=0;
  while(scriptRetries<2){
    const scriptIssues=getBriefFormatMismatchReasons(result);
    if(!scriptIssues.length) break;
    try{
      result=await regenerateBriefScriptOnly(lockedPost,brand,result,scriptIssues);
      result.platform=platform;
      result.format=format;
    }catch(_){ break; }
    scriptRetries++;
  }
  result.generation_meta=buildGenerationMeta({...lockedPost,...result},{framework:lockedPost.content_framework,angle:lockedPost.content_angle});
  return result;
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
  const calendarId = content.calendar_id || post?.calendar_id || state.activeCalendar?.id || '';
  const lookup = post || { content_id: contentId, calendar_id: calendarId, platform: content.platform, hook: content.hook, format: content.format, funnel_stage: content.funnel_stage };
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
      calendar_id: calendarId || record.calendar_id,
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
      calendar_id: calendarId,
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
    render({modalOnly:true});
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
    render({modalOnly:true});
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
    content_id: current.content_id, calendar_id: current.calendar_id, platform: current.platform, format: current.format,
    funnel_stage: current.funnel_stage, intent: current.intent || '', hook_type: current.hook_type || '',
    hook: current.hook, caption_preview: current.caption_preview || current.hook,
    cta: current.cta_block || '', evi_score: current.evi_score, date: current.date || '',
    content_framework: current.content_framework, content_angle: current.content_angle,
  };
  openModal({kind:'loading',title:'Regenerating brief…',body:'Building a fresh copy — your current active brief stays until you switch.',log:[]});
  try{
    const prevActive = state.activeBrandId;
    state.activeBrandId = brandId;
    const fresh = await generateBriefForPost(sourcePost);
    state.activeBrandId = prevActive;
    const saved = await addBriefVariantForPost(brandId, sourcePost, fresh, 'regenerated', { activate: false });
    state._briefEdit = null;
    state.modal = { kind:'view-brief', data: saved };
    render({modalOnly:true});
    showToast('New brief copy added — Set as active to use it','ok');
  }catch(e){
    clearModalState();
    render();
    showToast('Regenerate failed: '+e.message,'err');
    console.error(e);
  }
}

/* ===== POST HOOK EDIT ===== */
function startInlineHookEdit(idx){
  const post = state.activeCalendar?.posts?.[idx];
  if(!post) return;
  state._inlineHookEditIdx = idx;
  state._inlineHookDraft = post.hook || '';
  render();
  requestAnimationFrame(()=>{
    const inp = document.querySelector('[data-inline-hook-input]');
    if(inp){ inp.focus(); inp.select(); }
  });
}

function openPostHookEdit(idx){
  const post = state.activeCalendar?.posts?.[idx];
  if(!post) return;
  state._postEdit = applyPostUpdate(post, {});
  state._focusPostField = 'hook';
  openModal({ kind:'post-detail', data: post });
}

function captionAfterHookChange(oldHook, newHook, caption){
  const c = String(caption || '').trim();
  const h = String(oldHook || '').trim();
  if(!c || c === h) return newHook;
  const parts = splitHookHeadline(oldHook, caption);
  if(!parts.caption) return newHook;
  return `${newHook}\n${parts.caption}`;
}

function applyPostUpdate(current, patch){
  const updated = {...current, ...patch, savedAt: Date.now()};
  delete updated.versions;
  delete updated.regenerated;
  return updated;
}

async function persistPostHookChange(post, newHook){
  const trimmed = String(newHook ?? '').trim();
  if(!trimmed){ showToast('Hook cannot be empty','err'); return null; }
  const cal = state.activeCalendar;
  if(!cal?.posts || !post) return null;
  const idx = cal.posts.findIndex(p=>p===post || (p.content_id && post.content_id && p.content_id===post.content_id));
  if(idx === -1){ showToast('Post not found in calendar','err'); return null; }
  const current = cal.posts[idx];
  if((current.hook || '').trim() === trimmed) return current;

  const updated = applyPostUpdate(current, {
    hook: trimmed,
    caption_preview: captionAfterHookChange(current.hook, trimmed, current.caption_preview),
  });
  cal.posts[idx] = updated;
  try{
    await Store.saveCalendar(cal.brandId, cal);
    state.calendars = await Store.listCalendars(cal.brandId);
    state.activeCalendar = state.calendars.find(c=>c.id===cal.id) || cal;
    return updated;
  }catch(e){
    showToast('Save failed: '+e.message,'err');
    console.error(e);
    return null;
  }
}

async function saveInlineHook(postIdx){
  if(postIdx == null || postIdx < 0) return;
  const inp = document.querySelector('[data-inline-hook-input]');
  if(inp) state._inlineHookDraft = inp.value;
  const post = state.activeCalendar?.posts?.[postIdx];
  if(!post) return;
  const updated = await persistPostHookChange(post, state._inlineHookDraft);
  if(!updated) return;
  state._inlineHookEditIdx = null;
  state._inlineHookDraft = null;
  render();
  showToast('Hook updated','ok');
}

/* ===== POST EDIT / SAVE / REGENERATE / RESTORE ===== */
async function savePostEdit(){
  const current = state.modal.data;
  const edited = state._postEdit;
  if(!current || !edited || !state.activeCalendar){ return; }
  const cal = state.activeCalendar;
  const idx = cal.posts.findIndex(p=>p===current || (p.content_id && p.content_id===current.content_id));
  if(idx === -1){ showToast('Post not found in calendar','err'); return; }
  const updated = applyPostUpdate(current, edited);
  cal.posts[idx] = updated;
  try{
    await Store.saveCalendar(cal.brandId, cal);
    state.calendars = await Store.listCalendars(cal.brandId);
    state.activeCalendar = state.calendars.find(c=>c.id===cal.id) || cal;
    state._postEdit = null;
    state.modal = {kind:'post-detail', data: updated};
    render();
    showToast('Post saved','ok');
  }catch(e){ showToast('Save failed: '+e.message,'err'); console.error(e); }
}

async function regeneratePost(){
  const current = state.modal.data;
  if(!current || !state.activeCalendar){ return; }
  const cal = state.activeCalendar;
  const brand = state.brands.find(b=>b.id===cal.brandId);
  if(!brand){ showToast('Brand not found','err'); return; }
  openModal({kind:'loading',title:'Regenerating post…',body:'Building a fresh version with uniqueness guardrails.',log:[]});
  try{
    let briefs=state.briefs||[];
    try{ if(!briefs.length) briefs=await Store.listBriefs(cal.brandId); }catch(_){}
    const history=collectContentHistory(state.calendars||[], briefs, cal.posts.filter(p=>p!==current));
    const assignment=selectVariationPlan(history,1)[0];
    const siblingHooks=cal.posts.filter(p=>p!==current).map(p=>p.hook).filter(Boolean).slice(0,15);
    const prompt = `You are a Senior Brand Copywriter (15+ years, Ogilvy/W+K/Leo Burnett/DDB). Regenerate a single content post with a strategically distinct angle.

BRAND: ${brand.name} | ${brand.vertical||''} | ${brand.business_model||''} | ${brand.location||''}
TARGET: ${brand.target_customer_profile||''}
BRAND TONE: ${brand.brand_tone||brand.brand_tone_personality||brand.brand_voice||''}
BRAND PERSONALITY: ${brand.brand_personality||''}
LANGUAGE: ${brand.brand_language||'Global English'} (mandatory — spelling, idioms, cultural tone)

KEEP THESE LOCKED:
- Date: ${current.date}
- Platform: ${current.platform}
- Format: ${current.format}
- Funnel Stage: ${current.funnel_stage}
- Content ID: ${current.content_id}

MANDATORY VARIATION (do not reuse previous combo):
- Content Angle: ${assignment.angle}
- Creative Angle: ${assignment.creative_angle}
- Framework: ${assignment.framework}
- Emotional Trigger: ${assignment.emotional_trigger}
- Hook Category: ${assignment.hook_category}
- Perspective: ${assignment.perspective}
- Business Objective: ${assignment.business_objective}

PREVIOUS (do NOT repeat angle, structure, or phrasing):
- Hook: "${current.hook||''}"
- Caption: "${current.caption_preview||''}"

OTHER CALENDAR HOOKS TO AVOID:
${siblingHooks.map((h,i)=>`${i+1}. "${h}"`).join('\n')||'(none)'}

BANNED: generic fluff, clichés, "Did you know", "Here are 3 ways", "Most businesses".

Return JSON with these EXACT keys:
hook, caption_preview, intent, hook_type, hook_category, content_angle, creative_angle, content_framework, emotional_trigger, perspective, audience_awareness, business_objective, creative_direction, visual_specs, cta, segment, evi_score, sentiment, status`;
    const json = await callClaudeJSON(prompt, {max_tokens: 2500, temperature: 0.75});
    let updated = applyPostUpdate(current, {
      hook: json.hook || current.hook,
      caption_preview: json.caption_preview || current.caption_preview,
      intent: json.intent || current.intent,
      hook_type: json.hook_category || json.hook_type || assignment.hook_category,
      creative_direction: json.creative_direction || current.creative_direction,
      visual_specs: json.visual_specs || current.visual_specs,
      cta: json.cta || current.cta,
      segment: json.segment || current.segment,
      evi_score: typeof json.evi_score === 'number' ? json.evi_score : current.evi_score,
      sentiment: json.sentiment || current.sentiment,
      status: json.status || current.status,
    });
    updated.hook_category = json.hook_category || json.hook_type || assignment.hook_category;
    updated.content_angle = json.content_angle || assignment.angle;
    updated.creative_angle = json.creative_angle || assignment.creative_angle;
    updated.content_framework = json.content_framework || assignment.framework;
    updated.emotional_trigger = json.emotional_trigger || assignment.emotional_trigger;
    updated.perspective = json.perspective || assignment.perspective;
    updated.audience_awareness = json.audience_awareness || assignment.audience_awareness;
    updated.business_objective = json.business_objective || assignment.business_objective;
    updated.generation_meta = buildGenerationMeta(updated, assignment);

    const check = validatePostContent(updated, history, cal.posts.filter(p=>p!==current));
    if(!check.valid){
      updated = await regenerateCalendarPost(updated, brand, history, assignment, check.reasons);
    }
    const idx = cal.posts.findIndex(p=>p===current || (p.content_id && p.content_id===current.content_id));
    if(idx !== -1) cal.posts[idx] = updated;
    await Store.saveCalendar(cal.brandId, cal);
    state.calendars = await Store.listCalendars(cal.brandId);
    state.activeCalendar = state.calendars.find(c=>c.id===cal.id) || cal;
    state.modal = {kind:'post-detail', data: updated};
    render({modalOnly:true});
    showToast('Post regenerated','ok');
  }catch(e){
    clearModalState();
    render();
    showToast('Regenerate failed: '+e.message,'err');
    console.error(e);
  }
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
BRAND TONE: ${brand.brand_tone||brand.brand_tone_personality||brand.brand_voice||'-'}
BRAND PERSONALITY: ${brand.brand_personality||'-'}
BRAND LANGUAGE: ${brand.brand_language||'Global English'}

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
    clearModalState();
    render();
    showToast('Industry intel refreshed','ok');
  }catch(e){ clearModalState(); render(); showToast('Fetch failed: '+e.message,'err'); console.error('Trends error:',e); }
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
  {key:'slno', label:'Sl. No.'},
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
    row.slno = (p.calendarIdx ?? p._idx ?? 0) + 1;
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
  if(col.key === 'slno') return String(row.slno ?? (row.calendarIdx ?? 0) + 1);
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
    slno: 52, date: 96, day: 72, platform: 100, funnel_stage: 78, hook_headline: 340, format: 110, intent: 140,
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
  if(col.key === 'slno') return `<span style="font-family:ui-monospace,monospace">${mdEscapeHtml(exportCellValue(row, col))}</span>`;
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
    if(c.key==='slno') return {wch:8};
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
  const PDF_COL_WIDTH = {
    slno:'4%', date:'8%', day:'5%', platform:'9%', funnel_stage:'6%', hook_headline:'16%',
    format:'7%', intent:'7%', evi_score:'5%', cta:'9%', hook_type:'7%', brief_script_copy:'17%',
  };
  const pdfExportCell = (row, col)=>{
    const ev = row.evi_score||0;
    const evCls = ev>=7.5?'evi-high':ev>=5.5?'evi-mid':'evi-low';
    const brief = String(row.brief_script_copy||'').trim();
    switch(col.key){
      case 'slno':
        return `<td class="mono slno-cell">${pdfText(exportCellValue(row, col))}</td>`;
      case 'date':
        return `<td class="date-cell">${pdfText(row.date||'')}</td>`;
      case 'day':
        return `<td class="day-cell">${pdfText(row.day||'')}</td>`;
      case 'platform':
        return `<td class="platform-cell"><strong>${pdfText(row.platform||'')}</strong></td>`;
      case 'funnel_stage':
        return `<td><span class="pill" style="background:${stageColor(row.funnel_stage)}">${pdfText(row.funnel_stage||'')}</span></td>`;
      case 'hook_headline':
        return `<td class="hook-cell">${pdfHookCell(row)}</td>`;
      case 'evi_score':
        return `<td class="evi ${evCls}">${ev.toFixed(1)}</td>`;
      case 'brief_script_copy':
        return `<td class="brief-cell">${brief ? pdfText(brief) : '<span class="muted">—</span>'}</td>`;
      case 'cta':
        return `<td class="wrap-cell">${pdfText(row.cta||'')}</td>`;
      case 'hook_type':
        return `<td class="small">${pdfText(row.hook_type||'')}</td>`;
      default:
        return `<td>${pdfText(exportCellValue(row, col))}</td>`;
    }
  };
  const bodyRows = rows.map(p=>
    `<tr>${REPORT_EXPORT_COLS.map(c=>pdfExportCell(p,c)).join('')}</tr>`
  ).join('');

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
  col.slno-col { width: 4%; }
  col.date-col { width: 8%; }
  col.day-col { width: 5%; }
  col.platform-col { width: 9%; }
  th { background: #111827; color: white; padding: 7px 6px; text-align: left; font-weight: 600; font-size: 9px; text-transform: uppercase; letter-spacing: .03em; }
  td { padding: 6px; border-bottom: 1px solid #e5e7eb; vertical-align: top; word-wrap: break-word; overflow-wrap: break-word; }
  td.slno-cell { text-align: center; white-space: nowrap; }
  td.date-cell, td.day-cell, td.platform-cell { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  td.hook-cell, td.wrap-cell, td.brief-cell { white-space: pre-wrap; overflow-wrap: anywhere; }
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
    <colgroup>
      ${REPORT_EXPORT_COLS.map(c=>`<col class="${c.key.replace(/_/g,'-')}-col" style="width:${PDF_COL_WIDTH[c.key]||'8%'}"/>`).join('')}
    </colgroup>
    <thead><tr>
      ${REPORT_EXPORT_COLS.map(c=>`<th>${escHtml(c.label)}</th>`).join('')}
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
  ensureToastHost();
  bindAppHandlersOnce();
  try{
    state.brands=await Store.listBrands();
    state.allBriefs=await Store.listAllBriefs();
    if(state.brands.length) state.activeBrandId=state.brands[0].id;
    if(state.activeBrandId) await loadBrandWorkspace();
    else renderSync();
  }catch(e){
    console.error('Init failed:',e);
    showToast('Init error: '+e.message,'err');
    renderSync();
  }
})();
