// API DreamChat. Работает и локально (node server.cjs), и на Vercel (api/[...all].js).
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {API_KEY='',BASE_URL='https://api.deepseek.com',MODEL='deepseek-chat',DAILY_LIMIT=25,PHOTO_LIMIT=3,
  REPLICATE_API_TOKEN:REPL='',IMAGE_MODEL='black-forest-labs/flux-schnell',FREE_SUBS='1'}=process.env;

// ---- Тарифы. Бесплатный: лимиты в день. Платные: фото считаются в месяц. Infinity = без ограничений ----
const PLANS={
  free:{n:'Бесплатный',msg:+DAILY_LIMIT,ph:+PHOTO_LIMIT,per:'day'},
  plus:{n:'Plus',price:499,msg:Infinity,ph:30,per:'month'},
  vip:{n:'VIP',price:990,msg:Infinity,ph:200,per:'month',long:1},
  super:{n:'SUPER',price:2990,msg:Infinity,ph:Infinity,per:'month',long:1}};

// ---- Хранилище: Upstash Redis (Vercel) или файлы в data/kv (локально) ----
const UP=process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL,UT=process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN;
const DATA=path.join(__dirname,'data'),KD=path.join(DATA,'kv'),kvf=k=>path.join(KD,encodeURIComponent(k)+'.json');
async function rc(a){const r=await fetch(UP,{method:'POST',headers:{Authorization:'Bearer '+UT},body:JSON.stringify(a)}),j=await r.json();if(j.error)throw new Error('Redis: '+j.error);return j.result}
const kv=UP?{
  get:async k=>{const v=await rc(['GET',k]);return v==null?null:JSON.parse(v)},
  set:(k,v,ex)=>rc(ex?['SET',k,JSON.stringify(v),'EX',ex]:['SET',k,JSON.stringify(v)]),
  del:k=>rc(['DEL',k])}:{
  get:async k=>fs.existsSync(kvf(k))?JSON.parse(fs.readFileSync(kvf(k),'utf8')):null,
  set:async(k,v)=>{fs.mkdirSync(KD,{recursive:true});fs.writeFileSync(kvf(k),JSON.stringify(v))},
  del:async k=>{try{fs.unlinkSync(kvf(k))}catch(e){}}};
(function migrate(){ // перенос данных из старой версии (data/db.json) при первом запуске
  try{const o=path.join(DATA,'db.json');if(UP||!fs.existsSync(o)||fs.existsSync(KD))return;fs.mkdirSync(KD,{recursive:true});
    const D=JSON.parse(fs.readFileSync(o,'utf8')),put=(k,v)=>fs.writeFileSync(kvf(k),JSON.stringify(v));
    for(const[l,u]of Object.entries(D.users||{})){put('u:'+l,u);const f=path.join(DATA,'state',u.id+'.json');if(fs.existsSync(f))put('st:'+u.id,JSON.parse(fs.readFileSync(f,'utf8')))}
    for(const[t,l]of Object.entries(D.sessions||{}))put('s:'+t,l);
    const id=path.join(DATA,'img');if(fs.existsSync(id))for(const n of fs.readdirSync(id))put('img:'+n,fs.readFileSync(path.join(id,n)).toString('base64'));
  }catch(e){console.log('migrate:',e.message)}})();

// ---- Помощники ----
const today=()=>new Date().toISOString().slice(0,10);
const hash=(p,s)=>crypto.scryptSync(p,s,64).toString('hex');
const send=(res,code,obj)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(obj))};
async function body(req,max=4e6){let b=req.body;if(b&&typeof b==='object'&&!Buffer.isBuffer(b))return b;if(typeof b==='string')return b?JSON.parse(b):{};
  let s='',n=0;for await(const ch of req){n+=ch.length;if(n>max)throw new Error('слишком большой запрос');s+=ch}return s?JSON.parse(s):{}}
const saveU=u=>kv.set('u:'+u.login.toLowerCase(),u);
async function session(u){const t=crypto.randomBytes(32).toString('hex');await kv.set('s:'+t,u.login.toLowerCase(),2592000);return t}
const planOf=u=>u.plan&&u.until>Date.now()&&PLANS[u.plan]?u.plan:'free';
function info(u){const pk=planOf(u),P=PLANS[pk],d=today(),key=P.per==='day'?d:d.slice(0,7);
  if(u.used?.d!==d)u.used={d,n:0};if(u.photos?.k!==key)u.photos={k:key,n:0};
  return{login:u.login,plan:pk,planName:P.n,sub:pk!=='free',until:u.until||0,
    limit:P.msg===Infinity?-1:P.msg,left:P.msg===Infinity?-1:Math.max(0,P.msg-u.used.n),
    photoLimit:P.ph===Infinity?-1:P.ph,photosLeft:P.ph===Infinity?-1:Math.max(0,P.ph-u.photos.n),photoPer:P.per}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));


// ---- Общие помощники для генерации картинок ----
async function llm(system,user,max=160,temp=.8){
  const r=await fetch(BASE_URL.replace(/\/$/,'')+'/chat/completions',{method:'POST',
    headers:{'Content-Type':'application/json',...(API_KEY&&{Authorization:'Bearer '+API_KEY})},
    body:JSON.stringify({model:MODEL,temperature:temp,max_tokens:max,messages:[{role:'system',content:system},{role:'user',content:user}]})}).then(r=>r.json()).catch(()=>null);
  return (r?.choices?.[0]?.message?.content||'').trim()}
async function draw(p){ // Replicate: создаём задачу, ждём (до ~100 сек), сохраняем в хранилище. Возвращает {fn} или {code,error}
  const rr=await fetch(`https://api.replicate.com/v1/models/${IMAGE_MODEL}/predictions`,{method:'POST',
    headers:{Authorization:'Bearer '+REPL,'Content-Type':'application/json',Prefer:'wait=30'},
    body:JSON.stringify({input:{prompt:p,aspect_ratio:'3:4',num_outputs:1,output_format:'jpg'}})});
  let pj=await rr.json().catch(()=>({}));
  if(!rr.ok)return{code:502,error:'Replicate: '+(pj.detail||pj.title||rr.status)};
  const t0=Date.now();
  while(!['succeeded','failed','canceled'].includes(pj.status)&&pj.urls?.get&&Date.now()-t0<100000){
    await sleep(1500);pj=await fetch(pj.urls.get,{headers:{Authorization:'Bearer '+REPL}}).then(r=>r.json()).catch(()=>pj)}
  if(pj.status==='failed'||pj.status==='canceled')return{code:502,error:'Replicate: '+(pj.error||'генерация не удалась')};
  const out=Array.isArray(pj.output)?pj.output[0]:pj.output;
  if(pj.status!=='succeeded'||!out)return{code:504,error:'сервис фото сейчас перегружен, попробуй ещё раз (лимит не потрачен)'};
  const buf=Buffer.from(await (await fetch(out)).arrayBuffer()),fn=crypto.randomBytes(12).toString('hex')+'.jpg';
  await kv.set('img:'+fn,buf.toString('base64'));
  return{fn}}

// ---- Общие чаты: публичные карточки персонажей (без переписок) лежат одним ключом pub:all ----
const clip=(v,n)=>String(v==null?'':v).slice(0,n);
const okImg=v=>{v=clip(v,500);return /^https:\/\/\S+$/i.test(v)||/^\/api\/img\/[a-f0-9]{24}\.jpg$/.test(v)?v:''};
function cleanPub(c,owner){
  const tone=Array.isArray(c.tone)&&c.tone.length===4?c.tone.map(x=>Math.max(0,Math.min(10,+x||0))):[5,5,3,5],tk=c.talk&&typeof c.talk==='object'?c.talk:{};
  return{id:clip(c.id,20).replace(/[^a-z0-9]/gi,''),owner,name:clip(c.name,60).trim(),desc:clip(c.desc,1500),rules:clip(c.rules,1500),greet:clip(c.greet,500),
    g:c.g==='m'?'m':'f',tags:clip(c.tags,200),img:okImg(c.img),astyle:c.astyle==='anime'?'anime':'real',tone,
    talk:{st:clip(tk.st,20),em:clip(tk.em,20),ex:clip(tk.ex,300)},ts:Date.now()}}

module.exports=async(req,res)=>{
  const url=req.url.split('?')[0],POST=req.method==='POST';
  try{
    if(!url.startsWith('/api/')&&POST===false){ // запасной вариант: отдать страницу, если хостинг не раздал public сам
      const f=path.join(__dirname,'public','index.html');if(fs.existsSync(f)){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(fs.readFileSync(f))}}
    if(url.startsWith('/api/')&&!UP&&process.env.VERCEL)return send(res,500,{error:'Не подключена база Upstash Redis (см. DEPLOY.md)'});
    if(url.startsWith('/api/img/')){const n=url.slice(9),b=/^[a-f0-9]{24}\.jpg$/.test(n)&&await kv.get('img:'+n);
      if(!b){res.writeHead(404);return res.end()}
      res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'public,max-age=31536000'});return res.end(Buffer.from(b,'base64'))}
    if(url==='/api/register'&&POST){
      const {login='',password=''}=await body(req,1e4),k=String(login).trim().toLowerCase();
      if(!/^[a-z0-9_.@-]{3,40}$/.test(k))return send(res,400,{error:'Логин: 3–40 символов, латиница, цифры, _ . @ -'});
      if(String(password).length<6)return send(res,400,{error:'Пароль минимум 6 символов'});
      if(await kv.get('u:'+k))return send(res,409,{error:'Такой логин уже занят'});
      const salt=crypto.randomBytes(16).toString('hex'),u={id:crypto.randomBytes(8).toString('hex'),login:String(login).trim(),salt,hash:hash(String(password),salt)};
      info(u);await saveU(u);return send(res,200,{token:await session(u),...info(u)});
    }
    if(url==='/api/login'&&POST){
      const {login='',password=''}=await body(req,1e4),u=await kv.get('u:'+String(login).trim().toLowerCase());
      if(!u||!crypto.timingSafeEqual(Buffer.from(hash(String(password),u.salt)),Buffer.from(u.hash)))return send(res,401,{error:'Неверный логин или пароль'});
      return send(res,200,{token:await session(u),...info(u)});
    }
    if(url.startsWith('/api/')){
      const t=(req.headers.authorization||'').replace('Bearer ',''),l=t&&await kv.get('s:'+t),u=l&&await kv.get('u:'+l);
      if(!u)return send(res,401,{error:'auth'});
      if(url==='/api/me')return send(res,200,info(u));
      if(url==='/api/logout'){await kv.del('s:'+t);return send(res,200,{})}
      if(url==='/api/state'){
        if(req.method==='PUT'){await kv.set('st:'+u.id,await body(req));return send(res,200,{ok:1})}
        return send(res,200,(await kv.get('st:'+u.id))||{});
      }
      if(url==='/api/subscribe'&&POST){ // ПОКА БЕСПЛАТНО (FREE_SUBS=1). Позже: включать тариф после оплаты ЮMoney
        const {plan:pk}=await body(req,1e3);
        if(!PLANS[pk]||pk==='free')return send(res,400,{error:'Неизвестный тариф'});
        if(FREE_SUBS!=='1')return send(res,402,{error:'Оплата скоро появится'});
        u.plan=pk;u.until=Date.now()+30*864e5;await saveU(u);return send(res,200,info(u));
      }
      if(url==='/api/chat'&&POST){
        const inf=info(u);if(inf.left===0)return send(res,429,{error:'limit',...inf});
        const {messages=[]}=await body(req,2e6),P=PLANS[inf.plan];
        if(P.long&&messages[0]?.role==='system')messages[0].content+='\nВАЖНО: отвечай развёрнуто и подробно (5–10 предложений), описывай эмоции, жесты и детали. Это важнее правила про короткие ответы.';
        const up=await fetch(BASE_URL.replace(/\/$/,'')+'/chat/completions',{method:'POST',
          headers:{'Content-Type':'application/json',...(API_KEY&&{Authorization:'Bearer '+API_KEY})},
          body:JSON.stringify({model:MODEL,messages,stream:true,temperature:1.1,max_tokens:P.long?1000:400})});
        if(!up.ok){res.writeHead(up.status);return res.end(await up.text())}
        u.used.n++;await saveU(u);
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
        for await(const ch of up.body)res.write(ch);
        return res.end();
      }
      if(url==='/api/image'&&POST){
        if(!REPL)return send(res,503,{error:'генерация фото не настроена (нет REPLICATE_API_TOKEN)'});
        const inf=info(u);if(inf.photosLeft===0)return send(res,429,{error:'photo_limit',...inf});
        const {name='',desc='',g='f',style='anime',ctx=[],hint=''}=await body(req,2e5);
        // 1) текстовая модель пишет английский промпт (только безопасный контент), учитывая пожелание пользователя
        let p=(await llm('Write ONE English image-generation prompt (max 70 words) for a photo the character sends in a chat. Adult character, safe for work, fully clothed, tasteful, no nudity. Describe appearance, clothes, pose, place, lighting. If the user asked for something specific, follow it as long as it stays safe for work. Output only the prompt.',
          `Character: ${name}, ${g==='m'?'male':'female'}. ${desc}\nUser request: ${String(hint).slice(0,300)||'(none, choose a fitting scene)'}\nRecent chat:\n${[].concat(ctx).slice(-6).join('\n')}`))||`${name}, ${desc}, ${hint}`;
        p=(style==='real'?'realistic photo, natural light, smartphone selfie, ':'anime style illustration, high quality, ')+'adult, safe for work, fully clothed, '+p.slice(0,700);
        // 2) Replicate
        const R=await draw(p);if(R.error)return send(res,R.code,{error:R.error});
        u.photos.n++;await saveU(u);
        return send(res,200,{url:'/api/img/'+R.fn,...info(u)});
      }
      if(url==='/api/avatar'&&POST){ // аватарка при создании персонажа. Тратит 1 фото из лимита
        if(!REPL)return send(res,503,{error:'генерация фото не настроена (нет REPLICATE_API_TOKEN)'});
        const inf=info(u);if(inf.photosLeft===0)return send(res,429,{error:'photo_limit',...inf});
        const {name='',desc='',g='f',style='anime',hint=''}=await body(req,2e5);
        let p=(await llm('Write ONE English image-generation prompt (max 60 words) for a character avatar: a portrait, head and shoulders, face clearly visible, centered. Adult character, safe for work, fully clothed, tasteful, no nudity. Describe hair, eyes, expression, clothes, background, lighting. If the user described the look they want, follow it as long as it stays safe for work. If they gave no description, invent a fitting look from the character description. Output only the prompt.',
          `Character: ${String(name).slice(0,60)}, ${g==='m'?'male':'female'}. ${String(desc).slice(0,800)}\nUser wishes for the avatar: ${String(hint).slice(0,400)||'(none, choose by yourself)'}`,140))||`${name}, ${String(desc).slice(0,300)}, ${hint}`;
        p=(style==='real'?'realistic portrait photo, natural light, ':'anime style character portrait illustration, high quality, ')+'adult, safe for work, fully clothed, '+p.slice(0,700);
        const R=await draw(p);if(R.error)return send(res,R.code,{error:R.error});
        u.photos.n++;await saveU(u);
        return send(res,200,{url:'/api/img/'+R.fn,...info(u)});
      }
      if(url==='/api/public'&&!POST){ // список общих персонажей (без переписок и без владельцев)
        const all=(await kv.get('pub:all'))||[];
        return send(res,200,all.map(({owner,...c})=>({...c,mine:owner===u.id})));
      }
      if(url==='/api/public'&&POST){ // опубликовать / обновить своего персонажа
        const {char={}}=await body(req,2e5),c=cleanPub(char,u.id);
        if(!/^[a-z0-9]{5,20}$/i.test(c.id)||!c.name)return send(res,400,{error:'Нужны имя и корректный id'});
        const all=(await kv.get('pub:all'))||[],i=all.findIndex(x=>x.id===c.id);
        if(i>=0){if(all[i].owner!==u.id)return send(res,403,{error:'Это не твой персонаж'});all[i]=c}
        else{if(all.filter(x=>x.owner===u.id).length>=30)return send(res,400,{error:'Можно опубликовать не больше 30 персонажей'});all.unshift(c);if(all.length>1000)all.length=1000}
        await kv.set('pub:all',all);return send(res,200,{ok:1});
      }
      if(url==='/api/public/delete'&&POST){ // убрать своего персонажа из общих (у других сохранятся их копии с историей)
        const {id=''}=await body(req,1e3),all=(await kv.get('pub:all'))||[],c=all.find(x=>x.id===id);
        if(c&&c.owner!==u.id)return send(res,403,{error:'Это не твой персонаж'});
        if(c)await kv.set('pub:all',all.filter(x=>x.id!==id));return send(res,200,{ok:1});
      }
      return send(res,404,{error:'not found'});
    }
    send(res,404,{error:'not found'});
  }catch(e){if(!res.headersSent)return send(res,500,{error:String(e.message||e)});res.end()}
};
