const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { URL } = require('url');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SEED_DATA_DIR = path.join(__dirname, 'seed-data');
const ENV_FILE = path.join(DATA_DIR, 'runtime.env');

function loadEnvFile(p){
  if(!fs.existsSync(p)) return;
  for(const line of fs.readFileSync(p,'utf8').split(/\r?\n/)){
    const s=line.trim(); if(!s||s.startsWith('#')||!s.includes('=')) continue;
    const i=s.indexOf('='); const k=s.slice(0,i).trim(); const v=s.slice(i+1).trim();
    if(process.env[k]===undefined || process.env[k]==='') process.env[k]=v;
  }
}
function loadDotEnv(){
  loadEnvFile(path.join(__dirname,'.env'));
  loadEnvFile(path.join(DATA_DIR,'runtime.env'));
}
function bootstrapPersistentData(){
  fs.mkdirSync(DATA_DIR,{recursive:true});
  const imageDir=path.join(DATA_DIR,'product-images');
  fs.mkdirSync(imageDir,{recursive:true});
  const storeFile=path.join(DATA_DIR,'store.json');
  const seedStore=path.join(SEED_DATA_DIR,'store.json');
  if(!fs.existsSync(storeFile) && fs.existsSync(seedStore)) fs.copyFileSync(seedStore,storeFile);
  const seedImages=path.join(SEED_DATA_DIR,'product-images');
  if(fs.existsSync(seedImages)){
    for(const name of fs.readdirSync(seedImages)){
      const src=path.join(seedImages,name), dst=path.join(imageDir,name);
      if(fs.statSync(src).isFile() && !fs.existsSync(dst)) fs.copyFileSync(src,dst);
    }
  }
}

loadDotEnv();
bootstrapPersistentData();
const PORT = Number(process.env.PORT || 13000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-this-admin-key';
let ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ADMIN_KEY;
let SALES_MANAGER_KEY = process.env.SALES_MANAGER_KEY || 'change-this-sales-key';
let SALES_MANAGER_USERNAME = process.env.SALES_MANAGER_USERNAME || 'sales';
let BALE_BOT_TOKEN = process.env.BALE_BOT_TOKEN || '';
let PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
let ALLOW_DEMO = String(process.env.ALLOW_DEMO || 'true').toLowerCase() === 'true';
const SESSION_SECRET = process.env.SESSION_SECRET || (ADMIN_KEY + ':miniapp-session');
let BALE_POLLING = String(process.env.BALE_POLLING || 'false').toLowerCase() === 'true';
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PRODUCT_IMAGE_DIR = path.join(DATA_DIR, 'product-images');
fs.mkdirSync(PRODUCT_IMAGE_DIR,{recursive:true});

function persistRuntimeEnv(){
  const current={};
  if(fs.existsSync(ENV_FILE)){
    for(const line of fs.readFileSync(ENV_FILE,'utf8').split(/\r?\n/)){
      const t=line.trim(); if(!t||t.startsWith('#')||!t.includes('=')) continue;
      const i=t.indexOf('='); current[t.slice(0,i).trim()]=t.slice(i+1).trim();
    }
  }
  current.PORT=String(PORT); current.HOST=HOST; current.ADMIN_KEY=ADMIN_KEY; current.ADMIN_USERNAME=ADMIN_USERNAME; current.ADMIN_PASSWORD=ADMIN_PASSWORD; current.SALES_MANAGER_KEY=SALES_MANAGER_KEY; current.SALES_MANAGER_USERNAME=SALES_MANAGER_USERNAME; current.SESSION_SECRET=SESSION_SECRET;
  current.BALE_BOT_TOKEN=BALE_BOT_TOKEN; current.PUBLIC_BASE_URL=PUBLIC_BASE_URL;
  current.BALE_POLLING=String(BALE_POLLING); current.ALLOW_DEMO=String(ALLOW_DEMO);
  const order=['PORT','HOST','ADMIN_KEY','ADMIN_USERNAME','ADMIN_PASSWORD','SALES_MANAGER_KEY','SALES_MANAGER_USERNAME','SESSION_SECRET','BALE_BOT_TOKEN','PUBLIC_BASE_URL','BALE_POLLING','ALLOW_DEMO'];
  fs.writeFileSync(ENV_FILE,order.map(k=>`${k}=${current[k]??''}`).join('\n')+'\n','utf8');
}
function isHttpsUrl(v){ try{const u=new URL(String(v||''));return u.protocol==='https:';}catch{return false;} }
function maskToken(t){ if(!t)return ''; const s=String(t); if(s.length<12)return '••••••'; return s.slice(0,5)+'••••••••'+s.slice(-5); }
function normalizeSalesBaleLink(v){
  const raw=String(v||'').trim(); if(!raw)return '';
  try{
    const u=new URL(raw);
    return u.protocol==='https:' ? u.toString() : '';
  }catch{return '';}
}
function salesBaleLinkOf(store){return normalizeSalesBaleLink(store?.supportSettings?.salesBaleLink||'');}

function normalizeMobile(v){
  let x=faDigitsToEn(String(v||'')).replace(/\D/g,'');
  if(x.startsWith('0098')) x='0'+x.slice(4);
  else if(x.startsWith('98') && x.length===12) x='0'+x.slice(2);
  else if(x.startsWith('9') && x.length===10) x='0'+x;
  return /^09\d{9}$/.test(x)?x:'';
}
function hashAppPassword(password){
  const salt=crypto.randomBytes(16).toString('hex');
  const hash=crypto.scryptSync(String(password),salt,32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyAppPassword(password,encoded){
  try{
    const [kind,salt,hex]=String(encoded||'').split('$');
    if(kind!=='scrypt'||!salt||!hex)return false;
    const expected=Buffer.from(hex,'hex'), actual=crypto.scryptSync(String(password),salt,expected.length);
    return expected.length===actual.length && crypto.timingSafeEqual(expected,actual);
  }catch{return false;}
}
function safeCustomerAdmin(c){
  if(!c)return c;
  const {appPasswordHash,...rest}=c;
  return rest;
}
function publicCustomerForApp(store,c){
  if(!c)return null;
  const term=cashTermFor(store,c);
  return {
    id:c.id,
    name:String(c.name||''),
    contact:String(c.contact||''),
    phone:String(c.phone||''),
    status:String(c.status||''),
    cashDiscountType:term.discountType,
    cashDiscountValue:term.discountValue,
    supportUrl:salesBaleLinkOf(store)
  };
}
function requestBaseUrl(req){
  if(PUBLIC_BASE_URL)return PUBLIC_BASE_URL;
  const proto=String(req.headers['x-forwarded-proto']||'http').split(',')[0].trim()||'http';
  return `${proto}://${req.headers.host||`localhost:${PORT}`}`.replace(/\/$/,'');
}
function appVehicleName(pr,store,vehicleFilter=[]){
  const requested=(vehicleFilter||[]).map(x=>String(x||'').trim()).filter(Boolean);
  const raw=String(pr?.vehicle||'').trim();
  const name=String(pr?.name||'').trim();
  if(requested.length){
    for(const wanted of requested){
      const nw=normHeader(wanted), rv=normHeader(raw), nn=normHeader(name);
      if(nw && (rv===nw || rv.includes(nw) || nw.includes(rv) || nn.includes(nw))) return wanted;
    }
  }
  return raw||detectVehicle(name,store)||'سایر';
}
function publicProductForApp(req,store,customer,pr,vehicleFilter=[]){
  const rp=resolvePrice(store,customer,pr), full=productImageFull(pr);
  const imageUrl=full?`${requestBaseUrl(req)}/product-image/${encodeURIComponent(pr.id)}`:'';
  return {
    id:String(pr.id||''),
    code:String(pr.code||''),
    name:String(pr.name||''),
    vehicle:appVehicleName(pr,store,vehicleFilter),
    type:String(pr.type||productGlassCategory(pr,store)||'جلو'),
    active:pr.active!==false,
    price:Number(rp.price||0),
    priceFormatted:Number(rp.price||0).toLocaleString('en-US')+' تومان',
    priceSource:rp.source,
    imageUrl
  };
}
function catalogForApp(req,store,customer,vehicleFilter=[]){
  const wanted=new Set((vehicleFilter||[]).map(x=>normHeader(x)).filter(Boolean));
  let items=(store.products||[]).filter(x=>isBaleVisibleProduct(x,store));
  if(wanted.size)items=items.filter(x=>wanted.has(normHeader(appVehicleName(x,store,vehicleFilter))));
  const publicItems=items.map(pr=>publicProductForApp(req,store,customer,pr,vehicleFilter));
  const byVehicle=new Map();
  for(const item of publicItems){
    const key=String(item.vehicle||'سایر').trim()||'سایر';
    if(!byVehicle.has(key))byVehicle.set(key,[]);
    byVehicle.get(key).push(item);
  }
  const order=new Map(normalizedVehicles(store).map((v,i)=>[normHeader(v.name),Number(v.sort||i+1)]));
  const categories=[...byVehicle.entries()].map(([name,rows],i)=>{
    const vehicle=(store.vehicles||[]).find(v=>normHeader(v.name)===normHeader(name));
    const ownImage=String(vehicle?.imageUrl||'').trim();
    const firstImage=rows.find(r=>r.imageUrl)?.imageUrl||'';
    return {
      id:String(vehicle?.id||`VCAT-${i+1}`),
      name,
      imageUrl:ownImage||firstImage,
      productCount:rows.length,
      sort:order.get(normHeader(name))??10000+i
    };
  }).sort((a,b)=>a.sort-b.sort||a.name.localeCompare(b.name,'fa'));
  return {items:publicItems,categories};
}

function ensureStoreShape(store){
  if(!store.carts || typeof store.carts!=='object' || Array.isArray(store.carts)) store.carts={};
  if(!store.botTexts || typeof store.botTexts!=='object') store.botTexts={};
  if(!Array.isArray(store.auditLog)) store.auditLog=[];
  if(!Array.isArray(store.salesHistory)) store.salesHistory=[];
  if(!store.paymentSettings || typeof store.paymentSettings!=='object' || Array.isArray(store.paymentSettings)) store.paymentSettings={};
  store.paymentSettings={cashEnabled:true,paymentUrl:'',...store.paymentSettings};
  // پرداخت نقدی برای همه مشتریان در دسترس است؛ تفاوت فقط در تخفیف هر مشتری است.
  store.paymentSettings.cashEnabled=true;
  if(!store.customerCashTerms || typeof store.customerCashTerms!=='object' || Array.isArray(store.customerCashTerms)) store.customerCashTerms={};
  if(!Array.isArray(store.phoneChangeRequests)) store.phoneChangeRequests=[];
  if(!store.supportSettings || typeof store.supportSettings!=='object' || Array.isArray(store.supportSettings)) store.supportSettings={};
  store.supportSettings={salesBaleLink:'',...store.supportSettings};
  if(store.glassTypeRules!==undefined && !Array.isArray(store.glassTypeRules)) store.glassTypeRules=[];
  if(!Array.isArray(store.vehicles)){
    const names=[...new Set([...(store.products||[]).map(p=>String(p.vehicle||'').trim()),...((store.vehicleRules||[]).map(r=>String(r?.vehicle||'').trim()))].filter(v=>v&&v!=='سایر'))];
    store.vehicles=names.sort((a,b)=>a.localeCompare(b,'fa')).map((name,i)=>({id:`V-${String(i+1).padStart(4,'0')}`,name,sort:i+1}));
  }
  return store;
}
function readStore(){ return ensureStoreShape(JSON.parse(fs.readFileSync(DATA_FILE,'utf8'))); }
function writeStore(store){
  ensureStoreShape(store);
  const tmp=DATA_FILE+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(store,null,2),'utf8'); fs.renameSync(tmp,DATA_FILE);
}
function json(res,status,obj){
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(obj));
}
function text(res,status,body,type='text/plain; charset=utf-8',extra={}){res.writeHead(status,{'Content-Type':type,...extra});res.end(body);}
function parseBody(req){return new Promise((resolve,reject)=>{let data='';req.on('data',c=>{data+=c;if(data.length>32e6){reject(new Error('payload too large'));req.destroy();}});req.on('end',()=>{try{resolve(data?JSON.parse(data):{});}catch(e){reject(e);}});req.on('error',reject);});}
function authRole(req,role){
  const auth=String(req.headers.authorization||'');
  if(auth.startsWith('Bearer ')){const ses=verifySession(auth.slice(7));if(ses && ses.role===role)return true;}
  return false;
}
function adminOk(req){ return authRole(req,'admin') || req.headers['x-admin-key'] === ADMIN_KEY; }
function salesOk(req){ return authRole(req,'sales') || req.headers['x-sales-key'] === SALES_MANAGER_KEY; }
function safeEq(a,b){
  const aa=Buffer.from(String(a??'')); const bb=Buffer.from(String(b??''));
  return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);
}
function uid(prefix, items){ let n=items.length+1; let id; do{id=`${prefix}-${String(n++).padStart(4,'0')}`;}while(items.some(x=>x.id===id)); return id; }
function todayFa(){ return new Intl.DateTimeFormat('fa-IR-u-ca-persian',{year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()); }
function nowFaIran(){ const d=new Date(); const date=new Intl.DateTimeFormat('fa-IR-u-ca-persian',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit'}).format(d); const time=new Intl.DateTimeFormat('fa-IR',{timeZone:'Asia/Tehran',hour:'2-digit',minute:'2-digit',hour12:false}).format(d); return `${date} ${time}`; }
function nextAppOrderId(store,customer){ const customerNo=String(customer?.id||'').trim()||'UNKNOWN'; const prefix=`ALM-${customerNo}-`; let max=0; for(const o of (store.orders||[])){ const id=String(o?.id||''); if(id.startsWith(prefix)){ const n=Number(id.slice(prefix.length)); if(Number.isFinite(n)&&n>max)max=n; } } return `${prefix}${max+1}`; }
function statusFa(s){return ({registered:'ثبت شده',approved:'تأیید فروش',preparing:'در حال آماده‌سازی',ready:'آماده ارسال',sent:'ارسال شده',cancelled:'لغو شده'})[s]||s;}
function normalizeFaSearch(v){return String(v||'').toLocaleLowerCase('fa').replace(/ي/g,'ی').replace(/ك/g,'ک').replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[-_\s]+/g,' ').trim();}
function productImageFull(pr){if(!pr?.imageFile)return '';const f=path.basename(pr.imageFile);const full=path.join(PRODUCT_IMAGE_DIR,f);return fs.existsSync(full)?full:'';}
function imageMimeFromName(name){const e=path.extname(name).toLowerCase();return e==='.png'?'image/png':e==='.webp'?'image/webp':'image/jpeg';}
function saveProductImage(productId,dataUrl){
  const m=String(dataUrl||'').match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/); if(!m)throw new Error('فرمت عکس معتبر نیست');
  const buf=Buffer.from(m[2],'base64'); if(!buf.length||buf.length>4*1024*1024)throw new Error('حجم عکس باید کمتر از ۴ مگابایت باشد');
  const ext=m[1]==='png'?'.png':m[1]==='webp'?'.webp':'.jpg'; const filename=`${String(productId).replace(/[^A-Za-z0-9_-]/g,'_')}${ext}`;
  for(const oldExt of ['.jpg','.png','.webp']){const old=path.join(PRODUCT_IMAGE_DIR,`${String(productId).replace(/[^A-Za-z0-9_-]/g,'_')}${oldExt}`);if(fs.existsSync(old)&&old!==path.join(PRODUCT_IMAGE_DIR,filename))try{fs.unlinkSync(old)}catch{}}
  fs.writeFileSync(path.join(PRODUCT_IMAGE_DIR,filename),buf); return filename;
}
function removeProductImage(pr){const full=productImageFull(pr);if(full)try{fs.unlinkSync(full)}catch{};pr.imageFile='';}


const AUDIT_FIELD_LABELS={name:'نام',contact:'نام رابط',phone:'شماره تماس',baleUserId:'شناسه بله',priceGroup:'گروه قیمت',status:'وضعیت',code:'کد کالا',vehicle:'خودرو',type:'دسته شیشه',basePrice:'قیمت پایه',active:'فعال/غیرفعال',groupPrices:'قیمت گروه‌ها',price:'قیمت'};
function makeChanges(before,after,fields){const out=[];for(const f of fields){const a=before?.[f],b=after?.[f];if(JSON.stringify(a)!==JSON.stringify(b))out.push({field:f,label:AUDIT_FIELD_LABELS[f]||f,from:a??'',to:b??''});}return out;}
function addAudit(store,entry={}){ return null; }
function addSalesHistory(store,entry={}){ensureStoreShape(store);const item={id:`SALELOG-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,at:new Date().toISOString(),orderId:String(entry.orderId||''),customerName:String(entry.customerName||''),from:String(entry.from||''),to:String(entry.to||''),note:String(entry.note||'').slice(0,500),actor:'sales-manager'};store.salesHistory.unshift(item);if(store.salesHistory.length>5000)store.salesHistory.length=5000;return item;}
function faDigitsToEn(v){return String(v??'').replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d));}
function numberFromCell(v){const x=faDigitsToEn(v).replace(/[,٬،\s]/g,'').replace(/تومان|ریال/gi,'').trim();const n=Number(x);return Number.isFinite(n)?n:0;}
function xmlDecode(v){return String(v||'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)));}
function readZipEntries(buf){let eocd=-1;for(let i=buf.length-22;i>=Math.max(0,buf.length-66000);i--){if(buf.readUInt32LE(i)===0x06054b50){eocd=i;break;}}if(eocd<0)throw new Error('فایل XLSX معتبر نیست.');const count=buf.readUInt16LE(eocd+10),centralOffset=buf.readUInt32LE(eocd+16);let pos=centralOffset;const out={};for(let k=0;k<count;k++){if(pos+46>buf.length||buf.readUInt32LE(pos)!==0x02014b50)break;const method=buf.readUInt16LE(pos+10),compSize=buf.readUInt32LE(pos+20),nameLen=buf.readUInt16LE(pos+28),extraLen=buf.readUInt16LE(pos+30),commentLen=buf.readUInt16LE(pos+32),localOffset=buf.readUInt32LE(pos+42),name=buf.slice(pos+46,pos+46+nameLen).toString('utf8');if(localOffset+30<=buf.length&&buf.readUInt32LE(localOffset)===0x04034b50){const ln=buf.readUInt16LE(localOffset+26),le=buf.readUInt16LE(localOffset+28),start=localOffset+30+ln+le,end=start+compSize;if(end<=buf.length){const raw=buf.slice(start,end);out[name]=method===0?raw:method===8?zlib.inflateRawSync(raw):Buffer.alloc(0);}}pos+=46+nameLen+extraLen+commentLen;}return out;}
function parseXlsxRows(buf){const z=readZipEntries(buf),shared=[],ss=z['xl/sharedStrings.xml']?.toString('utf8')||'';for(const m of ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)){let t='';for(const x of m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))t+=xmlDecode(x[1]);shared.push(t);}let sheetPath='xl/worksheets/sheet1.xml',wb=z['xl/workbook.xml']?.toString('utf8')||'',rel=z['xl/_rels/workbook.xml.rels']?.toString('utf8')||'',sm=wb.match(/<sheet\b[^>]*r:id="([^"]+)"[^>]*>/);if(sm){const rid=sm[1],rr=[...rel.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>(?:<\/Relationship>)?/g)].find(x=>x[1]===rid);if(rr){let t=rr[2].replace(/^\//,'');sheetPath=t.startsWith('xl/')?t:'xl/'+t.replace(/^\.\.\//,'');}}const xml=z[sheetPath]?.toString('utf8');if(!xml)throw new Error('برگه اول فایل Excel خوانده نشد.');const rows=[],colIndex=ref=>{const letters=(String(ref).match(/[A-Z]+/i)||['A'])[0].toUpperCase();let n=0;for(const c of letters)n=n*26+(c.charCodeAt(0)-64);return n-1;};for(const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)){const arr=[];for(const cm of rm[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)){const attrs=cm[1],body=cm[2],ref=(attrs.match(/\br="([^"]+)"/)||[])[1]||'A1',type=(attrs.match(/\bt="([^"]+)"/)||[])[1]||'',idx=colIndex(ref);let val='';if(type==='inlineStr'){const mm=body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);val=mm?xmlDecode(mm[1]):'';}else{const mm=body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);val=mm?xmlDecode(mm[1]):'';if(type==='s')val=shared[Number(val)]??val;else if(type==='b')val=val==='1'?'TRUE':'FALSE';}arr[idx]=val;}rows.push(arr.map(v=>v??''));}return rows;}
function parseCsvRows(text){const rows=[];let row=[],cell='',q=false;for(let i=0;i<text.length;i++){const ch=text[i];if(q){if(ch==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(ch==='"')q=false;else cell+=ch;}else if(ch==='"')q=true;else if(ch===','){row.push(cell);cell='';}else if(ch==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=ch;}row.push(cell.replace(/\r$/,''));if(row.some(x=>String(x).trim()))rows.push(row);return rows;}
function normHeader(v){return normalizeFaSearch(faDigitsToEn(v)).replace(/[()\[\]:._-]/g,' ').replace(/\s+/g,' ').trim();}
function findCol(headers,aliases){const hs=headers.map(normHeader);for(const a of aliases){const n=normHeader(a),i=hs.findIndex(x=>x===n);if(i>=0)return i;}for(const a of aliases){const n=normHeader(a),i=hs.findIndex(x=>x.includes(n)||n.includes(x));if(i>=0)return i;}return -1;}
const VEHICLE_RULES=[
  ['پراید',['پراید']],['پژو 405',['پژو 405','405']],['پژو 206',['پژو 206','206']],['پژو 207',['پژو 207','207']],['پژو پارس',['پژو پارس','پارس','پرشیا']],
  ['زانتیا',['زانتیا','xantia']],['سورن',['سورن']],['سمند',['سمند']],['دنا',['دنا']],['تیبا',['تیبا']],['ساینا',['ساینا']],['کوییک',['کوییک']],['شاهین',['شاهین']],['تارا',['تارا']],['رانا',['رانا']],['آریسان',['آریسان']],['نیسان',['نیسان']],['پیکان',['پیکان']],
  ['ال 90',['ال 90','ال90','l90','تندر 90','تندر90']],['مزدا',['مزدا']],['ساندرو',['ساندرو']],['النترا',['النترا']],['سانتافه',['سانتافه']],['اکسنت',['اکسنت']],['سراتو',['سراتو']],['ریو',['ریو']],
  ['تیگو 5',['تیگو 5','tiggo 5']],['تیگو 7',['تیگو 7','tiggo 7']],['تیگو 8',['تیگو 8','tiggo 8']],['ام وی ام 315',['ام وی ام 315','mvm 315']],['ام وی ام X22',['x22','ایکس 22']],['ام وی ام X33',['x33','ایکس 33']],
  ['جک J5',['جک j5','j5']],['جک S5',['جک s5','s5']],['لیفان 620',['لیفان 620']],['لیفان X60',['لیفان x60','x60']],['برلیانس',['برلیانس']],['هایما S5',['هایما s5']],['هایما S7',['هایما s7']]
];
function normalizedVehicleRules(store){
  const raw=Array.isArray(store?.vehicleRules)?store.vehicleRules:VEHICLE_RULES.map(([vehicle,keywords])=>({vehicle,keywords}));
  return raw.map(r=>Array.isArray(r)?{vehicle:String(r[0]||'').trim(),keywords:Array.isArray(r[1])?r[1]:[]}:{vehicle:String(r.vehicle||'').trim(),keywords:Array.isArray(r.keywords)?r.keywords:[]})
    .filter(r=>r.vehicle&&r.keywords.some(k=>String(k||'').trim()))
    .map(r=>({vehicle:r.vehicle,keywords:[...new Set(r.keywords.map(k=>String(k||'').trim()).filter(Boolean))]}));
}
function materializeVehicleRules(store){if(!Array.isArray(store.vehicleRules))store.vehicleRules=normalizedVehicleRules({...store,vehicleRules:undefined}).map(r=>({vehicle:r.vehicle,keywords:[...r.keywords]}));return store.vehicleRules;}
function normalizedVehicles(store){
  ensureStoreShape(store);
  return (store.vehicles||[]).map((v,i)=>({id:String(v.id||`V-${String(i+1).padStart(4,'0')}`),name:String(v.name||'').trim(),sort:Number(v.sort||i+1)})).filter(v=>v.name&&v.name!=='سایر').sort((a,b)=>a.sort-b.sort||a.name.localeCompare(b.name,'fa'));
}
function ensureVehicleEntry(store,name){
  const n=String(name||'').trim(); if(!n||n==='سایر')return null; ensureStoreShape(store);
  let v=(store.vehicles||[]).find(x=>normHeader(x.name)===normHeader(n));
  if(v)return v; const max=Math.max(0,...(store.vehicles||[]).map(x=>Number(x.sort||0)));
  v={id:uid('V',store.vehicles),name:n,sort:max+1}; store.vehicles.push(v); return v;
}
function vehicleNameExists(store,name){const n=normHeader(name);return normalizedVehicles(store).some(v=>normHeader(v.name)===n);}
const VEHICLE_DESCRIPTOR_PHRASES=[
  'سبز کم رنگ','سبز کمرنگ','سبز پر رنگ','سبز پررنگ','بالا آبی','بالا سبز','بالا دودی','دور مشکی','دورمشکی','دور کروم',
  'بی رنگ','بیرنگ','سفید','سبز','دودی','آبی','برنز','طوسی','شفاف','رنگی',
  'سنسور دار','سنسوردار','سنسور','رادار دار','راداردار','رادار','دوربین دار','دوربین‌دار','دوربین',
  'هد آپ','هدآپ','hud','گرمکن دار','گرمکن‌دار','گرمکن','هیتردار','هیتردار','آنتن دار','آنتن‌دار','آنتن',
  'درجه 1','درجه 2','درجه یک','درجه دو','درجه۱','درجه۲','اسپرت','ساده','لامینت','لمینت',
  'راست','چپ'
];
function normalizeFaKeepCase(v){return String(v||'').replace(/ي/g,'ی').replace(/ك/g,'ک').replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[\t\r\n_-]+/g,' ').replace(/\s+/g,' ').trim();}
function reEscape(v){return String(v).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function extractVehicleCandidate(title){
  let raw=normalizeFaKeepCase(title).replace(/^[\s:،؛-]+|[\s:،؛-]+$/g,'');
  raw=raw.replace(/^(?:شیشه\s*)?(?:جلو|عقب|بغل|لچکی|سانروف)\s+/i,'').replace(/^شیشه\s+/i,'').trim();
  if(!raw)return 'سایر';
  let cut=raw.length;
  const phrases=[...VEHICLE_DESCRIPTOR_PHRASES].sort((a,b)=>b.length-a.length);
  for(const phrase of phrases){
    const parts=normalizeFaKeepCase(phrase).split(/\s+/).map(reEscape).join('\\s*');
    const rx=new RegExp(`(?:^|\\s)${parts}(?=\\s|$)`,'i');
    const m=rx.exec(raw); if(m){const idx=m.index+(m[0].startsWith(' ')?1:0); if(idx<cut)cut=idx;}
  }
  let candidate=raw.slice(0,cut).trim().replace(/[،,:؛\-]+$/,'').trim();
  if(!candidate || candidate.length<2)return 'سایر';
  return candidate;
}
function detectVehicle(title,store){
  const n=normHeader(title);
  const catalog=normalizedVehicles(store).map(v=>v.name).sort((a,b)=>b.length-a.length);
  const existing=[...new Set((store.products||[]).map(x=>x.vehicle).filter(v=>v&&v!=='سایر'))].sort((a,b)=>b.length-a.length);
  const rules=normalizedVehicleRules(store).flatMap((r,ri)=>r.keywords.map(k=>({vehicle:r.vehicle,norm:normHeader(k),ri}))).filter(x=>x.norm).sort((a,b)=>b.norm.length-a.norm.length||a.ri-b.ri);
  for(const r of rules){if(n.includes(r.norm))return r.vehicle;}
  for(const v of catalog){const nv=normHeader(v);if(nv && n.includes(nv))return v;}
  for(const v of existing){const nv=normHeader(v);if(nv && n.includes(nv))return v;}
  return extractVehicleCandidate(title);
}

const GLASS_TYPE_RULES=[
  {type:'سانروف',keywords:['سانروف','sunroof']},
  {type:'لچکی',keywords:['لچکی','مثلثی','quarter']},
  {type:'بغل',keywords:['بغل','درب','جانبی','door glass','side glass']},
  {type:'عقب',keywords:['عقب','شیشه پشت','rear glass','back glass']},
  {type:'جلو',keywords:['جلو','windshield','windscreen']}
];
function normalizedGlassTypeRules(store){
  const raw=Array.isArray(store?.glassTypeRules)&&store.glassTypeRules.length?store.glassTypeRules:GLASS_TYPE_RULES;
  return raw.map(r=>({type:String(r.type||'').trim(),keywords:Array.isArray(r.keywords)?r.keywords:[]}))
    .filter(r=>r.type&&r.keywords.some(k=>String(k||'').trim()))
    .map(r=>({type:r.type,keywords:[...new Set(r.keywords.map(k=>String(k||'').trim()).filter(Boolean))]}));
}
function normalizeGlassCategory(v){
  const n=normHeader(v);
  if(!n)return '';
  if(n==='جلو'||n.includes('شیشه جلو'))return 'جلو';
  if(n==='عقب'||n.includes('شیشه عقب'))return 'عقب';
  if(n==='بغل'||n.includes('شیشه بغل')||n.includes('جانبی'))return 'بغل';
  if(n==='لچکی'||n.includes('مثلثی'))return 'لچکی';
  if(n==='سانروف')return 'سانروف';
  if(n==='سایر')return 'سایر';
  return '';
}
function detectGlassType(title,store){
  const n=normHeader(title);
  const rules=normalizedGlassTypeRules(store).flatMap((r,ri)=>r.keywords.map(k=>({type:r.type,norm:normHeader(k),ri}))).filter(x=>x.norm).sort((a,b)=>b.norm.length-a.norm.length||a.ri-b.ri);
  for(const r of rules){if(n.includes(r.norm))return r.type;}
  return 'سایر';
}
function productGlassCategory(pr,store){
  const explicit=normalizeGlassCategory(pr?.type||'');
  return explicit||detectGlassType(pr?.name||'',store);
}
function isBaleVisibleProduct(pr,store){return !!pr && pr.active!==false && productGlassCategory(pr,store)==='جلو';}
function autoProductCode(name){const n=normalizeFaSearch(String(name||'')).trim();return 'AUTO-'+crypto.createHash('sha1').update(n||String(Date.now())).digest('hex').slice(0,10).toUpperCase();}
function prepareExcelImport(store,filename,dataUrl){
  const m=String(dataUrl||'').match(/^data:.*?;base64,(.+)$/);if(!m)throw new Error('فایل برای ورود معتبر نیست.');
  const buf=Buffer.from(m[1],'base64');if(!buf.length||buf.length>20*1024*1024)throw new Error('حجم فایل باید کمتر از ۲۰ مگابایت باشد.');
  const lower=String(filename||'').toLowerCase();let rows;
  if(lower.endsWith('.csv')){let txt=buf.toString('utf8');if(txt.charCodeAt(0)===0xfeff)txt=txt.slice(1);rows=parseCsvRows(txt);}
  else if(lower.endsWith('.xlsx'))rows=parseXlsxRows(buf);
  else throw new Error('فعلاً فایل XLSX یا CSV پشتیبانی می‌شود.');
  rows=rows.filter(r=>r.some(v=>String(v??'').trim()));if(!rows.length)throw new Error('فایل Excel خالی است.');

  const first=rows[0].map(v=>String(v??'').trim());
  let codeCol=findCol(first,['کد کالا','کد محصول','کد','code','item code']);
  let nameCol=findCol(first,['عنوان کالا','نام کالا','شرح کالا','عنوان محصول','نام محصول','عنوان','product','name']);
  let priceCol=findCol(first,['قیمت پایه','قیمت فروش','قیمت','price']);
  let typeCol=findCol(first,['نوع شیشه','نوع کالا','نوع','type']);
  const hasRecognizedHeader=nameCol>=0||codeCol>=0||priceCol>=0||typeCol>=0;
  let startRow=hasRecognizedHeader?1:0;
  const headers=hasRecognizedHeader?first:first.map((_,i)=>i===0?'عنوان کالا':`ستون ${i+1}`);

  // حالت رایج کارخانه: فقط یک ستون عنوان کالا.
  if(nameCol<0){
    if(first.length===1 || !hasRecognizedHeader) nameCol=0;
    else if(codeCol>=0 && first.length>=2) nameCol=codeCol===0?1:0;
  }
  if(nameCol<0)throw new Error('ستون عنوان کالا پیدا نشد. اگر فایل فقط یک ستون دارد، همان ستون را با عنوان «عنوان کالا» قرار بده.');

  const seen=new Set(),items=[];
  for(let r=startRow;r<rows.length;r++){
    const row=rows[r];
    const name=String(row[nameCol]??'').trim();
    if(!name)continue;
    const suppliedCode=codeCol>=0?String(row[codeCol]??'').trim():'';
    const code=suppliedCode||autoProductCode(name);
    const key=normalizeFaSearch(name);
    if(seen.has(key))continue;seen.add(key);
    const existing=suppliedCode
      ? store.products.find(p=>String(p.code).trim()===suppliedCode)
      : store.products.find(p=>normalizeFaSearch(p.name)===key);
    const vehicle=detectVehicle(name,store);
    const type=typeCol>=0&&String(row[typeCol]??'').trim()?normalizeGlassCategory(String(row[typeCol]).trim())||detectGlassType(name,store):detectGlassType(name,store);
    const price=priceCol>=0?numberFromCell(row[priceCol]):0;
    items.push({code:existing?.code||code,name,vehicle,type,basePrice:price,existingId:existing?.id||'',mode:existing?'update':'new'});
  }
  if(!items.length)throw new Error('هیچ عنوان کالایی در فایل پیدا نشد.');
  const groups={},typeGroups={};for(const x of items){groups[x.vehicle]=(groups[x.vehicle]||0)+1;typeGroups[x.type]=(typeGroups[x.type]||0)+1;}
  return {headers,mapping:{code:codeCol>=0?(headers[codeCol]||'کد کالا'):'تولید خودکار',name:headers[nameCol]||'عنوان کالا',price:priceCol>=0?headers[priceCol]:'ندارد',type:typeCol>=0?headers[typeCol]:'تشخیص هوشمند'},items,groups,typeGroups,total:items.length,newCount:items.filter(x=>x.mode==='new').length,updateCount:items.filter(x=>x.mode==='update').length,singleColumn:nameCol===0&&first.length===1};
}

const DEFAULT_BOT_TEXTS={
  brandTitle:'🏭 فروش شیشه اتومبیل الماس نگین بینالود',
  activeWelcome:'سلام {name} 👋\\nبه فروش شیشه اتومبیل الماس نگین بینالود خوش آمدید.\\n\\nحساب شما فعال است و می‌توانید محصولات را مشاهده کرده و سفارش خود را ثبت کنید.',
  pendingText:'⏳ درخواست دسترسی شما ثبت شده و در انتظار تأیید واحد فروش است.',
  inactiveText:'⛔ حساب شما غیرفعال است. لطفاً با واحد فروش تماس بگیرید.',
  noHttpsNotice:'',
  btnShop:'✨ فروشگاه گرافیکی',
  btnProducts:'محصولات',
  btnSearch:'🔍 جستجو',
  btnCart:'🛒 سبد سفارش',
  btnOrders:'📦 سفارش‌های من',
  btnAccount:'👤 حساب من',
  btnSupport:'☎️ ارتباط با فروش',
  btnHome:'🏠 منوی اصلی',
  btnRestart:'🔄 شروع مجدد',
  btnCheckStatus:'🔄 بررسی وضعیت',
  btnMyId:'🆔 شناسه من',
  myIdText:'🆔 شناسه بله شما:\\n{id}',
  accountText:'👤 حساب مشتری\\n\\nنام: {name}\\nوضعیت: فعال ✅',
  supportText:'☎️ ارتباط با واحد فروش\\n\\nبرای دریافت راهنمایی یا پیگیری سفارش، با واحد فروش شرکت در ارتباط باشید.',
  productsTitle:'انتخاب محصول جدید\\n\\nمدل خودرو را انتخاب کنید:',
  vehicleProductsTitle:'🪟 محصولات {vehicle}\\n\\nمحصول موردنظر را انتخاب کنید:',
  productButtonTemplate:'{name}',
  productCard:'🪟 {name}\\n\\nکد کالا: {code}\\nخودرو: {vehicle}\\nنوع: {type}\\n\\n💰 قیمت: {price} تومان\\n✅ قابل سفارش',
  searchPrompt:'🔍 نام خودرو، نام محصول یا کد کالا را ارسال کنید.\\n\\nمثال: پراید',
  searchResultsTitle:'🔎 نتایج جستجو برای «{query}»',
  searchNoResult:'محصولی با عبارت «{query}» پیدا نشد.',
  cartTitle:'🛒 سبد سفارش شما',
  cartEmpty:'سبد سفارش شما خالی است.',
  cartAdded:'✅ {name} به سبد سفارش اضافه شد.',
  orderConfirmTitle:'✅ تأیید نهایی سفارش\\n\\nلطفاً اقلام و مبلغ سفارش را بررسی کنید.',
  ordersTitle:'📦 آخرین سفارش‌های شما',
  ordersEmpty:'هنوز سفارشی ثبت نشده است.',
  orderStatusChanged:'📦 وضعیت سفارش {orderId} تغییر کرد.\\nوضعیت جدید: {status}',
  orderRegistered:'✅ سفارش {orderId} با موفقیت ثبت شد.\\nمبلغ کل: {total} تومان\\nوضعیت: ثبت شده',
  productCartQty:'🛒 تعداد در سبد: {qty}',
  btnSub1:'➖ 1',
  btnAdd1:'➕ 1',
  btnAdd5:'➕ 5',
  btnAdd10:'➕ 10',
  btnNewProduct:'➕ انتخاب محصول جدید',
  btnOrderNew:'➕ سفارش جدید',
  btnSaveDraft:'💾 ذخیره موقت سفارش',
  currentCartTitle:'🧾 سفارش جاری',
  btnCartEdit:'✏️ حذف/ویرایش سفارش',
  btnAddCartRow:'➕ افزودن ردیف جدید',
  cartEditTitle:'✏️ حذف/ویرایش سفارش',
  cartQtyPrompt:'✏️ تعداد جدید «{name}» را وارد کنید.\\n\\nتعداد فعلی: {qty}',
  btnReorder:'🔁 تکرار این سفارش',
  orderDetailsTitle:'🧾 جزئیات سفارش {orderId}',
  reorderAdded:'✅ اقلام سفارش {orderId} به سبد منتقل شد.'
}
function normalizeBotTexts(store){
  const out={...DEFAULT_BOT_TEXTS,...(store.botTexts||{})};
  if(out.activeWelcome==='سلام {name} 👋\\nحساب شما فعال است و قیمت‌ها به‌صورت اختصاصی نمایش داده می‌شوند.') out.activeWelcome=DEFAULT_BOT_TEXTS.activeWelcome;
  if(out.accountText==='👤 حساب مشتری\\n\\nنام: {name}\\nگروه قیمت: {group}\\nوضعیت: فعال ✅') out.accountText=DEFAULT_BOT_TEXTS.accountText;
  // مهاجرت فقط برای متن‌های پیش‌فرض قدیمی؛ متن سفارشی کاربر تغییر نمی‌کند.
  if(out.btnSearch==='🔍 جستجوی شیشه') out.btnSearch='🔍 جستجو';
  if(out.productsTitle==='🚘 انتخاب خودرو\\n\\nمدل خودرو را انتخاب کنید:' || out.productsTitle==='انتخاب خودرو\\n\\nمدل خودرو را انتخاب کنید:') out.productsTitle=DEFAULT_BOT_TEXTS.productsTitle;
  // برچسب‌های قدیمی تعداد در Bale Web بعضی فونت‌ها عدد را درست نشان نمی‌دادند.
  const qtyLabelMigrations={
    btnSub1:['− ۱','- ۱','➖ ۱','−1','-1'],
    btnAdd1:['＋ ۱','+ ۱','➕ ۱','＋1','+1'],
    btnAdd5:['＋ ۵','+ ۵','➕ ۵','＋5','+5'],
    btnAdd10:['＋ ۱۰','+ ۱۰','➕ ۱۰','＋10','+10']
  };
  for(const [k,olds] of Object.entries(qtyLabelMigrations)){ if(olds.includes(String(out[k]||'').trim())) out[k]=DEFAULT_BOT_TEXTS[k]; }
  for(const k of ['btnProducts','btnSearch','btnCart','btnOrders','btnAccount','btnSupport','btnHome','btnRestart','btnCheckStatus','btnMyId','btnSub1','btnAdd1','btnAdd5','btnAdd10','btnNewProduct','btnOrderNew','btnSaveDraft','btnCartEdit','btnAddCartRow']){if(!String(out[k]||'').trim())out[k]=DEFAULT_BOT_TEXTS[k];}
  return out;
}
function renderBotText(value,vars={}){
  return String(value??'').replace(/\\n/g,'\n').replace(/\{([a-zA-Z0-9_]+)\}/g,(_,k)=>vars[k]??`{${k}}`);
}
function resolvePrice(store,customer,product){
  const cp=store.customerPrices.find(x=>x.customerId===customer.id && x.productId===product.id);
  if(cp) return {price:cp.price,source:'customer'};
  if(product.groupPrices && product.groupPrices[customer.priceGroup]!=null) return {price:product.groupPrices[customer.priceGroup],source:'group'};
  return {price:product.basePrice,source:'base'};
}

function cashTermFor(store,customer){
  ensureStoreShape(store);
  const raw=store.customerCashTerms?.[customer?.id]||{};
  const type=raw.discountType==='fixed'?'fixed':'percent';
  const value=Math.max(0,Number(raw.discountValue||0));
  // پرداخت نقدی برای همه مشتریان فعال است؛ اگر تخفیفی تعریف نشده باشد مقدار آن صفر است.
  return {enabled:true,discountType:type,discountValue:value};
}
function cashTotals(store,customer,total){
  const term=cashTermFor(store,customer),base=Math.max(0,Number(total||0));
  let discount=term.discountType==='fixed'?term.discountValue:(base*term.discountValue/100);
  discount=Math.max(0,Math.min(base,Math.round(discount)));
  return {...term,total:base,discount,payable:Math.max(0,base-discount)};
}
function cashPaymentAvailable(store,customer){
  ensureStoreShape(store);
  return !!customer;
}
function paymentUrlFor(store,customer,amount,total,discount){
  let raw=String(store.paymentSettings?.paymentUrl||'').trim(); if(!raw)return '';
  const vals={amount:String(Math.round(Number(amount||0))),total:String(Math.round(Number(total||0))),discount:String(Math.round(Number(discount||0))),customerId:String(customer?.id||''),baleUserId:String(customer?.baleUserId||'')};
  raw=raw.replace(/\{(amount|total|discount|customerId|baleUserId)\}/g,(_,k)=>encodeURIComponent(vals[k]||''));
  try{const u=new URL(raw);return /^https?:$/.test(u.protocol)?u.toString():'';}catch{return '';}
}

function signSession(payload){
  const body=Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig=crypto.createHmac('sha256',SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifySession(token){
  try{
    const [body,sig]=String(token||'').split('.'); if(!body||!sig) return null;
    const expected=crypto.createHmac('sha256',SESSION_SECRET).update(body).digest('base64url');
    const a=Buffer.from(sig), b=Buffer.from(expected);
    if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) return null;
    const payload=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
    if(!payload.exp || Date.now()>payload.exp) return null;
    return payload;
  }catch{return null;}
}
function appCustomer(req,store){
  const auth=String(req.headers.authorization||'');
  const token=auth.startsWith('Bearer ')?auth.slice(7):'';
  const ses=verifySession(token); if(!ses) return null;
  const c=store.customers.find(x=>x.id===ses.customerId);
  if(!c || c.status!=='active') return null;
  if(ses.appLogin===true) return c;
  return String(c.baleUserId)===String(ses.baleUserId) ? c : null;
}
function validateBaleInitData(initData){
  if(!BALE_BOT_TOKEN) return {ok:false,error:'BALE_BOT_TOKEN تنظیم نشده است'};
  try{
    const params=new URLSearchParams(initData); const sentHash=params.get('hash'); if(!sentHash) return {ok:false,error:'hash missing'};
    params.delete('hash'); const pairs=[...params.entries()].sort(([a],[b])=>a.localeCompare(b));
    const dataCheck=pairs.map(([k,v])=>`${k}=${v}`).join('\n');
    const secret=crypto.createHmac('sha256','WebAppData').update(BALE_BOT_TOKEN).digest();
    const calc=crypto.createHmac('sha256',secret).update(dataCheck).digest('hex');
    const a=Buffer.from(calc,'hex'), b=Buffer.from(sentHash,'hex');
    if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) return {ok:false,error:'invalid signature'};
    const authDate=Number(params.get('auth_date')||0); if(!authDate || (Date.now()/1000-authDate)>86400) return {ok:false,error:'initData expired'};
    const user=JSON.parse(params.get('user')||'{}'); return {ok:true,user};
  }catch(e){ return {ok:false,error:'invalid initData'}; }
}
function customerDeletePanelAddon(){
  return `<style id="m3e-customer-delete-style">
  .m3e-customer-delete-row-btn{background:#b42318!important;color:#fff!important;border:0!important;border-radius:9px!important;padding:7px 10px!important;margin-inline-start:6px!important;cursor:pointer!important;font:700 12px Tahoma,Arial,sans-serif!important;white-space:nowrap!important;line-height:1.7!important}
  .m3e-customer-delete-row-btn:hover{background:#912018!important}
  </style><script id="m3e-customer-delete-addon">(function(){
  if(window.__m3eCustomerDeleteAddon)return;window.__m3eCustomerDeleteAddon=true;
  var nativeFetch=window.fetch.bind(window), token='', customers=[], loading=false, timer=0;
  function txt(v){return String(v==null?'':v).replace(/[\u200c\u200f\u202a-\u202e]/g,'').replace(/\s+/g,' ').trim()}
  function visible(el){if(!el||!el.isConnected)return false;var s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0}
  function capture(headers){try{var h=new Headers(headers||{}),a=h.get('Authorization')||h.get('authorization')||'';if(a.indexOf('Bearer ')===0&&a.length>20)token=a.slice(7)}catch(e){}}
  function takeToken(v){if(typeof v==='string'&&v.length>20)token=v}
  function inspectResponse(url,r){try{var u=String(url||'');if(u.indexOf('/api/auth/admin/login')>=0||u.indexOf('/api/admin/customers')>=0){r.clone().json().then(function(j){if(j&&j.token)takeToken(j.token);if(j&&Array.isArray(j.items)&&u.indexOf('/api/admin/customers')>=0){customers=j.items;schedule()}if(j&&j.ok&&j.token)setTimeout(loadCustomers,40)}).catch(function(){})}}catch(e){}}
  window.fetch=async function(input,init){capture(init&&init.headers);var r=await nativeFetch(input,init);inspectResponse(typeof input==='string'?input:(input&&input.url),r);return r};
  try{var XO=XMLHttpRequest.prototype.open,XS=XMLHttpRequest.prototype.setRequestHeader;XMLHttpRequest.prototype.open=function(m,u){this.__m3eUrl=u;return XO.apply(this,arguments)};XMLHttpRequest.prototype.setRequestHeader=function(k,v){if(String(k).toLowerCase()==='authorization'&&String(v).indexOf('Bearer ')===0)takeToken(String(v).slice(7));return XS.apply(this,arguments)}}catch(e){}
  function collectTokens(){var out=[];function add(v){if(!v||typeof v!=='string')return;if(v.length>20)out.push(v);try{var j=JSON.parse(v);if(j&&typeof j==='object'){['token','accessToken','adminToken','authToken'].forEach(function(k){if(typeof j[k]==='string')out.push(j[k])})}}catch(e){}}
    try{for(var i=0;i<localStorage.length;i++)add(localStorage.getItem(localStorage.key(i)))}catch(e){}
    try{for(var i=0;i<sessionStorage.length;i++)add(sessionStorage.getItem(sessionStorage.key(i)))}catch(e){}
    if(token)out.unshift(token);return Array.from(new Set(out));
  }
  async function loadCustomers(){if(loading)return;loading=true;try{var toks=collectTokens();for(var i=0;i<toks.length;i++){var t=toks[i];try{var r=await nativeFetch('/api/admin/customers',{headers:{'Authorization':'Bearer '+t}});if(r.ok){var j=await r.json();token=t;customers=Array.isArray(j.items)?j.items:[];break}}catch(e){}}}finally{loading=false;schedule()}}
  function panelMarker(){var els=document.querySelectorAll('h1,h2,h3,h4,.title,.card-title,.panel-title,[role="tab"],button,a');for(var i=0;i<els.length;i++){if(!visible(els[i]))continue;var t=txt(els[i].textContent);if(t==='مشتریان'||t.indexOf('لیست مشتریان')>=0||t.indexOf('مدیریت مشتریان')>=0)return true}return false}
  function allMatches(row){var t=txt(row.innerText),out=[];for(var i=0;i<customers.length;i++){var c=customers[i],id=txt(c.id),ph=txt(c.phone||c.contact),bu=txt(c.baleUserId),n=txt(c.name);if((id&&t.indexOf(id)>=0)||(ph&&ph.length>=5&&t.indexOf(ph)>=0)||(bu&&bu.length>=4&&t.indexOf(bu)>=0)||(n&&n.length>1&&t.indexOf(n)>=0))out.push(c)}return out}
  function findCustomer(row){var m=allMatches(row);if(m.length===1)return m[0];if(m.length>1){var t=txt(row.innerText);var strong=m.filter(function(c){var id=txt(c.id),ph=txt(c.phone||c.contact),bu=txt(c.baleUserId);return (id&&t.indexOf(id)>=0)||(ph&&ph.length>=5&&t.indexOf(ph)>=0)||(bu&&bu.length>=4&&t.indexOf(bu)>=0)});if(strong.length===1)return strong[0]}return null}
  function candidateRows(){var sels=['tbody tr','[data-customer-id]','.customer-row','[class*="customer-row"]','[class*="customer-card"]','main [class*="table"] [class*="row"]','main [class*="list"] [class*="item"]','main [class*="card"]'];var arr=[];sels.forEach(function(sel){try{document.querySelectorAll(sel).forEach(function(el){if(visible(el)&&!el.closest('nav,aside')&&!arr.includes(el))arr.push(el)})}catch(e){}});return arr}
  function hostFor(row){var cells=row.querySelectorAll('td');if(cells.length)return cells[cells.length-1];var buttons=row.querySelectorAll('button,a');if(buttons.length){var p=buttons[buttons.length-1].parentElement;if(p&&p!==row)return p}return row}
  function authHeaders(){return token?{'Authorization':'Bearer '+token,'Content-Type':'application/json'}:{'Content-Type':'application/json'}}
  async function removeCustomer(c,row,btn){if(!token){await loadCustomers();if(!token){alert('نشست مدیریت پیدا نشد. یک بار صفحه را تازه‌سازی کنید یا دوباره وارد شوید.');return}}if(!confirm('مشتری «'+(c.name||c.id)+'» حذف شود؟\n\nاین عملیات برای مشتری قدیمی و جدید یکسان است. سفارش‌های قبلی برای سابقه حفظ می‌شوند.'))return;var typed=prompt('برای تأیید نهایی، کلمه حذف را بنویس:','');if(typed!=='حذف')return;btn.disabled=true;btn.textContent='در حال حذف...';try{var r=await nativeFetch('/api/admin/customers/'+encodeURIComponent(c.id),{method:'DELETE',headers:authHeaders()});var j={};try{j=await r.json()}catch(e){}if(!r.ok){alert(j.error||'حذف مشتری انجام نشد');btn.disabled=false;btn.textContent='حذف';return}customers=customers.filter(function(x){return x.id!==c.id});row.style.opacity='.35';setTimeout(function(){row.remove()},180);alert('مشتری «'+(c.name||c.id)+'» حذف شد. سفارش‌های قبلی حفظ شدند.')}catch(e){alert('خطا در حذف مشتری');btn.disabled=false;btn.textContent='حذف'}}
  function mount(){if(!panelMarker())return;if(!customers.length){loadCustomers();return}candidateRows().forEach(function(row){if(row.querySelector('.m3e-customer-delete-row-btn'))return;var c=findCustomer(row);if(!c)return;var host=hostFor(row);var b=document.createElement('button');b.type='button';b.className='m3e-customer-delete-row-btn';b.textContent='حذف';b.title='حذف مشتری '+(c.name||c.id);b.setAttribute('data-customer-id',c.id);b.onclick=function(e){e.preventDefault();e.stopPropagation();removeCustomer(c,row,b)};host.appendChild(b)})}
  function schedule(){clearTimeout(timer);timer=setTimeout(mount,120)}
  new MutationObserver(schedule).observe(document.documentElement,{subtree:true,childList:true});
  document.addEventListener('DOMContentLoaded',function(){loadCustomers();schedule()});
  window.addEventListener('load',function(){loadCustomers();schedule()});
  setTimeout(function(){loadCustomers();schedule()},300);setTimeout(function(){loadCustomers();schedule()},1200);
  })();</script>`;
}
function serveFile(req,res,pathname){
  const routes={'/':'admin.html','/admin':'admin.html','/sales':'sales.html','/app':'app.html'};
  let file=routes[pathname] || pathname.replace(/^\//,'');
  const full=path.normalize(path.join(PUBLIC_DIR,file));
  if(!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return false;
  const ext=path.extname(full).toLowerCase(); const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon'};
  let body=fs.readFileSync(full);
  if(file==='admin.html'){
    let html=body.toString('utf8');
    if(!html.includes('m3e-customer-delete-addon')){
      const addon=customerDeletePanelAddon();
      if(/<head[^>]*>/i.test(html)) html=html.replace(/<head([^>]*)>/i,'<head$1>'+addon);
      else if(/<body[^>]*>/i.test(html)) html=html.replace(/<body([^>]*)>/i,'<body$1>'+addon);
      else html=addon+html;
    }
    body=Buffer.from(html,'utf8');
  }
  text(res,200,body,types[ext]||'application/octet-stream'); return true;
}
async function bale(method,payload){
  if(!BALE_BOT_TOKEN) throw new Error('BALE_BOT_TOKEN not set');
  const r=await fetch(`https://tapi.bale.ai/bot${BALE_BOT_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  const j=await r.json(); if(!j.ok) throw new Error(j.description||'Bale API error'); return j.result;
}
async function baleSendLocalPhoto(chatId,filePath,caption,rows=[]){
  if(!BALE_BOT_TOKEN) throw new Error('BALE_BOT_TOKEN not set');
  const form=new FormData(); form.append('chat_id',String(chatId)); const buf=fs.readFileSync(filePath); form.append('photo',new Blob([buf],{type:imageMimeFromName(filePath)}),path.basename(filePath));
  if(caption)form.append('caption',caption); if(rows.length)form.append('reply_markup',JSON.stringify({inline_keyboard:rows}));
  const r=await fetch(`https://tapi.bale.ai/bot${BALE_BOT_TOKEN}/sendPhoto`,{method:'POST',body:form}); const j=await r.json(); if(!j.ok)throw new Error(j.description||'Bale API error'); return j.result;
}
async function deleteBaleMessage(chatId,messageId){if(!messageId)return;try{await bale('deleteMessage',{chat_id:chatId,message_id:messageId});}catch{}}

const botStates=new Map();
function money(n){ return Number(n||0).toLocaleString('fa-IR'); }
function productButtonText(bt,pr,price){
  const text=renderBotText(bt.productButtonTemplate,{name:pr.name,code:pr.code,vehicle:pr.vehicle,type:pr.type||'شیشه جلو',price:money(price)}).trim();
  return text || `🪟 ${pr.name}`;
}
function activeProducts(store){ return store.products.filter(x=>isBaleVisibleProduct(x,store)); }
function vehiclesOf(store){ return [...new Set(activeProducts(store).map(x=>String(x.vehicle||'سایر').trim()||'سایر'))].sort((a,b)=>a.localeCompare(b,'fa')); }
function chunks(arr,n){ const out=[]; for(let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out; }
function cartObject(store,customerId){ if(!store.carts[customerId]) store.carts[customerId]={}; return store.carts[customerId]; }
function cartEntries(store,customer){
  const c=cartObject(store,customer.id); const rows=[];
  for(const [productId,qtyRaw] of Object.entries(c)){
    const pr=store.products.find(x=>x.id===productId&&isBaleVisibleProduct(x,store)); const qty=Math.max(0,Number(qtyRaw||0));
    if(!pr||!qty) continue; const rp=resolvePrice(store,customer,pr);
    rows.push({product:pr,qty,price:rp.price,lineTotal:rp.price*qty});
  }
  return rows;
}
function currentCartSummary(store,customer,bt=normalizeBotTexts(store),currentProductId=''){
  const entries=cartEntries(store,customer);
  if(!entries.length) return '';
  const totalQty=entries.reduce((a,x)=>a+x.qty,0), total=entries.reduce((a,x)=>a+x.lineTotal,0);
  const body=entries.map((x,i)=>{
    const current=String(x.product.id)===String(currentProductId||'')?'👉 ':'';
    return `${i+1}) ${current}${x.product.name}   ${money(x.qty)} عدد × ${money(x.price)} = ${money(x.lineTotal)} تومان`;
  }).join('\n');
  return `${renderBotText(bt.currentCartTitle||'🧾 سفارش جاری')}

${body}

📦 جمع تعداد: ${money(totalQty)} عدد
💰 جمع سفارش: ${money(total)} تومان`;
}
function appendCurrentCart(base,store,customer,bt=normalizeBotTexts(store),currentProductId=''){
  const summary=currentCartSummary(store,customer,bt,currentProductId);
  return summary?`${base}

${summary}`:base;
}
function draftButtonRows(store,customer,bt=normalizeBotTexts(store)){
  if(!cartEntries(store,customer).length) return [];
  return [
    [{text:bt.btnSaveDraft||'💾 ذخیره موقت سفارش',callback_data:'save_draft'}],
    [{text:'✅ اتمام سفارش و مرحله بعد',callback_data:'order_review'}]
  ];
}
async function saveDraftAndPause(chatId,customer,messageId){
  const store=readStore(),bt=normalizeBotTexts(store),entries=cartEntries(store,customer);
  if(!entries.length) return editOrSendText(chatId,messageId,`${renderBotText(bt.currentCartTitle||'🧾 سفارش جاری')}

هنوز کالایی برای ذخیره وجود ندارد.`,[]);
  // سبد در هر تغییر روی store.json ذخیره می‌شود؛ این فراخوانی صرفاً ذخیره را قطعی و جریان کار را متوقف می‌کند.
  writeStore(store);
  botStates.delete(String(customer.baleUserId||''));
  const summary=currentCartSummary(store,customer,bt);
  return editOrSendText(chatId,messageId,`✅ سفارش موقت ذخیره شد.

${summary}

هر زمان خواستید ادامه دهید، از منوی اصلی «${String(bt.btnCart||'').trim()||DEFAULT_BOT_TEXTS.btnCart}» را بزنید.`,[]);
}
async function showCurrentOrderHub(chatId,customer,messageId){
  const store=readStore(),bt=normalizeBotTexts(store),summary=currentCartSummary(store,customer,bt);
  const txt=summary||`${renderBotText(bt.currentCartTitle||'🧾 سفارش جاری')}\n\nهنوز کالایی در سفارش جاری نیست.`;
  const rows=[[{text:bt.btnOrderNew||'➕ سفارش جدید',callback_data:'vehicles:0'}],...draftButtonRows(store,customer,bt)];
  return editOrSendText(chatId,messageId,txt,rows);
}
function activeHomeKeyboard(bt){
  // برچسب جستجو حتی اگر در داده‌های قدیمی خالی ذخیره شده باشد همیشه نمایش داده می‌شود.
  const searchLabel=String(bt.btnSearch||'').trim()||DEFAULT_BOT_TEXTS.btnSearch;
  const supportLabel=String(bt.btnSupport||'').trim()||DEFAULT_BOT_TEXTS.btnSupport;
  const rows=[
    [{text:String(bt.btnProducts||'').trim()||DEFAULT_BOT_TEXTS.btnProducts},{text:searchLabel}],
    [{text:String(bt.btnCart||'').trim()||DEFAULT_BOT_TEXTS.btnCart},{text:String(bt.btnOrders||'').trim()||DEFAULT_BOT_TEXTS.btnOrders}],
    [{text:supportLabel},{text:String(bt.btnRestart||'').trim()||DEFAULT_BOT_TEXTS.btnRestart}]
  ];
  if(isHttpsUrl(PUBLIC_BASE_URL) && bt.btnShop) rows.unshift([{text:bt.btnShop,web_app:{url:`${PUBLIC_BASE_URL}/app`}}]);
  return {keyboard:rows,resize_keyboard:true};
}
function pendingHomeKeyboard(bt){ return {keyboard:[[{text:bt.btnCheckStatus},{text:bt.btnMyId},{text:bt.btnRestart}]],resize_keyboard:true}; }
async function editOrSendText(chatId,messageId,textMsg,rows=[]){
  const reply_markup=rows.length?{inline_keyboard:rows}:undefined;
  if(messageId){
    try{return await bale('editMessageText',{chat_id:chatId,message_id:messageId,text:textMsg,...(reply_markup?{reply_markup}:{})});}catch{}
  }
  return bale('sendMessage',{chat_id:chatId,text:textMsg,...(reply_markup?{reply_markup}:{})});
}
async function showVehicles(chatId,customer,messageId,page=0){
  const store=readStore(), bt=normalizeBotTexts(store); const vs=vehiclesOf(store); const per=8, pages=Math.max(1,Math.ceil(vs.length/per)); page=Math.max(0,Math.min(page,pages-1));
  const start=page*per, slice=vs.slice(start,start+per); const rows=[[{text:String(bt.btnSearch||'').trim()||DEFAULT_BOT_TEXTS.btnSearch,callback_data:'search_start'}],...chunks(slice.map((v,i)=>({text:v,callback_data:`veh:${start+i}:0`})),2)];
  const nav=[]; if(page>0)nav.push({text:'◀️ قبلی',callback_data:`vehicles:${page-1}`}); if(page<pages-1)nav.push({text:'بعدی ▶️',callback_data:`vehicles:${page+1}`}); if(nav.length)rows.push(nav);
  rows.push(...draftButtonRows(store,customer,bt));
  return editOrSendText(chatId,messageId,appendCurrentCart(renderBotText(bt.productsTitle),store,customer,bt),rows);
}
async function showVehicleProducts(chatId,customer,messageId,vehicleIndex,page=0){
  const store=readStore(),bt=normalizeBotTexts(store),vs=vehiclesOf(store); const vehicle=vs[vehicleIndex]; if(!vehicle)return showVehicles(chatId,customer,messageId,0);
  const items=activeProducts(store).filter(x=>String(x.vehicle||'سایر')===vehicle); const per=6,pages=Math.max(1,Math.ceil(items.length/per)); page=Math.max(0,Math.min(page,pages-1));
  const slice=items.slice(page*per,page*per+per); const rows=[[{text:String(bt.btnSearch||'').trim()||DEFAULT_BOT_TEXTS.btnSearch,callback_data:'search_start'}],...slice.map(p=>{const price=resolvePrice(store,customer,p).price;return [{text:productButtonText(bt,p,price),callback_data:`prod:${p.id}`}];})];
  const nav=[]; if(page>0)nav.push({text:'◀️ قبلی',callback_data:`veh:${vehicleIndex}:${page-1}`}); if(page<pages-1)nav.push({text:'بعدی ▶️',callback_data:`veh:${vehicleIndex}:${page+1}`}); if(nav.length)rows.push(nav);
  rows.push([{text:'↩️ انتخاب محصول جدید',callback_data:'vehicles:0'}]);
  rows.push(...draftButtonRows(store,customer,bt));
  return editOrSendText(chatId,messageId,appendCurrentCart(renderBotText(bt.vehicleProductsTitle,{vehicle}),store,customer,bt),rows);
}
async function showProduct(chatId,customer,messageId,productId,flash='',messageHasPhoto=false){
  const store=readStore(),bt=normalizeBotTexts(store),pr=store.products.find(x=>x.id===productId&&isBaleVisibleProduct(x,store)); if(!pr)return showVehicles(chatId,customer,messageId,0);
  // کارت شلوغ مشخصات محصول حذف شده؛ فقط محصولی که الان در حال تکمیل است و خلاصه سفارش دیده می‌شود.
  const summary=currentCartSummary(store,customer,bt,pr.id);
  let txt=`👉 محصول در حال تکمیل: ${pr.name}`;
  if(summary) txt+=`

${summary}`;
  if(flash)txt=`${flash}

${txt}`;
  const rows=[[{text:String(bt.btnSub1||'').trim()||'➖ 1',callback_data:`addq:${pr.id}:-1`},{text:String(bt.btnAdd1||'').trim()||'➕ 1',callback_data:`addq:${pr.id}:1`},{text:String(bt.btnAdd5||'').trim()||'➕ 5',callback_data:`addq:${pr.id}:5`},{text:String(bt.btnAdd10||'').trim()||'➕ 10',callback_data:`addq:${pr.id}:10`}],[{text:bt.btnNewProduct||'➕ انتخاب محصول جدید',callback_data:`newprod:${pr.id}`}],...draftButtonRows(store,customer,bt)];
  if(messageId&&messageHasPhoto){await deleteBaleMessage(chatId,messageId);messageId=null;}
  return editOrSendText(chatId,messageId,txt,rows);
}
async function showSearchResults(chatId,customer,query,messageId=null,page=0,userId=''){
  const store=readStore(),bt=normalizeBotTexts(store),q=normalizeFaSearch(query);
  const found=activeProducts(store).filter(p=>[p.name,p.code,p.vehicle,p.type].some(v=>normalizeFaSearch(v).includes(q)));
  if(userId) botStates.set(String(userId),{mode:'search_results',query:String(query)});
  if(!found.length){
    const rows=[[{text:'🔄 جستجوی دوباره',callback_data:'search_again'}],[{text:'↩️ انتخاب محصول جدید',callback_data:'vehicles:0'}],...draftButtonRows(store,customer,bt)];
    return editOrSendText(chatId,messageId,appendCurrentCart(renderBotText(bt.searchNoResult,{query}),store,customer,bt),rows);
  }
  const per=8,pages=Math.max(1,Math.ceil(found.length/per)); page=Math.max(0,Math.min(Number(page)||0,pages-1));
  const slice=found.slice(page*per,page*per+per);
  const rows=slice.map(p=>{const price=resolvePrice(store,customer,p).price;return [{text:productButtonText(bt,p,price),callback_data:`prod:${p.id}`}];});
  const nav=[]; if(page>0)nav.push({text:'◀️ قبلی',callback_data:`search_page:${page-1}`}); if(page<pages-1)nav.push({text:'بعدی ▶️',callback_data:`search_page:${page+1}`}); if(nav.length)rows.push(nav);
  rows.push([{text:'🔄 جستجوی جدید',callback_data:'search_again'},{text:'↩️ انتخاب محصول جدید',callback_data:'vehicles:0'}]);
  rows.push(...draftButtonRows(store,customer,bt));
  const title=appendCurrentCart(`${renderBotText(bt.searchResultsTitle,{query})}\n\n${money(found.length)} نتیجه • صفحه ${money(page+1)} از ${money(pages)}`,store,customer,bt);
  return editOrSendText(chatId,messageId,title,rows);
}
async function showCart(chatId,customer,messageId,flash=''){
  const store=readStore(),bt=normalizeBotTexts(store),entries=cartEntries(store,customer);
  if(!entries.length){
    const empty=`${renderBotText(bt.cartTitle)}\n\n${renderBotText(bt.cartEmpty)}`;
    return editOrSendText(chatId,messageId,flash?`${flash}\n\n${empty}`:empty,[[{text:bt.btnAddCartRow||'➕ افزودن ردیف جدید',callback_data:'cart_add_row'}]]);
  }
  const totalQty=entries.reduce((a,x)=>a+x.qty,0),total=entries.reduce((a,x)=>a+x.lineTotal,0);
  let txt=`${renderBotText(bt.cartTitle)}\n\n`+entries.map((x,i)=>`${i+1}) ${x.product.name}\n   ${money(x.qty)} عدد × ${money(x.price)} = ${money(x.lineTotal)} تومان`).join('\n\n')+`\n\n📦 جمع تعداد: ${money(totalQty)} عدد\n💰 جمع سفارش: ${money(total)} تومان`;
  if(flash)txt=`${flash}\n\n${txt}`;
  return editOrSendText(chatId,messageId,txt,[[{text:'✅ اتمام سفارش و مرحله بعد',callback_data:'order_review'}],[{text:bt.btnCartEdit||'✏️ حذف/ویرایش سفارش',callback_data:'cart_edit'}],[{text:'🗑 حذف سبد سفارش',callback_data:'cart_clear'}]]);
}
async function confirmClearCart(chatId,customer,messageId){
  const store=readStore(),entries=cartEntries(store,customer);
  if(!entries.length) return showCart(chatId,customer,messageId);
  const totalQty=entries.reduce((a,x)=>a+x.qty,0);
  return editOrSendText(chatId,messageId,`⚠️ حذف سبد سفارش

${money(totalQty)} عدد کالا در این سبد وجود دارد.
آیا کل سبد حذف شود؟`,[[{text:'🗑 بله، حذف شود',callback_data:'cart_clear_confirm'}],[{text:'↩️ انصراف',callback_data:'cart'}]]);
}
async function clearCart(chatId,customer,messageId){
  const store=readStore();
  store.carts[customer.id]={};
  writeStore(store);
  botStates.delete(String(customer.baleUserId||''));
  return showCart(chatId,customer,messageId,'✅ سبد سفارش حذف شد.');
}
async function showCartEdit(chatId,customer,messageId,flash=''){
  const store=readStore(),bt=normalizeBotTexts(store),entries=cartEntries(store,customer);
  if(!entries.length){
    const txt=`${bt.cartEditTitle||'✏️ حذف/ویرایش سفارش'}\n\n${renderBotText(bt.cartEmpty)}`;
    return editOrSendText(chatId,messageId,flash?`${flash}\n\n${txt}`:txt,[[{text:bt.btnAddCartRow||'➕ افزودن ردیف جدید',callback_data:'cart_add_row'}],[{text:'↩️ بازگشت به سبد',callback_data:'cart'}]]);
  }
  const totalQty=entries.reduce((a,x)=>a+x.qty,0),total=entries.reduce((a,x)=>a+x.lineTotal,0);
  let txt=`${bt.cartEditTitle||'✏️ حذف/ویرایش سفارش'}\n\n`+entries.map((x,i)=>`${i+1}) ${x.product.name} — ${money(x.qty)} عدد`).join('\n')+`\n\n📦 جمع تعداد: ${money(totalQty)} عدد\n💰 جمع مبلغ: ${money(total)} تومان`;
  if(flash)txt=`${flash}\n\n${txt}`;
  const rows=[];
  entries.forEach((x,i)=>rows.push([{text:`✏️ ویرایش تعداد ردیف ${money(i+1)}`,callback_data:`cart_edit_qty:${x.product.id}`},{text:`🗑 حذف ردیف ${money(i+1)}`,callback_data:`cart_delete:${x.product.id}`}])) ;
  rows.push([{text:bt.btnAddCartRow||'➕ افزودن ردیف جدید',callback_data:'cart_add_row'}],[{text:'↩️ بازگشت به سبد',callback_data:'cart'}]);
  return editOrSendText(chatId,messageId,txt,rows);
}
async function promptCartQtyEdit(chatId,customer,messageId,userId,productId){
  const store=readStore(),bt=normalizeBotTexts(store),pr=store.products.find(x=>x.id===productId&&isBaleVisibleProduct(x,store));
  if(!pr)return showCartEdit(chatId,customer,messageId);
  const c=cartObject(store,customer.id),qty=Math.max(1,Number(c[pr.id]||1));
  botStates.set(String(userId),{mode:'cart_edit_qty',productId:pr.id});
  return editOrSendText(chatId,messageId,renderBotText(bt.cartQtyPrompt||DEFAULT_BOT_TEXTS.cartQtyPrompt,{name:pr.name,qty:money(qty)}),[[{text:'↩️ بازگشت به ویرایش',callback_data:'cart_edit'}]]);
}
async function showOrderReview(chatId,customer,messageId){
  const store=readStore(),bt=normalizeBotTexts(store),entries=cartEntries(store,customer); if(!entries.length)return showCart(chatId,customer,messageId);
  const total=entries.reduce((a,x)=>a+x.lineTotal,0); const txt=`${renderBotText(bt.orderConfirmTitle)}\n\n`+entries.map((x,i)=>`${i+1}) ${x.product.name}\n   ${money(x.qty)} عدد × ${money(x.price)} = ${money(x.lineTotal)} تومان`).join('\n\n')+`\n\n📦 جمع تعداد: ${money(entries.reduce((a,x)=>a+x.qty,0))} عدد\n💰 جمع سفارش: ${money(total)} تومان\n\nروش نهایی سفارش را انتخاب کنید:`;
  const rows=[[{text:'🧾 تأیید سفارش و پرداخت اعتباری',callback_data:'order_credit'}],
    [{text:'💳 تأیید سفارش و پرداخت نقدی (تخفیف‌دار)',callback_data:'order_cash'}]];
  rows.push([{text:'↩️ بازگشت به سبد',callback_data:'cart'}]);
  return editOrSendText(chatId,messageId,txt,rows);
}
async function submitCartOrder(chatId,customer,messageId,paymentMethod='credit'){
  const store=readStore(),entries=cartEntries(store,customer); if(!entries.length)return showCart(chatId,customer,messageId);
  const lines=entries.map(x=>({productId:x.product.id,code:x.product.code,name:x.product.name,qty:x.qty,unitPrice:x.price,lineTotal:x.lineTotal})); const total=lines.reduce((a,x)=>a+x.lineTotal,0);
  const order={id:`ALM-${Date.now().toString().slice(-8)}`,customerId:customer.id,customerName:customer.name,baleUserId:String(customer.baleUserId),items:lines,total,paymentMethod,paymentStatus:paymentMethod==='credit'?'credit':'pending',discountAmount:0,payableTotal:total,status:'registered',createdAt:new Date().toISOString()};
  store.orders.push(order); store.carts[customer.id]={}; addAudit(store,{actor:'customer',category:'order',action:'order.create',entityType:'order',entityId:order.id,title:order.customerName,summary:`ثبت سفارش ${paymentMethod==='credit'?'اعتباری':'نقدی'} با ${lines.length} قلم و مبلغ ${total.toLocaleString('fa-IR')} تومان`}); writeStore(store);
  const txt='✅ سفارش شما با موفقیت ثبت شد.\nمنتظر تماس از طرف واحد فروش باشید.';
  return editOrSendText(chatId,messageId,txt,[[{text:'🧾 مشاهده سفارش',callback_data:`order:${order.id}`}] ]);
}
async function showCashPayment(chatId,customer,messageId){
  const store=readStore(),entries=cartEntries(store,customer); if(!entries.length)return showCart(chatId,customer,messageId);
  const total=entries.reduce((a,x)=>a+x.lineTotal,0),c=cashTotals(store,customer,total),url=paymentUrlFor(store,customer,c.payable,total,c.discount);
  const typeText=c.discountType==='fixed'?`${money(c.discountValue)} تومان`:`${money(c.discountValue)}٪`;
  let txt=`💳 پرداخت نقدی (تخفیف‌دار)\n\n💰 جمع سفارش: ${money(total)} تومان\n🏷 تخفیف نقدی این مشتری: ${typeText}\n➖ مبلغ تخفیف: ${money(c.discount)} تومان\n✅ مبلغ قابل پرداخت: ${money(c.payable)} تومان`;
  if(!url){
    txt+=`\n\n⚠️ لینک/درگاه پرداخت هنوز در پنل ادمین تنظیم نشده است. سبد شما محفوظ می‌ماند و سفارشی به‌عنوان پرداخت‌شده ثبت نمی‌شود.`;
    return editOrSendText(chatId,messageId,txt,[[{text:'↩️ بازگشت به روش پرداخت',callback_data:'order_review'}]]);
  }
  txt+=`\n\nپس از قطعی‌شدن اتصال درگاه، تأیید موفق پرداخت به‌صورت خودکار انجام خواهد شد. در نسخه فعلی ورود به لینک پرداخت، سبد را حذف یا سفارش را پرداخت‌شده ثبت نمی‌کند.`;
  return editOrSendText(chatId,messageId,txt,[[{text:'💳 ورود به لینک پرداخت',url}],[{text:'↩️ بازگشت به روش پرداخت',callback_data:'order_review'}]]);
}
async function showOrders(chatId,customer,messageId){
  const store=readStore(),bt=normalizeBotTexts(store),items=store.orders.filter(o=>o.customerId===customer.id).slice(-5).reverse();
  if(!items.length)return editOrSendText(chatId,messageId,`${renderBotText(bt.ordersTitle)}\n\n${renderBotText(bt.ordersEmpty)}`,[]);
  const body=items.map(o=>`• ${o.id} — ${statusFa(o.status)}\n  ${o.items.reduce((a,x)=>a+Number(x.qty||0),0).toLocaleString('fa-IR')} عدد | ${Number(o.total||0).toLocaleString('fa-IR')} تومان`).join('\n\n');
  const rows=items.map(o=>[{text:`🧾 ${o.id} • ${statusFa(o.status)}`,callback_data:`order:${o.id}`}]);
  return editOrSendText(chatId,messageId,`${renderBotText(bt.ordersTitle)}\n\n${body}`,rows);
}
async function showOrderDetails(chatId,customer,messageId,orderId){
  const store=readStore(),bt=normalizeBotTexts(store),o=store.orders.find(x=>x.id===orderId&&x.customerId===customer.id); if(!o)return showOrders(chatId,customer,messageId);
  const title=renderBotText(bt.orderDetailsTitle,{orderId:o.id,status:statusFa(o.status),total:money(o.total)}); const body=o.items.map((x,i)=>`${i+1}) ${x.name}\n   ${money(x.qty)} عدد × ${money(x.unitPrice)} = ${money(x.lineTotal)} تومان`).join('\n\n');
  const txt=`${title}\n\nوضعیت: ${statusFa(o.status)}\n\n${body}\n\n💰 مبلغ کل: ${money(o.total)} تومان`;
  return editOrSendText(chatId,messageId,txt,[[{text:bt.btnReorder,callback_data:`reorder:${o.id}`}],[{text:'↩️ سفارش‌های من',callback_data:'my_orders'}]]);
}
async function reorderOrder(chatId,customer,messageId,orderId){
  const store=readStore(),bt=normalizeBotTexts(store),o=store.orders.find(x=>x.id===orderId&&x.customerId===customer.id); if(!o)return showOrders(chatId,customer,messageId);
  const next={}; for(const row of o.items||[]){const pr=store.products.find(p=>p.id===row.productId&&isBaleVisibleProduct(p,store));if(pr)next[pr.id]=Math.max(1,Number(row.qty||1));} store.carts[customer.id]=next;writeStore(store);
  return showCart(chatId,customer,messageId,renderBotText(bt.reorderAdded,{orderId:o.id}));
}
async function sendBaleHome(chatId, customer){
  const store=readStore(); const bt=normalizeBotTexts(store);
  const active=customer?.status==='active', pending=customer?.status==='pending';
  const vars={name:customer?.contact||customer?.name||'',id:String(customer?.baleUserId||chatId||'')};
  let textMsg=renderBotText(bt.brandTitle,vars)+'\n\n';
  if(active){ textMsg+=renderBotText(bt.activeWelcome,vars); textMsg=appendCurrentCart(textMsg,store,customer,bt); } else if(pending) textMsg+=renderBotText(bt.pendingText,vars); else textMsg+=renderBotText(bt.inactiveText,vars);
  await bale('sendMessage',{chat_id:chatId,text:textMsg,reply_markup:active?activeHomeKeyboard(bt):pendingHomeKeyboard(bt)});
}
function ensureBaleCustomer(store, from){
  const userId=String(from?.id||''); if(!userId)return null;
  let c=store.customers.find(x=>String(x.baleUserId)===userId);
  if(c)return c;
  const fullName=[from?.first_name,from?.last_name].filter(Boolean).join(' ').trim() || `کاربر بله ${userId}`;
  c={id:uid('C',store.customers),name:fullName,contact:fullName,phone:'',baleUserId:userId,baleUsername:from?.username||'',priceGroup:'C',status:'pending',createdAt:todayFa()};
  store.customers.push(c); addAudit(store,{actor:'system',category:'customer',action:'customer.auto_register',entityType:'customer',entityId:c.id,title:c.name,summary:'ثبت خودکار مشتری جدید از طریق بله'}); writeStore(store); return c;
}
async function processBaleUpdate(update){
  if(update.callback_query){
    const q=update.callback_query, chatId=q.message?.chat?.id || q.from?.id, messageId=q.message?.message_id, userId=String(q.from?.id||''), data=String(q.data||'');
    try{await bale('answerCallbackQuery',{callback_query_id:q.id});}catch{}
    if(!chatId)return; const store=readStore(), customer=store.customers.find(c=>String(c.baleUserId)===userId);
    if(data==='check_status') return sendBaleHome(chatId,customer);
    if(data==='my_id'){const bt=normalizeBotTexts(store);return bale('sendMessage',{chat_id:chatId,text:renderBotText(bt.myIdText,{id:userId})});}
    if(!customer || customer.status!=='active') return sendBaleHome(chatId,customer);
    const bt=normalizeBotTexts(store);
    if(data==='home') return sendBaleHome(chatId,customer);
    if(data==='my_account') return editOrSendText(chatId,messageId,renderBotText(bt.accountText,{name:customer.name,id:userId}),[]);
    if(data==='my_orders') return showOrders(chatId,customer,messageId);
    if(data.startsWith('order:')) return showOrderDetails(chatId,customer,messageId,data.slice(6));
    if(data.startsWith('reorder:')) return reorderOrder(chatId,customer,messageId,data.slice(8));
    if(data==='cart') return showCart(chatId,customer,messageId);
    if(data==='save_draft') return saveDraftAndPause(chatId,customer,messageId);
    if(data==='current_order_new') return showVehicles(chatId,customer,messageId,0); // سازگاری با پیام‌های قدیمی
    if(data.startsWith('newprod:')){
      // انتخاب محصول جدید باید همیشه از ابتدای انتخاب محصول شروع شود،
      // نه اینکه فیلتر/خودروی محصول قبلی (مثلاً پراید) حفظ شود.
      return showVehicles(chatId,customer,messageId,0);
    }
    if(data==='cart_edit') return showCartEdit(chatId,customer,messageId);
    if(data==='cart_add_row') return showVehicles(chatId,customer,messageId,0);
    if(data.startsWith('cart_edit_qty:')) return promptCartQtyEdit(chatId,customer,messageId,userId,data.slice(14));
    if(data.startsWith('cart_delete:')){const pid=data.slice(12),c=cartObject(store,customer.id);delete c[pid];writeStore(store);return showCartEdit(chatId,customer,messageId,'✅ ردیف از سفارش حذف شد.');}
    if(data==='cart_clear') return confirmClearCart(chatId,customer,messageId);
    if(data==='cart_clear_confirm') return clearCart(chatId,customer,messageId);
    if(data==='order_review') return showOrderReview(chatId,customer,messageId);
    if(data==='order_credit' || data==='order_submit') return submitCartOrder(chatId,customer,messageId,'credit');
    if(data==='order_cash') return showCashPayment(chatId,customer,messageId);
    if(data==='search_again' || data==='search_start'){botStates.set(userId,{mode:'search'});return editOrSendText(chatId,messageId,renderBotText(bt.searchPrompt),[]);}
    if(data.startsWith('search_page:')){const st=botStates.get(userId);if(!st?.query){botStates.set(userId,{mode:'search'});return editOrSendText(chatId,messageId,renderBotText(bt.searchPrompt),[]);}return showSearchResults(chatId,customer,st.query,messageId,Number(data.split(':')[1]||0),userId);}
    if(data.startsWith('vehicles:')) return showVehicles(chatId,customer,messageId,Number(data.split(':')[1]||0));
    if(data.startsWith('veh:')){const [,vi,pg]=data.split(':');return showVehicleProducts(chatId,customer,messageId,Number(vi),Number(pg||0));}
    if(data.startsWith('prod:')) return showProduct(chatId,customer,messageId,data.slice(5),'',Boolean(q.message?.photo?.length));
    if(data.startsWith('addq:')){const parts=data.split(':'),pid=parts[1],delta=Number(parts[2]||0),pr=store.products.find(x=>x.id===pid&&isBaleVisibleProduct(x,store));if(!pr)return showVehicles(chatId,customer,messageId,0);const c=cartObject(store,customer.id),next=Math.max(0,Number(c[pid]||0)+delta);if(next)c[pid]=next;else delete c[pid];writeStore(store);return showProduct(chatId,customer,messageId,pid,'',Boolean(q.message?.photo?.length));}
    if(data.startsWith('add:')){const pid=data.slice(4),pr=store.products.find(x=>x.id===pid&&isBaleVisibleProduct(x,store));if(!pr)return showVehicles(chatId,customer,messageId,0);const c=cartObject(store,customer.id); c[pid]=Number(c[pid]||0)+1; writeStore(store); return showProduct(chatId,customer,messageId,pid,'',Boolean(q.message?.photo?.length));}
    if(data.startsWith('cartchg:')||data.startsWith('cartinc:')||data.startsWith('cartdec:')) return showCartEdit(chatId,customer,messageId);
    return;
  }
  const msg=update.message; if(!msg) return; const chatId=msg.chat?.id; if(!chatId) return;
  const store=readStore(),customer=ensureBaleCustomer(store,msg.from),userId=String(msg.from?.id||''),t=String(msg.text||'').trim(),bt=normalizeBotTexts(store);
  if(t==='/start' || t==='شروع' || t==='🔄 شروع مجدد' || t===bt.btnRestart || t===bt.btnHome || t==='🏠 منوی اصلی'){botStates.delete(userId);return sendBaleHome(chatId,customer);}
  if(t==='/id' || t==='شناسه من' || t===bt.btnMyId) return bale('sendMessage',{chat_id:chatId,text:renderBotText(bt.myIdText,{id:userId})});
  if(!customer || customer.status!=='active') return sendBaleHome(chatId,customer);
  const state=botStates.get(userId);
  if(state?.mode==='cart_edit_qty' && t){
    const raw=faDigitsToEn(t).replace(/[٬,\s]/g,'');
    if(!/^\d+$/.test(raw)) return bale('sendMessage',{chat_id:chatId,text:'لطفاً تعداد جدید را فقط به‌صورت عدد صحیح وارد کنید.'});
    const qty=Number(raw); if(!Number.isSafeInteger(qty)||qty<1||qty>999999) return bale('sendMessage',{chat_id:chatId,text:'تعداد باید حداقل ۱ باشد.'});
    const c=cartObject(store,customer.id),pid=state.productId,pr=store.products.find(x=>x.id===pid&&isBaleVisibleProduct(x,store));
    if(!pr){botStates.delete(userId);return showCartEdit(chatId,customer,null);}
    c[pid]=qty; writeStore(store); botStates.delete(userId);
    return showCartEdit(chatId,customer,null,`✅ تعداد «${pr.name}» به ${money(qty)} تغییر کرد.`);
  }
  if(state?.mode==='search' && t){return showSearchResults(chatId,customer,t,null,0,userId);}
  // علاوه بر متن فعلی، برچسب‌های قبلی منو هم پذیرفته می‌شوند تا بعد از تغییر متن/ایموجی در پنل، کیبورد قدیمی کاربر از کار نیفتد.
  if(t===bt.btnProducts || t==='محصولات' || t==='🚘 محصولات') return showVehicles(chatId,customer,null,0);
  if(t===bt.btnSearch || t==='جستجو' || t==='🔍 جستجو' || t==='🔍 جستجوی شیشه'){botStates.set(userId,{mode:'search'});return bale('sendMessage',{chat_id:chatId,text:renderBotText(bt.searchPrompt)});}
  if(t===bt.btnCart || t==='سبد سفارش' || t==='🛒 سبد سفارش') return showCart(chatId,customer,null);
  if(t===bt.btnOrders || t==='سفارش‌های من' || t==='📦 سفارش‌های من') return showOrders(chatId,customer,null);
  if(t===bt.btnAccount || t==='حساب من' || t==='👤 حساب من') return bale('sendMessage',{chat_id:chatId,text:renderBotText(bt.accountText,{name:customer.name,id:userId})});
  if(t===bt.btnSupport || t==='ارتباط با فروش' || t==='☎️ ارتباط با فروش'){
    const supportUrl=salesBaleLinkOf(store);
    if(supportUrl) return bale('sendMessage',{chat_id:chatId,text:'☎️ ارتباط با واحد فروش',reply_markup:{inline_keyboard:[[{text:'💬 ورود به گفتگوی واحد فروش',url:supportUrl}]]}});
    return bale('sendMessage',{chat_id:chatId,text:'راه ارتباط مستقیم با واحد فروش هنوز در پنل تنظیم نشده است.'});
  }
  // هر متن آزاد مشتری نیز به‌عنوان جستجوی سریع کالا/خودرو تفسیر می‌شود.
  if(t) return showSearchResults(chatId,customer,t,null,0,userId);
}
let polling=false, offset=0;
async function pollBale(){ if(polling||!BALE_BOT_TOKEN) return; polling=true; console.log('[Bale] polling started'); while(BALE_POLLING){ try{const updates=await bale('getUpdates',{offset,timeout:25}); for(const u of updates){offset=Math.max(offset,u.update_id+1); await processBaleUpdate(u);}}catch(e){console.error('[Bale]',e.message); await new Promise(r=>setTimeout(r,3000));}} polling=false; }

const server=http.createServer(async (req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`); const p=url.pathname;
  const origin=String(req.headers.origin||'');
  if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Admin-Key, X-Sales-Key');
  if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
  res.setHeader('Content-Security-Policy',"frame-src https://*.bale.ai; default-src 'self' https://tapi.bale.ai; script-src 'self' 'unsafe-inline' https://tapi.bale.ai; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://tapi.bale.ai;");
  try{
    if(p==='/health') return json(res,200,{ok:true,app:'almas-bale-sales-13000',version:'2.42.0'});
    if(p==='/api/auth/admin/login' && req.method==='POST'){
      const b=await parseBody(req);
      if(!safeEq(b.username,ADMIN_USERNAME)||!safeEq(b.password,ADMIN_PASSWORD)) return json(res,401,{ok:false,error:'نام کاربری یا رمز عبور نادرست است'});
      return json(res,200,{ok:true,token:signSession({role:'admin',username:ADMIN_USERNAME,exp:Date.now()+12*60*60*1000}),username:ADMIN_USERNAME});
    }
    if(p==='/api/auth/sales/login' && req.method==='POST'){
      const b=await parseBody(req);
      if(!safeEq(b.username,SALES_MANAGER_USERNAME)||!safeEq(b.password,SALES_MANAGER_KEY)) return json(res,401,{ok:false,error:'نام کاربری یا رمز عبور نادرست است'});
      return json(res,200,{ok:true,token:signSession({role:'sales',username:SALES_MANAGER_USERNAME,exp:Date.now()+12*60*60*1000}),username:SALES_MANAGER_USERNAME});
    }
    if(p==='/api/admin/stats' && req.method==='GET'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const s=readStore();
      return json(res,200,{ok:true,stats:{activeCustomers:s.customers.filter(x=>x.status==='active').length,pendingCustomers:s.customers.filter(x=>x.status==='pending').length,priceGroups:s.priceGroups.length,customPrices:s.customerPrices.length,products:s.products.length,orders:s.orders.length}});
    }
    if(p==='/api/admin/customers'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const s=readStore();
      if(req.method==='GET') return json(res,200,{ok:true,items:s.customers.map(safeCustomerAdmin)});
      if(req.method==='POST'){const b=await parseBody(req); const item={id:uid('C',s.customers),name:b.name||'',contact:b.contact||'',phone:b.phone||'',baleUserId:String(b.baleUserId||''),priceGroup:b.priceGroup||'C',status:b.status||'pending',createdAt:todayFa()}; s.customers.push(item);addAudit(s,{category:'customer',action:'customer.create',entityType:'customer',entityId:item.id,title:item.name,summary:'ایجاد مشتری جدید در پنل مدیریت'});writeStore(s);return json(res,201,{ok:true,item:safeCustomerAdmin(item)});}
    }
    const cm=p.match(/^\/api\/admin\/customers\/([^/]+)$/); if(cm && req.method==='PUT'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const s=readStore(), i=s.customers.findIndex(x=>x.id===decodeURIComponent(cm[1])); if(i<0)return json(res,404,{ok:false,error:'مشتری پیدا نشد'}); const b=await parseBody(req); const before={...s.customers[i]}; const prevStatus=s.customers[i].status; s.customers[i]={...s.customers[i],...b,id:s.customers[i].id,baleUserId:String(b.baleUserId ?? s.customers[i].baleUserId)}; const changes=makeChanges(before,s.customers[i],['name','contact','phone','baleUserId','priceGroup','status']); if(changes.length)addAudit(s,{category:'customer',action:'customer.update',entityType:'customer',entityId:s.customers[i].id,title:s.customers[i].name,summary:'ویرایش اطلاعات مشتری',changes}); writeStore(s); if(BALE_BOT_TOKEN && prevStatus!=='active' && s.customers[i].status==='active' && s.customers[i].baleUserId){sendBaleHome(Number(s.customers[i].baleUserId),s.customers[i]).catch(()=>{});} return json(res,200,{ok:true,item:safeCustomerAdmin(s.customers[i])});
    }
    if(cm && req.method==='DELETE'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'});
      const s=readStore(), id=decodeURIComponent(cm[1]), i=s.customers.findIndex(x=>x.id===id);
      if(i<0)return json(res,404,{ok:false,error:'مشتری پیدا نشد'});
      const removed=s.customers[i];
      const relatedOrders=(s.orders||[]).filter(o=>o.customerId===id).length;
      const removedPrices=(s.customerPrices||[]).filter(x=>x.customerId===id).length;
      s.customers.splice(i,1);
      s.customerPrices=(s.customerPrices||[]).filter(x=>x.customerId!==id);
      if(s.customerCashTerms && typeof s.customerCashTerms==='object') delete s.customerCashTerms[id];
      if(s.carts && typeof s.carts==='object') delete s.carts[id];
      if(removed?.baleUserId) botStates.delete(String(removed.baleUserId));
      addAudit(s,{category:'customer',action:'customer.delete',entityType:'customer',entityId:id,title:removed?.name||id,summary:`حذف مشتری از پنل؛ ${removedPrices} قیمت اختصاصی و سبد/تنظیم نقدی پاک شد؛ ${relatedOrders} سفارش تاریخی حفظ شد`});
      writeStore(s);
      return json(res,200,{ok:true,item:safeCustomerAdmin(removed),removedCustomerPrices:removedPrices,preservedOrders:relatedOrders});
    }
    if(p==='/api/admin/price-groups'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const s=readStore();
      if(req.method==='GET')return json(res,200,{ok:true,items:s.priceGroups});
      if(req.method==='POST'){const b=await parseBody(req); const item={id:String(b.id||'').trim().toUpperCase(),name:b.name||'',description:b.description||''}; if(!item.id||s.priceGroups.some(x=>x.id===item.id))return json(res,400,{ok:false,error:'کد گروه نامعتبر یا تکراری است'}); s.priceGroups.push(item);addAudit(s,{category:'price',action:'price_group.create',entityType:'priceGroup',entityId:item.id,title:item.name,summary:'ایجاد گروه قیمت'});writeStore(s);return json(res,201,{ok:true,item});}
    }
    const gm=p.match(/^\/api\/admin\/price-groups\/([^/]+)$/); if(gm && req.method==='DELETE'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'});
      const s=readStore(), id=decodeURIComponent(gm[1]);
      if(s.customers.some(x=>x.priceGroup===id)) return json(res,400,{ok:false,error:'این گروه به مشتری اختصاص داده شده است؛ ابتدا گروه مشتریان را تغییر بده.'});
      const i=s.priceGroups.findIndex(x=>x.id===id); if(i<0)return json(res,404,{ok:false,error:'گروه پیدا نشد'});
      const removed=s.priceGroups.splice(i,1)[0]; addAudit(s,{category:'price',action:'price_group.delete',entityType:'priceGroup',entityId:removed.id,title:removed.name,summary:'حذف گروه قیمت بدون مشتری وابسته'}); writeStore(s); return json(res,200,{ok:true,item:removed});
    }
    if(p==='/api/admin/vehicles'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const st=readStore();
      if(req.method==='GET') return json(res,200,{ok:true,items:normalizedVehicles(st)});
      if(req.method==='POST'){const b=await parseBody(req),name=String(b.name||'').trim();if(!name)return json(res,400,{ok:false,error:'نام خودرو الزامی است'});if(vehicleNameExists(st,name))return json(res,409,{ok:false,error:'این خودرو قبلاً در فهرست وجود دارد'});const item=ensureVehicleEntry(st,name);writeStore(st);return json(res,201,{ok:true,item});}
    }
    const vm=p.match(/^\/api\/admin\/vehicles\/([^/]+)$/);
    if(vm){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const st=readStore(),id=decodeURIComponent(vm[1]),i=(st.vehicles||[]).findIndex(x=>x.id===id);if(i<0)return json(res,404,{ok:false,error:'خودرو پیدا نشد'});
      if(req.method==='PUT'){materializeVehicleRules(st);const b=await parseBody(req),oldName=String(st.vehicles[i].name||''),name=String(b.name||oldName).trim();if(!name)return json(res,400,{ok:false,error:'نام خودرو الزامی است'});if((st.vehicles||[]).some((x,j)=>j!==i&&normHeader(x.name)===normHeader(name)))return json(res,409,{ok:false,error:'خودروی دیگری با این نام وجود دارد'});st.vehicles[i].name=name;if(Number.isFinite(Number(b.sort)))st.vehicles[i].sort=Number(b.sort);if(oldName!==name){for(const pr of st.products||[]){if(normHeader(pr.vehicle)===normHeader(oldName))pr.vehicle=name;}for(const r of st.vehicleRules||[]){if(normHeader(r.vehicle)===normHeader(oldName))r.vehicle=name;}}writeStore(st);return json(res,200,{ok:true,item:st.vehicles[i]});}
      if(req.method==='DELETE'){materializeVehicleRules(st);const oldName=String(st.vehicles[i].name||'');st.vehicles.splice(i,1);let moved=0;for(const pr of st.products||[]){if(normHeader(pr.vehicle)===normHeader(oldName)){pr.vehicle='سایر';moved++;}}st.vehicleRules=(st.vehicleRules||[]).filter(r=>normHeader(r.vehicle)!==normHeader(oldName));writeStore(st);return json(res,200,{ok:true,moved});}
    }
    if(p==='/api/admin/vehicle-train' && req.method==='POST'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const st=readStore(),b=await parseBody(req),product=(st.products||[]).find(x=>x.id===String(b.productId||''));if(!product)return json(res,404,{ok:false,error:'کالا پیدا نشد'});const keyword=String(b.keyword||'').trim(),vehicle=keyword;if(!keyword)return json(res,400,{ok:false,error:'عبارت مربوط به نام خودرو را از عنوان انتخاب کن'});ensureVehicleEntry(st,vehicle);materializeVehicleRules(st);let rule=st.vehicleRules.find(r=>normHeader(r.vehicle)===normHeader(vehicle));if(!rule){rule={vehicle,keywords:[]};st.vehicleRules.push(rule);}if(!rule.keywords.some(k=>normHeader(k)===normHeader(keyword)))rule.keywords.push(keyword);let changed=0;for(const pr of st.products||[]){if(normHeader(pr.name).includes(normHeader(keyword))&&pr.vehicle!==vehicle){pr.vehicle=vehicle;changed++;}}product.vehicle=vehicle;writeStore(st);return json(res,200,{ok:true,vehicle,keyword,changed});
    }
    if(p==='/api/admin/sales-history' && req.method==='GET'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const st=readStore(),limit=Math.min(1000,Math.max(1,Number(url.searchParams.get('limit')||500)));return json(res,200,{ok:true,items:st.salesHistory.slice(0,limit),total:st.salesHistory.length});
    }
    if(p==='/api/admin/vehicle-rules'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const s=readStore();
      if(req.method==='GET') return json(res,200,{ok:true,items:normalizedVehicleRules(s)});
      if(req.method==='PUT'){
        const b=await parseBody(req),rows=Array.isArray(b.items)?b.items:[];const clean=[];
        for(const r of rows.slice(0,300)){const vehicle=String(r?.vehicle||'').trim(),keywords=Array.isArray(r?.keywords)?r.keywords.map(x=>String(x||'').trim()).filter(Boolean):[];if(vehicle&&keywords.length)clean.push({vehicle,keywords:[...new Set(keywords)].slice(0,30)});}
        if(!clean.length)return json(res,400,{ok:false,error:'حداقل یک خودرو و یک کلیدواژه تعریف کن.'});
        const before=normalizedVehicleRules(s);s.vehicleRules=clean;addAudit(s,{category:'product',action:'vehicle_rules.update',entityType:'vehicleRules',entityId:'vehicle-rules',title:'قوانین تشخیص خودرو',summary:`ویرایش قوانین تشخیص خودرو (${clean.length} دسته)`,changes:[{field:'vehicleRules',label:'قوانین تشخیص خودرو',from:`${before.length} دسته`,to:`${clean.length} دسته`} ]});writeStore(s);return json(res,200,{ok:true,items:clean});
      }
    }
    if(p==='/api/admin/vehicle-rules/reclassify' && req.method==='POST'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const s=readStore();let changed=0;const samples=[];
      for(const pr of s.products||[]){if(String(pr.vehicle||'سایر')!=='سایر')continue;const next=detectVehicle(pr.name,s);if(next&&next!=='سایر'){const before=pr.vehicle||'سایر';pr.vehicle=next;ensureVehicleEntry(s,next);changed++;if(samples.length<10)samples.push(`${pr.name} ← ${next}`);addAudit(s,{category:'product',action:'product.reclassify',entityType:'product',entityId:pr.id,title:pr.name,summary:'بازدسته‌بندی هوشمند خودرو',changes:[{field:'vehicle',label:'خودرو',from:before,to:next}]});}}
      addAudit(s,{category:'product',action:'vehicle_rules.reclassify',entityType:'vehicleRules',entityId:'vehicle-rules',title:'بازدسته‌بندی کالاهای سایر',summary:`${changed} کالا از «سایر» به دسته خودرو منتقل شد`});writeStore(s);return json(res,200,{ok:true,changed,samples});
    }
    if(p==='/api/admin/vehicle-rules/reclassify-all' && req.method==='POST'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const s=readStore();let changed=0;const samples=[];
      const originalVehicles=(s.products||[]).map(x=>x.vehicle);
      for(let idx=0;idx<(s.products||[]).length;idx++){const pr=s.products[idx];const old=pr.vehicle||'سایر';pr.vehicle='سایر';const next=detectVehicle(pr.name,{...s,products:s.products.filter((_,j)=>j!==idx)});pr.vehicle=next||old;ensureVehicleEntry(s,pr.vehicle);if(pr.vehicle!==old){changed++;if(samples.length<12)samples.push(`${pr.name} ← ${pr.vehicle}`);}}
      writeStore(s);return json(res,200,{ok:true,changed,samples});
    }

    if(p==='/api/admin/glass-type-rules'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const s=readStore();
      if(req.method==='GET') return json(res,200,{ok:true,items:normalizedGlassTypeRules(s)});
      if(req.method==='PUT'){const b=await parseBody(req),raw=Array.isArray(b.items)?b.items:[],clean=raw.map(r=>({type:String(r.type||'').trim(),keywords:Array.isArray(r.keywords)?r.keywords.map(k=>String(k||'').trim()).filter(Boolean):[]})).filter(r=>r.type&&r.keywords.length);if(!clean.length)return json(res,400,{ok:false,error:'حداقل یک قانون معتبر لازم است'});const before=normalizedGlassTypeRules(s);s.glassTypeRules=clean;addAudit(s,{category:'product',action:'glass_rules.update',entityType:'glassTypeRules',entityId:'glass-type-rules',title:'قوانین تشخیص نوع شیشه',summary:`ویرایش قوانین نوع شیشه (${clean.length} دسته)`,changes:[{field:'glassTypeRules',label:'قوانین نوع شیشه',from:`${before.length} دسته`,to:`${clean.length} دسته`} ]});writeStore(s);return json(res,200,{ok:true,items:clean});}
    }
    if(p==='/api/admin/glass-type-rules/reclassify' && req.method==='POST'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const s=readStore();let changed=0,samples=[];
      for(const pr of s.products||[]){const before=normalizeGlassCategory(pr.type)||'سایر',next=detectGlassType(pr.name,s);if(before!==next){pr.type=next;changed++;if(samples.length<10)samples.push(`${pr.name} ← ${next}`);addAudit(s,{category:'product',action:'product.glass_reclassify',entityType:'product',entityId:pr.id,title:pr.name,summary:'بازدسته‌بندی نوع شیشه',changes:[{field:'type',label:'دسته شیشه',from:before,to:next}]});}else pr.type=next;}
      addAudit(s,{category:'product',action:'glass_rules.reclassify',entityType:'glassTypeRules',entityId:'glass-type-rules',title:'بازدسته‌بندی نوع شیشه',summary:`${changed} کالا بازدسته‌بندی شد`});writeStore(s);return json(res,200,{ok:true,changed,samples});
    }


    if(p==='/api/admin/products'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const s=readStore();
      if(req.method==='GET')return json(res,200,{ok:true,items:s.products.map(x=>({...x,glassCategory:productGlassCategory(x,s),hasImage:false}))});
      if(req.method==='POST'){const b=await parseBody(req); const item={id:uid('P',s.products),code:b.code||autoProductCode(b.name),name:b.name||'',vehicle:b.vehicle||detectVehicle(b.name,s),type:detectGlassType(b.name,s),basePrice:Number(b.basePrice||0),active:b.active!==false,groupPrices:b.groupPrices||{}}; ensureVehicleEntry(s,item.vehicle); s.products.push(item);addAudit(s,{category:'product',action:'product.create',entityType:'product',entityId:item.id,title:item.name,summary:`ایجاد محصول ${item.code}`});writeStore(s);return json(res,201,{ok:true,item:{...item,hasImage:false}});}
    }
    const pm=p.match(/^\/api\/admin\/products\/([^/]+)$/); if(pm && req.method==='PUT'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const s=readStore(), i=s.products.findIndex(x=>x.id===decodeURIComponent(pm[1])); if(i<0)return json(res,404,{ok:false,error:'محصول پیدا نشد'}); const b=await parseBody(req),existing=s.products[i],before=JSON.parse(JSON.stringify(s.products[i])); const clean={...b};delete clean.imageData;delete clean.removeImage;delete clean.imageFile; s.products[i]={...existing,...clean,id:existing.id,basePrice:Number(b.basePrice ?? existing.basePrice),active:b.active!==false}; s.products[i].type=detectGlassType(s.products[i].name,s); const changes=makeChanges(before,s.products[i],['code','name','vehicle','type','basePrice','active','groupPrices']); if(changes.length)addAudit(s,{category:'product',action:'product.update',entityType:'product',entityId:s.products[i].id,title:s.products[i].name,summary:'ویرایش محصول',changes}); writeStore(s); return json(res,200,{ok:true,item:{...s.products[i],hasImage:false}});
    }
    if(pm && req.method==='DELETE'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'});
      const s=readStore(), id=decodeURIComponent(pm[1]), i=s.products.findIndex(x=>x.id===id);
      if(i<0)return json(res,404,{ok:false,error:'محصول پیدا نشد'});
      const removed=s.products[i]; removeProductImage(removed); s.products.splice(i,1);
      s.customerPrices=(s.customerPrices||[]).filter(x=>x.productId!==id);
      for(const cid of Object.keys(s.carts||{})){ if(s.carts[cid] && typeof s.carts[cid]==='object') delete s.carts[cid][id]; }
      addAudit(s,{category:'product',action:'product.delete',entityType:'product',entityId:removed.id,title:removed.name,summary:`حذف محصول ${removed.code}`}); writeStore(s); return json(res,200,{ok:true,item:removed});
    }

    if(p==='/api/admin/products/import-preview' && req.method==='POST'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'});
      try{const s=readStore(),b=await parseBody(req); const preview=prepareExcelImport(s,b.filename,b.dataUrl); return json(res,200,{ok:true,preview});}
      catch(e){return json(res,400,{ok:false,error:e.message||'فایل Excel قابل خواندن نیست.'});}
    }
    if(p==='/api/admin/products/import-confirm' && req.method==='POST'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const s=readStore(),b=await parseBody(req),items=Array.isArray(b.items)?b.items:[]; if(!items.length)return json(res,400,{ok:false,error:'لیست کالایی برای ورود وجود ندارد.'}); let added=0,updated=0,skipped=0;
      for(const row of items.slice(0,5000)){const name=String(row.name||'').trim();if(!name){skipped++;continue;}const code=String(row.code||autoProductCode(name)).trim();let pr=(row.existingId&&s.products.find(x=>x.id===row.existingId))||s.products.find(x=>String(x.code).trim()===code)||s.products.find(x=>normalizeFaSearch(x.name)===normalizeFaSearch(name));if(pr){const before=JSON.parse(JSON.stringify(pr));pr.name=name;pr.vehicle=String(row.vehicle||detectVehicle(name,s));ensureVehicleEntry(s,pr.vehicle);pr.type=normalizeGlassCategory(row.type)||detectGlassType(name,s);if(Number(row.basePrice)>0)pr.basePrice=Number(row.basePrice);const changes=makeChanges(before,pr,['name','vehicle','type','basePrice']);if(changes.length){updated++;addAudit(s,{category:'product',action:'product.import_update',entityType:'product',entityId:pr.id,title:pr.name,summary:`به‌روزرسانی از Excel (${b.filename||'فایل'})`,changes});}else skipped++;}
        else{pr={id:uid('P',s.products),code,name,vehicle:String(row.vehicle||detectVehicle(name,s)),type:normalizeGlassCategory(row.type)||detectGlassType(name,s),basePrice:Number(row.basePrice||0),active:true,groupPrices:{}};ensureVehicleEntry(s,pr.vehicle);s.products.push(pr);added++;addAudit(s,{category:'product',action:'product.import_create',entityType:'product',entityId:pr.id,title:pr.name,summary:`ایجاد از Excel (${b.filename||'فایل'})`});}}
      addAudit(s,{category:'product',action:'product.import_batch',entityType:'import',entityId:'',title:b.filename||'ورود Excel',summary:`ورود گروهی کالا: ${added} جدید، ${updated} به‌روزرسانی، ${skipped} بدون تغییر`}); writeStore(s); return json(res,200,{ok:true,result:{added,updated,skipped,total:items.length}});
    }
    const pim=p.match(/^\/product-image\/([^/]+)$/); if(pim && req.method==='GET'){const s=readStore(),pr=s.products.find(x=>x.id===decodeURIComponent(pim[1])),full=productImageFull(pr);if(!full)return text(res,404,'');return text(res,200,fs.readFileSync(full),imageMimeFromName(full),{'Cache-Control':'no-cache'});}
    if(p==='/api/admin/customer-prices'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const s=readStore();
      if(req.method==='GET') return json(res,200,{ok:true,items:s.customerPrices});
      if(req.method==='POST'){const b=await parseBody(req); let item=s.customerPrices.find(x=>x.customerId===b.customerId&&x.productId===b.productId),before=item?{...item}:null; if(item)item.price=Number(b.price||0); else {item={id:uid('CP',s.customerPrices),customerId:b.customerId,productId:b.productId,price:Number(b.price||0)};s.customerPrices.push(item);} const c=s.customers.find(x=>x.id===item.customerId),pr=s.products.find(x=>x.id===item.productId);addAudit(s,{category:'price',action:before?'customer_price.update':'customer_price.create',entityType:'customerPrice',entityId:item.id,title:`${c?.name||item.customerId} / ${pr?.name||item.productId}`,summary:`ثبت قیمت ${Number(item.price).toLocaleString('fa-IR')} تومان`,changes:before?makeChanges(before,item,['price']):[]}); writeStore(s);return json(res,200,{ok:true,item});}
    }
    const cpm=p.match(/^\/api\/admin\/customer-prices\/([^/]+)$/); if(cpm && req.method==='DELETE'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'});
      const s=readStore(), id=decodeURIComponent(cpm[1]), i=s.customerPrices.findIndex(x=>x.id===id);
      if(i<0)return json(res,404,{ok:false,error:'قیمت اختصاصی پیدا نشد'});
      const removed=s.customerPrices.splice(i,1)[0]; const c=s.customers.find(x=>x.id===removed.customerId),pr=s.products.find(x=>x.id===removed.productId); addAudit(s,{category:'price',action:'customer_price.delete',entityType:'customerPrice',entityId:removed.id,title:`${c?.name||removed.customerId} / ${pr?.name||removed.productId}`,summary:'حذف قیمت اختصاصی مشتری'}); writeStore(s); return json(res,200,{ok:true,item:removed});
    }
    if(p==='/api/admin/orders' && req.method==='GET'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const s=readStore(); return json(res,200,{ok:true,items:[...s.orders].reverse()});
    }
    const om=p.match(/^\/api\/admin\/orders\/([^/]+)$/); if(om && req.method==='PUT'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const s=readStore(), i=s.orders.findIndex(x=>x.id===decodeURIComponent(om[1])); if(i<0)return json(res,404,{ok:false,error:'سفارش پیدا نشد'}); const b=await parseBody(req); const allowed=['registered','approved','preparing','ready','sent','cancelled']; if(b.status && !allowed.includes(b.status)) return json(res,400,{ok:false,error:'وضعیت سفارش نامعتبر است'}); const prev=s.orders[i].status; s.orders[i].status=b.status||s.orders[i].status; if(prev!==s.orders[i].status)addAudit(s,{category:'order',action:'order.status',entityType:'order',entityId:s.orders[i].id,title:s.orders[i].customerName||'',summary:`تغییر وضعیت از «${statusFa(prev)}» به «${statusFa(s.orders[i].status)}»`,changes:[{field:'status',label:'وضعیت سفارش',from:statusFa(prev),to:statusFa(s.orders[i].status)}]}); writeStore(s); if(BALE_BOT_TOKEN && prev!==s.orders[i].status && s.orders[i].baleUserId){const bt=normalizeBotTexts(s); bale('sendMessage',{chat_id:Number(s.orders[i].baleUserId),text:renderBotText(bt.orderStatusChanged,{orderId:s.orders[i].id,status:statusFa(s.orders[i].status)})}).catch(()=>{});} return json(res,200,{ok:true,item:s.orders[i]});
    }
    if(om && req.method==='DELETE'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'});
      return json(res,405,{ok:false,error:'حذف سفارش غیرفعال است؛ در صورت نیاز وضعیت سفارش را روی «لغو شده» قرار دهید.'});
    }

    if(p==='/api/sales/orders' && req.method==='GET'){
      if(!salesOk(req)) return json(res,401,{ok:false,error:'رمز پنل مدیر فروش نامعتبر است'}); const s=readStore(); return json(res,200,{ok:true,items:[...s.orders].reverse()});
    }
    if(p==='/api/sales/history' && req.method==='GET'){
      if(!salesOk(req)) return json(res,401,{ok:false,error:'رمز پنل مدیر فروش نامعتبر است'}); const s=readStore(); const limit=Math.min(1000,Math.max(1,Number(url.searchParams.get('limit')||500))); return json(res,200,{ok:true,items:s.salesHistory.slice(0,limit),total:s.salesHistory.length});
    }
    const som=p.match(/^\/api\/sales\/orders\/([^/]+)$/); if(som && req.method==='PUT'){
      if(!salesOk(req)) return json(res,401,{ok:false,error:'رمز پنل مدیر فروش نامعتبر است'}); const s=readStore(),i=s.orders.findIndex(x=>x.id===decodeURIComponent(som[1])); if(i<0)return json(res,404,{ok:false,error:'سفارش پیدا نشد'});
      const b=await parseBody(req),allowed=['registered','approved','preparing','ready','sent','cancelled']; if(!b.status||!allowed.includes(b.status))return json(res,400,{ok:false,error:'وضعیت سفارش نامعتبر است'});
      const prev=s.orders[i].status,next=b.status; if(prev!==next){s.orders[i].status=next;s.orders[i].updatedAt=new Date().toISOString();addSalesHistory(s,{orderId:s.orders[i].id,customerName:s.orders[i].customerName,from:statusFa(prev),to:statusFa(next),note:b.note||''});writeStore(s);if(BALE_BOT_TOKEN&&s.orders[i].baleUserId){const bt=normalizeBotTexts(s);bale('sendMessage',{chat_id:Number(s.orders[i].baleUserId),text:renderBotText(bt.orderStatusChanged,{orderId:s.orders[i].id,status:statusFa(next)})}).catch(()=>{});}} return json(res,200,{ok:true,item:s.orders[i]});
    }
    if(p==='/api/admin/admin-settings' && req.method==='GET'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'دسترسی ادمین نامعتبر است'});
      return json(res,200,{ok:true,settings:{username:ADMIN_USERNAME,passwordConfigured:!!ADMIN_PASSWORD,masked:ADMIN_PASSWORD?('••••••'+ADMIN_PASSWORD.slice(-2)):''}});
    }
    if(p==='/api/admin/admin-settings' && req.method==='POST'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'دسترسی ادمین نامعتبر است'});
      const b=await parseBody(req);
      const username=String(b.adminUsername||'').trim();
      const password=String(b.adminPassword||'').trim();
      if(!username) return json(res,400,{ok:false,error:'نام کاربری ادمین الزامی است'});
      if(username.length<3) return json(res,400,{ok:false,error:'نام کاربری ادمین حداقل ۳ کاراکتر باشد'});
      if(password && password.length<6) return json(res,400,{ok:false,error:'رمز عبور ادمین حداقل ۶ کاراکتر باشد'});
      ADMIN_USERNAME=username.slice(0,80);
      if(password) ADMIN_PASSWORD=password;
      persistRuntimeEnv();
      return json(res,200,{ok:true,settings:{username:ADMIN_USERNAME,passwordConfigured:!!ADMIN_PASSWORD,masked:ADMIN_PASSWORD?('••••••'+ADMIN_PASSWORD.slice(-2)):''}});
    }
    if(p==='/api/admin/sales-settings' && req.method==='GET'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); return json(res,200,{ok:true,settings:{configured:!!SALES_MANAGER_KEY,username:SALES_MANAGER_USERNAME,masked:SALES_MANAGER_KEY?('••••••'+SALES_MANAGER_KEY.slice(-3)):'',url:'/sales'}});
    }
    if(p==='/api/admin/sales-settings' && req.method==='POST'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const b=await parseBody(req); if(typeof b.salesUsername==='string'&&b.salesUsername.trim()) SALES_MANAGER_USERNAME=b.salesUsername.trim().slice(0,80); if(typeof b.salesKey==='string'&&b.salesKey.trim()){if(b.salesKey.trim().length<6)return json(res,400,{ok:false,error:'رمز مدیر فروش حداقل ۶ کاراکتر باشد'});SALES_MANAGER_KEY=b.salesKey.trim();} persistRuntimeEnv(); return json(res,200,{ok:true,settings:{configured:!!SALES_MANAGER_KEY,username:SALES_MANAGER_USERNAME,masked:'••••••'+SALES_MANAGER_KEY.slice(-3),url:'/sales'}});
    }
    if(p==='/api/admin/audit-log' && req.method==='GET'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const s=readStore(),limit=Math.min(1000,Math.max(1,Number(url.searchParams.get('limit')||500))); return json(res,200,{ok:true,items:s.auditLog.slice(0,limit),total:s.auditLog.length});
    }
    if(p==='/api/admin/payment-settings' && req.method==='GET'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const st=readStore();
      return json(res,200,{ok:true,settings:st.paymentSettings,terms:st.customerCashTerms||{}});
    }
    if(p==='/api/admin/payment-settings' && req.method==='POST'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const st=readStore(),b=await parseBody(req);
      st.paymentSettings={...st.paymentSettings,cashEnabled:true,paymentUrl:typeof b.paymentUrl==='string'?b.paymentUrl.trim().slice(0,1500):String(st.paymentSettings.paymentUrl||'')};
      writeStore(st); return json(res,200,{ok:true,settings:st.paymentSettings});
    }
    const ptm=p.match(/^\/api\/admin\/payment-terms\/([^/]+)$/);
    if(ptm && req.method==='PUT'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const st=readStore(),customerId=decodeURIComponent(ptm[1]),cust=st.customers.find(x=>x.id===customerId); if(!cust)return json(res,404,{ok:false,error:'مشتری پیدا نشد'});
      const b=await parseBody(req),discountType=b.discountType==='fixed'?'fixed':'percent',discountValue=Math.max(0,Number(b.discountValue||0));
      if(discountType==='percent' && discountValue>100)return json(res,400,{ok:false,error:'درصد تخفیف نمی‌تواند بیشتر از ۱۰۰ باشد'});
      st.customerCashTerms[customerId]={enabled:true,discountType,discountValue}; writeStore(st); return json(res,200,{ok:true,item:st.customerCashTerms[customerId]});
    }
    if(ptm && req.method==='DELETE'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const st=readStore(),customerId=decodeURIComponent(ptm[1]); delete st.customerCashTerms[customerId]; writeStore(st); return json(res,200,{ok:true});
    }
    if(p==='/api/admin/bot-texts' && req.method==='GET'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const s=readStore();
      return json(res,200,{ok:true,texts:normalizeBotTexts(s),defaults:DEFAULT_BOT_TEXTS});
    }
    if(p==='/api/admin/bot-texts' && req.method==='POST'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const s=readStore(); const b=await parseBody(req);
      const incoming=b.texts&&typeof b.texts==='object'?b.texts:b; const next={};
      for(const k of Object.keys(DEFAULT_BOT_TEXTS)) if(typeof incoming[k]==='string') next[k]=incoming[k].slice(0,4000);
      const before=normalizeBotTexts(s); s.botTexts={...before,...next}; const changed=Object.keys(next).filter(k=>before[k]!==s.botTexts[k]); if(changed.length)addAudit(s,{category:'bot',action:'bot.texts',entityType:'botTexts',entityId:'',title:'متن‌های ربات',summary:`ویرایش ${changed.length} متن/دکمه ربات`}); writeStore(s); return json(res,200,{ok:true,texts:normalizeBotTexts(s)});
    }
    if(p==='/api/admin/bot-texts/reset' && req.method==='POST'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'}); const s=readStore(); s.botTexts={...DEFAULT_BOT_TEXTS}; addAudit(s,{category:'bot',action:'bot.reset',entityType:'botTexts',entityId:'',title:'متن‌های ربات',summary:'بازگردانی همه متن‌ها و دکمه‌های ربات به حالت پیش‌فرض'}); writeStore(s); return json(res,200,{ok:true,texts:s.botTexts});
    }
    if(p==='/api/admin/bale-settings' && req.method==='GET'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'});
      const st=readStore();
      return json(res,200,{ok:true,settings:{tokenConfigured:!!BALE_BOT_TOKEN,tokenMasked:maskToken(BALE_BOT_TOKEN),publicBaseUrl:PUBLIC_BASE_URL,polling:BALE_POLLING,allowDemo:ALLOW_DEMO,miniAppReady:isHttpsUrl(PUBLIC_BASE_URL),salesBaleLink:String(st.supportSettings?.salesBaleLink||'')}});
    }
    if(p==='/api/admin/bale-settings' && req.method==='POST'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'});
      const b=await parseBody(req); const beforeStore=readStore(); const beforeSettings={publicBaseUrl:PUBLIC_BASE_URL,polling:BALE_POLLING,allowDemo:ALLOW_DEMO,tokenConfigured:!!BALE_BOT_TOKEN,salesBaleLink:String(beforeStore.supportSettings?.salesBaleLink||'')};
      if(typeof b.botToken==='string' && b.botToken.trim()) BALE_BOT_TOKEN=b.botToken.trim();
      if(typeof b.publicBaseUrl==='string') PUBLIC_BASE_URL=b.publicBaseUrl.trim().replace(/\/$/,'');
      if(typeof b.allowDemo==='boolean') ALLOW_DEMO=b.allowDemo;
      const wantPolling=typeof b.polling==='boolean'?b.polling:BALE_POLLING;
      BALE_POLLING=wantPolling;
      const sAudit=readStore();
      if(typeof b.salesBaleLink==='string'){
        const val=b.salesBaleLink.trim().slice(0,500);
        if(val){
          let parsed=null;
          try{parsed=new URL(val);}catch{}
          if(!parsed || parsed.protocol!=='https:') return json(res,400,{ok:false,error:'لینک واحد فروش معتبر نیست. لینک کامل را با https:// وارد کنید.'});
        }
        sAudit.supportSettings={...(sAudit.supportSettings||{}),salesBaleLink:val};
      }
      persistRuntimeEnv(); const afterSettings={publicBaseUrl:PUBLIC_BASE_URL,polling:BALE_POLLING,allowDemo:ALLOW_DEMO,tokenConfigured:!!BALE_BOT_TOKEN,salesBaleLink:String(sAudit.supportSettings?.salesBaleLink||'')}; const settingsChanges=[]; if(beforeSettings.publicBaseUrl!==afterSettings.publicBaseUrl)settingsChanges.push({field:'publicBaseUrl',label:'آدرس عمومی',from:beforeSettings.publicBaseUrl,to:afterSettings.publicBaseUrl}); if(beforeSettings.polling!==afterSettings.polling)settingsChanges.push({field:'polling',label:'Long Polling',from:beforeSettings.polling?'فعال':'غیرفعال',to:afterSettings.polling?'فعال':'غیرفعال'}); if(beforeSettings.allowDemo!==afterSettings.allowDemo)settingsChanges.push({field:'allowDemo',label:'حالت آزمایشی',from:beforeSettings.allowDemo?'فعال':'غیرفعال',to:afterSettings.allowDemo?'فعال':'غیرفعال'}); if(!beforeSettings.tokenConfigured&&afterSettings.tokenConfigured)settingsChanges.push({field:'token',label:'توکن بله',from:'ثبت نشده',to:'ثبت شد'}); if(beforeSettings.salesBaleLink!==afterSettings.salesBaleLink)settingsChanges.push({field:'salesBaleLink',label:'لینک بله واحد فروش',from:beforeSettings.salesBaleLink||'تنظیم نشده',to:afterSettings.salesBaleLink||'تنظیم نشده'}); if(settingsChanges.length){addAudit(sAudit,{category:'settings',action:'settings.bale',entityType:'settings',entityId:'bale',title:'اتصال بله',summary:'ویرایش تنظیمات اتصال ربات بله',changes:settingsChanges});} writeStore(sAudit);
      if(BALE_POLLING && BALE_BOT_TOKEN){ try{await bale('deleteWebhook',{});}catch{} pollBale(); }
      return json(res,200,{ok:true,settings:{tokenConfigured:!!BALE_BOT_TOKEN,tokenMasked:maskToken(BALE_BOT_TOKEN),publicBaseUrl:PUBLIC_BASE_URL,polling:BALE_POLLING,allowDemo:ALLOW_DEMO,miniAppReady:isHttpsUrl(PUBLIC_BASE_URL),salesBaleLink:String(sAudit.supportSettings?.salesBaleLink||'')}});
    }
    if(p==='/api/admin/bale-test' && req.method==='POST'){
      if(!adminOk(req)) return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'});
      if(!BALE_BOT_TOKEN)return json(res,400,{ok:false,error:'توکن بله وارد نشده است'});
      try{const me=await bale('getMe',{});return json(res,200,{ok:true,bot:me});}catch(e){return json(res,400,{ok:false,error:e.message});}
    }
    if(p==='/api/app/health' && req.method==='GET'){
      return json(res,200,{ok:true,service:'almas-sales-13000',port:PORT,serverTime:nowFaIran()});
    }
    if(p==='/api/app/register' && req.method==='POST'){
      const b=await parseBody(req),fullName=String(b.fullName||'').trim(),businessName=String(b.businessName||'').trim(),city=String(b.city||'').trim(),mobile=normalizeMobile(b.mobile),password=String(b.password||'');
      if(!fullName)return json(res,400,{ok:false,error:'نام و نام خانوادگی الزامی است'});
      if(!mobile)return json(res,400,{ok:false,error:'شماره موبایل معتبر نیست'});
      if(password.length<6)return json(res,400,{ok:false,error:'رمز عبور حداقل ۶ کاراکتر باشد'});
      const st=readStore(),existing=st.customers.find(c=>normalizeMobile(c.phone)===mobile);
      if(existing){
        if(existing.appPasswordHash)return json(res,409,{ok:false,error:existing.status==='active'?'این شماره قبلاً برای Mini App فعال شده است؛ از صفحه ورود استفاده کنید.':'درخواست عضویت این شماره قبلاً ثبت شده و در انتظار بررسی فروش است.'});
        existing.name=existing.name||fullName; existing.contact=existing.contact||fullName; existing.phone=mobile; existing.appPasswordHash=hashAppPassword(password); existing.appBusinessName=businessName; existing.appCity=city; existing.registrationSource='miniapp'; existing.appRegisteredAt=existing.appRegisteredAt||nowFaIran();
        writeStore(st);
        if(existing.status==='active') return json(res,200,{ok:true,status:'active',message:'رمز Mini App برای مشتری فعلی فعال شد. اکنون می‌توانید وارد شوید.'});
        return json(res,200,{ok:true,status:'pending',message:'درخواست عضویت قبلی به‌روزرسانی شد و در انتظار تأیید فروش است.'});
      }
      const item={id:uid('C',st.customers),name:fullName,contact:fullName,phone:mobile,baleUserId:'',priceGroup:'C',status:'pending',createdAt:nowFaIran(),appPasswordHash:hashAppPassword(password),appBusinessName:businessName,appCity:city,registrationSource:'miniapp',appRegisteredAt:nowFaIran()};
      st.customers.push(item);addAudit(st,{actor:'customer',category:'customer',action:'customer.miniapp_register',entityType:'customer',entityId:item.id,title:item.name,summary:'ثبت درخواست عضویت از Mini App'});writeStore(st);
      return json(res,201,{ok:true,status:'pending',message:'درخواست عضویت ثبت شد و پس از تأیید واحد فروش فعال می‌شود.'});
    }
    if(p==='/api/app/login' && req.method==='POST'){
      const b=await parseBody(req),mobile=normalizeMobile(b.mobile),password=String(b.password||'');
      if(!mobile||!password)return json(res,400,{ok:false,error:'شماره موبایل و رمز عبور را وارد کنید'});
      const st=readStore(),customer=st.customers.find(c=>normalizeMobile(c.phone)===mobile);
      if(!customer)return json(res,401,{ok:false,error:'این شماره موبایل در مشتریان پنل پیدا نشد'});
      if(!customer.appPasswordHash)return json(res,403,{ok:false,error:'برای این مشتری قدیمی هنوز رمز Mini App تعریف نشده است؛ یک‌بار از ثبت نام، با همین شماره موبایل رمز دلخواه را تعیین کنید.'});
      if(!verifyAppPassword(password,customer.appPasswordHash))return json(res,401,{ok:false,error:'رمز عبور صحیح نیست'});
      if(customer.status!=='active')return json(res,403,{ok:false,error:'حساب شما هنوز توسط واحد فروش فعال نشده است'});
      const accessToken=signSession({customerId:customer.id,baleUserId:String(customer.baleUserId||''),appLogin:true,exp:Date.now()+12*60*60*1000});
      const vehicles=String(b.vehicles||'').split(',').map(x=>x.trim()).filter(Boolean);
      const catalog=catalogForApp(req,st,customer,vehicles);
      return json(res,200,{ok:true,accessToken,customer:publicCustomerForApp(st,customer),...catalog});
    }
    if(p==='/api/app/password-change' && req.method==='POST'){
      const b=await parseBody(req),st=readStore(),customer=appCustomer(req,st);
      if(!customer)return json(res,401,{ok:false,error:'نشست فروشگاه معتبر نیست؛ دوباره وارد شوید'});
      const current=String(b.currentPassword||''),next=String(b.newPassword||'');
      if(!verifyAppPassword(current,customer.appPasswordHash))return json(res,400,{ok:false,error:'رمز عبور فعلی صحیح نیست'});
      if(next.length<6)return json(res,400,{ok:false,error:'رمز عبور جدید حداقل ۶ کاراکتر باشد'});
      customer.appPasswordHash=hashAppPassword(next);
      addAudit(st,{actor:'customer',category:'customer',action:'customer.password_change',entityType:'customer',entityId:customer.id,title:customer.name,summary:'تغییر رمز عبور از Android App'});
      writeStore(st);
      return json(res,200,{ok:true,message:'رمز عبور با موفقیت تغییر کرد.'});
    }
    if(p==='/api/app/phone-change-request' && req.method==='POST'){
      const b=await parseBody(req),st=readStore(),customer=appCustomer(req,st);
      if(!customer)return json(res,401,{ok:false,error:'نشست فروشگاه معتبر نیست؛ دوباره وارد شوید'});
      const newMobile=normalizeMobile(b.newMobile),note=String(b.note||'').trim().slice(0,500);
      if(!newMobile)return json(res,400,{ok:false,error:'شماره همراه جدید معتبر نیست'});
      if(newMobile===normalizeMobile(customer.phone))return json(res,400,{ok:false,error:'شماره جدید با شماره فعلی یکسان است'});
      if(st.customers.some(c=>c.id!==customer.id&&normalizeMobile(c.phone)===newMobile))return json(res,409,{ok:false,error:'این شماره همراه برای مشتری دیگری ثبت شده است'});
      const pending=st.phoneChangeRequests.find(r=>r.customerId===customer.id&&r.status==='pending');
      const item=pending||{id:uid('PCR',st.phoneChangeRequests),customerId:customer.id,customerName:customer.name,currentMobile:customer.phone,status:'pending'};
      item.newMobile=newMobile; item.note=note; item.requestedAt=nowFaIran();
      if(!pending)st.phoneChangeRequests.unshift(item);
      addAudit(st,{actor:'customer',category:'customer',action:'customer.phone_change_request',entityType:'customer',entityId:customer.id,title:customer.name,summary:`درخواست تغییر شماره همراه به ${newMobile}`});
      writeStore(st);
      return json(res,201,{ok:true,item,message:'درخواست تغییر شماره همراه برای بررسی واحد فروش ثبت شد.'});
    }
    if(p==='/api/admin/phone-change-requests' && req.method==='GET'){
      if(!adminOk(req))return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'});
      const st=readStore(); return json(res,200,{ok:true,items:st.phoneChangeRequests||[]});
    }
    const pcr=p.match(/^\/api\/admin\/phone-change-requests\/([^/]+)$/);
    if(pcr && req.method==='PUT'){
      if(!adminOk(req))return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'});
      const st=readStore(),item=(st.phoneChangeRequests||[]).find(r=>r.id===decodeURIComponent(pcr[1]));
      if(!item)return json(res,404,{ok:false,error:'درخواست پیدا نشد'});
      const b=await parseBody(req),status=String(b.status||'').trim();
      if(!['approved','rejected'].includes(status))return json(res,400,{ok:false,error:'وضعیت درخواست معتبر نیست'});
      const customer=st.customers.find(c=>c.id===item.customerId);
      if(status==='approved'){
        if(!customer)return json(res,404,{ok:false,error:'مشتری پیدا نشد'});
        if(st.customers.some(c=>c.id!==customer.id&&normalizeMobile(c.phone)===normalizeMobile(item.newMobile)))return json(res,409,{ok:false,error:'شماره جدید اکنون برای مشتری دیگری ثبت شده است'});
        customer.phone=item.newMobile;
      }
      item.status=status; item.reviewedAt=nowFaIran(); item.reviewNote=String(b.note||'').trim().slice(0,500);
      addAudit(st,{category:'customer',action:`customer.phone_change_${status}`,entityType:'customer',entityId:item.customerId,title:item.customerName,summary:status==='approved'?'تأیید تغییر شماره همراه':'رد تغییر شماره همراه'});
      writeStore(st); return json(res,200,{ok:true,item,customer:safeCustomerAdmin(customer)});
    }
    const appPwd=p.match(/^\/api\/admin\/customers\/([^/]+)\/app-password$/);
    if(appPwd && req.method==='POST'){
      if(!adminOk(req))return json(res,401,{ok:false,error:'کلید مدیریت نامعتبر است'});
      const st=readStore(),customer=st.customers.find(c=>c.id===decodeURIComponent(appPwd[1]));if(!customer)return json(res,404,{ok:false,error:'مشتری پیدا نشد'});
      const b=await parseBody(req),password=String(b.password||'');if(password.length<6)return json(res,400,{ok:false,error:'رمز عبور حداقل ۶ کاراکتر باشد'});
      customer.appPasswordHash=hashAppPassword(password);writeStore(st);return json(res,200,{ok:true,customer:{id:customer.id,name:customer.name,phone:customer.phone,status:customer.status}});
    }
    if(p==='/api/app/session' && req.method==='POST'){
      const b=await parseBody(req); let user=null, verified=false;
      if(b.initData){const v=validateBaleInitData(b.initData); if(v.ok){user=v.user;verified=true;} else if(!ALLOW_DEMO)return json(res,401,{ok:false,error:v.error});}
      if(!user && ALLOW_DEMO && b.demoUserId) user={id:String(b.demoUserId),first_name:'کاربر آزمایشی'};
      if(!user)return json(res,401,{ok:false,error:'ورود از طریق بله لازم است'});
      const s=readStore(); const customer=s.customers.find(c=>String(c.baleUserId)===String(user.id));
      const access=customer?.status==='active';
      const accessToken=access?signSession({customerId:customer.id,baleUserId:String(user.id),exp:Date.now()+12*60*60*1000}):null;
      const publicCustomer=customer?{id:customer.id,name:customer.name,contact:customer.contact,status:customer.status}:null;
      return json(res,200,{ok:true,verified,user,customer:publicCustomer,access,accessToken});
    }
    if(p==='/api/app/catalog' && req.method==='GET'){
      const s=readStore(); const c=appCustomer(req,s);
      if(!c)return json(res,401,{ok:false,error:'نشست فروشگاه معتبر نیست؛ دوباره وارد شوید'});
      const vehicles=String(url.searchParams.get('vehicles')||'').split(',').map(x=>x.trim()).filter(Boolean);
      const catalog=catalogForApp(req,s,c,vehicles);
      return json(res,200,{ok:true,customer:publicCustomerForApp(s,c),...catalog});
    }
    if(p==='/api/app/orders' && req.method==='GET'){
      const s=readStore(); const c=appCustomer(req,s);
      if(!c)return json(res,401,{ok:false,error:'نشست فروشگاه معتبر نیست'});
      const items=s.orders.filter(x=>x.customerId===c.id).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).map(o=>({
        ...o,
        orderNo:o.id,
        paymentMethodCode:String(o.paymentMethod||'credit'),
        paymentMethod:String(o.paymentMethod||'credit')==='cash'?'نقدی':'اعتباری',
        statusLabel:statusFa(o.status),
        totalQuantity:(o.items||[]).reduce((sum,row)=>sum+Number(row.qty||0),0),
        totalFormatted:Number(o.total||0).toLocaleString('en-US')+' تومان',
        payableTotalFormatted:Number(o.payableTotal??o.total??0).toLocaleString('en-US')+' تومان'
      }));
      return json(res,200,{ok:true,items});
    }
    if(p==='/api/app/orders' && req.method==='POST'){
      const b=await parseBody(req); const s=readStore(); const c=appCustomer(req,s);
      if(!c)return json(res,401,{ok:false,error:'نشست فروشگاه معتبر نیست'});
      const lines=[]; let total=0;
      for(const row of (Array.isArray(b.items)?b.items:[])){
        const pr=s.products.find(x=>x.id===row.productId&&isBaleVisibleProduct(x,s)); if(!pr)continue;
        const q=Math.max(1,Math.floor(Number(row.qty||1))); const rp=resolvePrice(s,c,pr); const lineTotal=rp.price*q; total+=lineTotal;
        lines.push({productId:pr.id,code:pr.code,name:pr.name,vehicle:pr.vehicle,qty:q,unitPrice:rp.price,lineTotal});
      }
      if(!lines.length)return json(res,400,{ok:false,error:'سبد سفارش خالی است'});
      const rawMethod=normalizeFaSearch(b.paymentMethod||'credit');
      const isCash=rawMethod==='cash'||rawMethod.includes('نقد');
      const method=isCash?'cash':'credit';
      const cash=isCash?cashTotals(s,c,total):{discount:0,payable:total};
      const paymentUrl=isCash?paymentUrlFor(s,c,cash.payable,total,cash.discount):'';
      const order={id:nextAppOrderId(s,c),customerId:c.id,customerName:c.name,baleUserId:String(c.baleUserId||''),items:lines,total,paymentMethod:method,paymentStatus:isCash?'pending':'credit',discountAmount:Number(cash.discount||0),payableTotal:Number(cash.payable||total),status:'registered',createdAt:nowFaIran()};
      s.orders.push(order);addAudit(s,{actor:'customer',category:'order',action:'order.create',entityType:'order',entityId:order.id,title:order.customerName,summary:`ثبت سفارش از Mini App با ${lines.length} قلم و مبلغ ${total.toLocaleString('fa-IR')} تومان`});writeStore(s);
      if(BALE_BOT_TOKEN && c.baleUserId){const bt=normalizeBotTexts(s); bale('sendMessage',{chat_id:Number(c.baleUserId),text:renderBotText(bt.orderRegistered,{orderId:order.id,total:total.toLocaleString('fa-IR'),status:'ثبت شده'})}).catch(()=>{});}
      return json(res,201,{ok:true,order:{...order,orderNo:order.id,paymentMethodCode:order.paymentMethod,paymentMethod:order.paymentMethod==='cash'?'نقدی':'اعتباری',statusLabel:statusFa(order.status),totalQuantity:lines.reduce((sum,row)=>sum+row.qty,0)},paymentUrl});
    }
    if(p==='/bale/webhook' && req.method==='POST'){ const u=await parseBody(req); await processBaleUpdate(u); return json(res,200,{ok:true}); }
    if(serveFile(req,res,p)) return;
    return json(res,404,{ok:false,error:'Not found'});
  }catch(e){console.error(e);return json(res,500,{ok:false,error:'خطای داخلی سرور',detail:process.env.NODE_ENV==='development'?e.message:undefined});}
});
server.listen(PORT,HOST,()=>{console.log(`Almas Bale Sales 13000 V2.41 running on http://${HOST}:${PORT}`); if(BALE_POLLING)pollBale();});
