import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(ROOT, 'public');
const defaultFile = path.join(ROOT, 'data', 'store.json');
const PLAN = { individual: 12000, equipo: 29990 };
const TYPES = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.svg':'image/svg+xml' };
const state = new Map();
const sessions = new Map();
const failures = new Map();
const minute = 60_000;

function initial() { return { nextOrder: 1, orders: [], shops: [], bookings: [], events: [], blocks: [] }; }
function readStore(file) { try { return { ...initial(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') throw e; return initial(); } }
function saveStore(file, store) { fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = `${file}.tmp`; fs.writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); }
function clean(value, max=200) { return String(value ?? '').trim().slice(0,max); }
function stableId(value,fallback,used) { let id=clean(value,32);if(!/^[a-zA-Z0-9_-]{1,32}$/.test(id)||used.has(id)){id=fallback;let n=2;while(used.has(id))id=`${fallback}-${n++}`}used.add(id);return id; }
function safeImage(value,maxBytes=4*1024*1024) { if(!value)return ''; const match=String(value).match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);if(!match) return '';const bytes=Buffer.from(match[2],'base64');if(bytes.length>maxBytes)return '';const valid=match[1]==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):match[1]==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';return valid?`data:${match[1]};base64,${match[2]}`:''; }
function slugify(value) { return clean(value,90).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60) || 'barberia'; }
function hashSecret(secret, salt=crypto.randomBytes(16)) { const key=crypto.scryptSync(secret,salt,64); return `${salt.toString('hex')}:${key.toString('hex')}`; }
function verifySecret(secret, stored) { try { const [s,k]=stored.split(':'); const expected=Buffer.from(k,'hex'); const actual=crypto.scryptSync(secret,Buffer.from(s,'hex'),64); return expected.length===actual.length && crypto.timingSafeEqual(actual,expected); } catch { return false; } }
function newSession(role, shopId=null) { const token=crypto.randomBytes(32).toString('base64url'); sessions.set(token,{role,shopId,expires:Date.now()+8*60*60*1000}); return token; }
function session(req) { let token=''; try { token=Object.fromEntries((req.headers.cookie||'').split(';').map(s=>{const [k,...v]=s.trim().split('=');return [decodeURIComponent(k),decodeURIComponent(v.join('='))]})).nx_session||''; } catch { return null; } const item=sessions.get(token); if (!item || item.expires<Date.now()) { if(token)sessions.delete(token); return null; } item.expires=Date.now()+8*60*60*1000; return item; }
function sessionCookie(req,token,maxAge=28800) { return `nx_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${process.env.NODE_ENV==='production'?'; Secure':''}`; }
function send(res,status,data,headers={}) { res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}); res.end(JSON.stringify(data)); }
function jsonBody(req,maxBytes=8_000_000) { return new Promise((resolve,reject)=>{let size=0,body='';req.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){reject(Object.assign(new Error('Solicitud demasiado grande.'),{status:413}));req.destroy();return}body+=chunk});req.on('end',()=>{try{resolve(body?JSON.parse(body):{})}catch{reject(Object.assign(new Error('JSON inválido.'),{status:400}))}});req.on('error',reject)}); }
function safeConfig(input,plan) {
  const allowedPeople=plan==='equipo'?5:1;
  const serviceIds=new Set();const services=Array.isArray(input.services)?input.services.slice(0,20).map((s,i)=>({id:stableId(s.id,`svc-${i+1}`,serviceIds),name:clean(s.name,70),description:clean(s.description,240),price:Math.max(0,Math.min(1000000,Math.round(Number(s.price)||0))),duration:Math.min(240,Math.max(10,Math.round(Number(s.duration)||30)))})).filter(s=>s.name):[];
  const staffIds=new Set();const staff=Array.isArray(input.staff)?input.staff.slice(0,allowedPeople).map((p,i)=>{
    const own=Array.isArray(p.services)?p.services:services;
    const professionalServices=own.slice(0,20).map(s=>{const base=services.find(x=>x.name===clean(s.name,70))||services.find(x=>x.id===clean(s.id,20));if(!base)return null;return {...base,price:Math.max(0,Math.min(1000000,Math.round(Number(s.price??base.price)||0))),duration:Math.min(240,Math.max(10,Math.round(Number(s.duration??base.duration)||30)))}}).filter(Boolean);
    return {id:stableId(p.id,`pro-${i+1}`,staffIds),name:clean(p.name,70),schedule:Array.isArray(p.schedule)?p.schedule.slice(0,7).map(x=>clean(x,100)):[],daysOff:Array.isArray(p.daysOff)?p.daysOff.slice(0,366).map(x=>clean(x,10)).filter(x=>/^\d{4}-\d\d-\d\d$/.test(x)):[],services:professionalServices};
  }).filter(p=>p.name):[];
  const photos=Array.isArray(input.photos)?input.photos.slice(0,8).map(p=>({name:clean(p.name,100),type:clean(p.type,30),data:safeImage(p.data)})).filter(p=>p.data):[];
  return {businessName:clean(input.businessName,100),description:clean(input.description,500),logo:safeImage(input.logo,1024*1024),hero:safeImage(input.hero),photos,services,address:clean(input.address,180),hours:clean(input.hours,300),whatsapp:clean(input.whatsapp,24),instagram:clean(input.instagram,120),plan,staff};
}
function completeConfig(c) { const staffOk=c.plan==='equipo'?c.staff.length>=2&&c.staff.length<=5:c.staff.length===1; return c.businessName.length>=2&&c.services.length>0&&c.services.every(s=>s.price>0)&&c.whatsapp.replace(/\D/g,'').length>=8&&staffOk&&c.staff.every(p=>p.services.length>0&&p.services.every(s=>s.price>0)); }
function notify(db,shopId,kind,message) { db.events.push({id:crypto.randomUUID(),shopId,kind,message,createdAt:new Date().toISOString(),read:false}); }
function expirePending(db,file,shopId=null) { let changed=false;for(const booking of db.bookings.filter(b=>(!shopId||b.shopId===shopId)&&b.status==='Pendiente'&&b.expiresAt&&new Date(b.expiresAt).getTime()<=Date.now())){booking.status='Expirada';booking.respondedAt=new Date().toISOString();notify(db,booking.shopId,'booking-expired',`Solicitud expirada: ${booking.customerName} · ${booking.date} ${booking.time}`);changed=true}if(changed)saveStore(file,db); }
function overlap(startA,durationA,startB,durationB) { return startA < startB+durationB && startB < startA+durationA; }
const chileFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Santiago',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function chileDateTime(date,time) { if(!/^\d{4}-\d\d-\d\d$/.test(date)||!/^\d\d:\d\d$/.test(time))return NaN;const [y,m,d]=date.split('-').map(Number),[h,min]=time.split(':').map(Number);if(m<1||m>12||d<1||d>31||h>23||min>59)return NaN;const target=Date.UTC(y,m-1,d,h,min);let guess=target;for(let i=0;i<4;i++){const p=Object.fromEntries(chileFormatter.formatToParts(new Date(guess)).map(x=>[x.type,Number(x.value)]));const represented=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute);guess+=target-represented;}const p=Object.fromEntries(chileFormatter.formatToParts(new Date(guess)).map(x=>[x.type,Number(x.value)]));return p.year===y&&p.month===m&&p.day===d&&p.hour===h&&p.minute===min?guess:NaN; }
function dateTime(date,time) { return chileDateTime(date,time); }
function weekday(date) { const [y,m,d]=date.split('-').map(Number);return new Date(Date.UTC(y,m-1,d)).getUTCDay(); }
function validDate(date,time) { const t=chileDateTime(date,time);return Number.isFinite(t)&&t>Date.now(); }
function proService(config,professionalId,serviceId) { const pro=config.staff.find(p=>p.id===professionalId);return pro?.services?.find(s=>s.id===serviceId)||null; }
function slugFree(db,wanted) { let slug=wanted, n=2;while(db.shops.some(s=>s.slug===slug))slug=`${wanted}-${n++}`;return slug; }
function clientIp(req) { return req.socket.remoteAddress||'unknown'; }
function rateLimit(req,limit=20) { const key=clientIp(req);const cur=failures.get(key)||{start:Date.now(),count:0};if(Date.now()-cur.start>minute){cur.start=Date.now();cur.count=0}cur.count++;failures.set(key,cur);return cur.count<=limit; }

export function createServer({ dataFile=process.env.NEXORA_DATA_FILE||defaultFile, adminPassword=process.env.NEXORA_ADMIN_PASSWORD||'' }={}) {
 const db=readStore(dataFile);
 return http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');const method=req.method||'GET';
  if(method==='OPTIONS'){res.writeHead(204,{allow:'GET,POST,PUT,PATCH,OPTIONS'});return res.end()}
  if(method!=='GET'&&req.headers.origin){const origin=new URL(req.headers.origin);if(origin.host!==req.headers.host){send(res,403,{error:'Origen no permitido.'});return}}
  try{
   if(method==='GET'&&url.pathname==='/api/health')return send(res,200,{ok:true,mode:'local',storage:'file'});
   if(method==='POST'&&url.pathname==='/api/orders'){
    if(!rateLimit(req,10))return send(res,429,{error:'Demasiados intentos. Intenta más tarde.'});
    const body=await jsonBody(req,56*1024*1024);const plan=body.plan;
    if(!Object.hasOwn(PLAN,plan))return send(res,400,{error:'Selecciona un plan válido.'});
    const config=safeConfig(body.config||{},plan);
    if(!completeConfig(config))return send(res,400,{error:'Indica el nombre del local, al menos un servicio y un WhatsApp válido.'});if(plan==='equipo'&&(config.staff.length<2||config.staff.length>5))return send(res,400,{error:'El plan Equipo requiere entre dos y cinco profesionales.'});
    const id=`NX-${String(db.nextOrder++).padStart(4,'0')}`;
    const buyer={name:clean(body.buyer?.name,100),contact:clean(body.buyer?.contact,40)};if(!buyer.name||buyer.contact.replace(/\D/g,'').length<8)return send(res,400,{error:'Indica tu nombre y un WhatsApp válido para el pedido.'});
    const order={id,plan,total:PLAN[plan],status:'Pendiente de pago',buyer,config,createdAt:new Date().toISOString(),history:[{status:'Pendiente de pago',at:new Date().toISOString()}]};
    db.orders.push(order);saveStore(dataFile,db);return send(res,201,{id,plan,total:order.total,status:order.status});
   }
   if(method==='POST'&&url.pathname==='/api/order-status'){
    const body=await jsonBody(req);const order=db.orders.find(x=>x.id===clean(body.id,20)&&x.buyer?.contact.replace(/\D/g,'')===clean(body.contact,40).replace(/\D/g,''));return order?send(res,200,{id:order.id,status:order.status,publicUrl:order.publicUrl||null}):send(res,404,{error:'No encontramos ese pedido con esos datos.'});
   }
   if(method==='POST'&&url.pathname==='/api/admin/login'){
    if(!rateLimit(req,8))return send(res,429,{error:'Pausa breve por seguridad.'});const body=await jsonBody(req);
    if(adminPassword.length<16)return send(res,401,{error:'Configura NEXORA_ADMIN_PASSWORD con una frase privada de al menos 16 caracteres.'});if(!verifySecret(String(body.password||''),hashSecret(adminPassword,Buffer.alloc(16))))return send(res,401,{error:'Credenciales incorrectas.'});
    const token=newSession('admin');return send(res,200,{ok:true,role:'admin'},{'set-cookie':sessionCookie(req,token)});
   }
   if(method==='POST'&&url.pathname==='/api/barber/login'){
    if(!rateLimit(req,8))return send(res,429,{error:'Pausa breve por seguridad.'});const body=await jsonBody(req);const shop=db.shops.find(x=>x.ownerEmail.toLowerCase()===clean(body.email,200).toLowerCase());
    if(!shop||!shop.passwordHash||!verifySecret(String(body.password||''),shop.passwordHash))return send(res,401,{error:'Correo o contraseña incorrectos.'});
    const token=newSession('barber',shop.id);return send(res,200,{ok:true,role:'barber',shop:shop.slug},{'set-cookie':sessionCookie(req,token)});
   }
   if(method==='POST'&&url.pathname==='/api/barber/accept-invite'){
    const body=await jsonBody(req);const invite=db.events.find(x=>x.kind==='invite'&&x.tokenHash===crypto.createHash('sha256').update(clean(body.token,100)).digest('hex')&&x.expires>Date.now());
    const email=clean(body.email,200).toLowerCase();if(!invite||String(body.password||'').length<12||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return send(res,400,{error:'Invitación inválida. Indica un correo válido y una contraseña de al menos 12 caracteres.'});
    const shop=db.shops.find(x=>x.id===invite.shopId);if(!shop)return send(res,404,{error:'Local no encontrado.'});if(db.shops.some(x=>x.id!==shop.id&&x.ownerEmail.toLowerCase()===email))return send(res,409,{error:'Ese correo ya administra otra barbería.'});shop.ownerEmail=email;shop.passwordHash=hashSecret(body.password);db.events=db.events.filter(x=>x!==invite);saveStore(dataFile,db);const token=newSession('barber',shop.id);return send(res,201,{ok:true,shop:shop.slug},{'set-cookie':sessionCookie(req,token)});
   }
   if(method==='POST'&&url.pathname==='/api/logout'){const cookie=session(req);if(cookie){const raw=(req.headers.cookie||'').match(/nx_session=([^;]+)/)?.[1];try{sessions.delete(decodeURIComponent(raw||''))}catch{}}res.writeHead(200,{'set-cookie':sessionCookie(req,'',0),'content-type':'application/json'});return res.end('{"ok":true}')}
   const auth=session(req);
   if(url.pathname.startsWith('/api/admin/')){
    if(auth?.role!=='admin')return send(res,401,{error:'Inicia sesión como administrador.'});
    if(method==='GET'&&url.pathname==='/api/admin/orders')return send(res,200,{orders:db.orders.map(({config,...o})=>({...o,configSummary:{businessName:config.businessName,services:config.services,staff:config.staff.length}})),shops:db.shops.map(s=>({slug:s.slug,businessName:s.config.businessName,plan:s.config.plan,status:s.status,publicUrl:s.publicUrl}))});
   if(method==='GET'&&url.pathname==='/api/admin/order'){
    const order=db.orders.find(x=>x.id===clean(url.searchParams.get('id'),20));return order?send(res,200,{order}):send(res,404,{error:'Pedido no encontrado.'});
   }
    const match=url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/(paid|publish|deliver|invite|cancel)$/);
    if(method==='POST'&&match){const order=db.orders.find(x=>x.id===decodeURIComponent(match[1]));if(!order)return send(res,404,{error:'Pedido no encontrado.'});const action=match[2];const body=await jsonBody(req);
     if(action==='paid'){if(order.status!=='Pendiente de pago')return send(res,409,{error:'El pedido no está pendiente de pago.'});const ref=clean(body.reference,100);if(!ref)return send(res,400,{error:'Registra una referencia de verificación (revisión manual del medio de pago).'});order.paymentReference=ref;order.paidAt=new Date().toISOString();order.status='Pago confirmado';}
     if(action==='publish'){if(!['Pago confirmado','Preparando publicación'].includes(order.status))return send(res,409,{error:'Confirma el pago antes de publicar.'});if(!completeConfig(order.config))return send(res,400,{error:'La configuración está incompleta.'});order.status='Preparando publicación';let shop=db.shops.find(s=>s.orderId===order.id);if(!shop){const slug=slugFree(db,slugify(order.config.businessName));shop={id:crypto.randomUUID(),orderId:order.id,slug,config:order.config,status:'Publicado',passwordHash:'',ownerEmail:'',createdAt:new Date().toISOString()};db.shops.push(shop)}order.status='Publicado';order.publicUrl=`/b/${shop.slug}`;order.publishedAt=new Date().toISOString();notify(db,shop.id,'published','Tu página ya fue publicada.');}
     if(action==='deliver'){if(order.status!=='Publicado')return send(res,409,{error:'Publica la página antes de marcarla como entregada.'});order.status='Entregado';order.deliveredAt=new Date().toISOString()}
     if(action==='cancel'){if(order.status==='Entregado'||order.status==='Cancelado')return send(res,409,{error:'No se puede cancelar un pedido entregado o cancelado.'});order.status='Cancelado';order.cancelledAt=new Date().toISOString();const shop=db.shops.find(s=>s.orderId===order.id);if(shop)shop.status='Cancelado'}
     if(action==='invite'){const shop=db.shops.find(s=>s.orderId===order.id);if(!shop)return send(res,409,{error:'Publica primero la página.'});const token=crypto.randomBytes(32).toString('base64url');db.events.push({id:crypto.randomUUID(),kind:'invite',shopId:shop.id,tokenHash:crypto.createHash('sha256').update(token).digest('hex'),expires:Date.now()+24*60*60*1000,createdAt:new Date().toISOString()});saveStore(dataFile,db);return send(res,201,{inviteUrl:`/activar?token=${token}`,expiresHours:24})}
     order.history.push({status:order.status,at:new Date().toISOString(),action,reference:action==='paid'?order.paymentReference:undefined});saveStore(dataFile,db);return send(res,200,{id:order.id,status:order.status,publicUrl:order.publicUrl||null});}
   }
   if(url.pathname==='/api/barber/me'){
    if(auth?.role!=='barber')return send(res,401,{error:'Inicia sesión como barbero.'});const shop=db.shops.find(s=>s.id===auth.shopId);if(!shop)return send(res,401,{error:'Sesión no válida.'});
    if(method==='GET'){expirePending(db,dataFile,shop.id);return send(res,200,{shop:{slug:shop.slug,config:shop.config},bookings:db.bookings.filter(b=>b.shopId===shop.id),blocks:db.blocks.filter(b=>b.shopId===shop.id),events:db.events.filter(e=>e.shopId===shop.id&&e.kind!=='invite')})}
    if(method==='PUT'){const body=await jsonBody(req,56*1024*1024);const next=safeConfig(body.config||{},shop.config.plan);if(!completeConfig(next))return send(res,400,{error:'Configuración incompleta o precios inválidos.'});const retained=new Set(next.staff.map(p=>p.id));const assigned=db.bookings.some(b=>b.shopId===shop.id&&['Pendiente','Confirmada'].includes(b.status)&&dateTime(b.date,b.time)>Date.now()&&!retained.has(b.professionalId))||db.blocks.some(b=>b.shopId===shop.id&&dateTime(b.date,b.time)>Date.now()&&!retained.has(b.professionalId));if(assigned)return send(res,409,{error:'No puedes quitar a un profesional con reservas o bloqueos futuros. Cancela o libera esos horarios, o conserva su perfil.'});shop.config=next;saveStore(dataFile,db);notify(db,shop.id,'updated','El dueño actualizó la información del local.');return send(res,200,{ok:true})}
   }
   const bookingMatch=url.pathname.match(/^\/api\/barber\/bookings\/([^/]+)\/(accept|reject|cancel)$/);
   if(method==='POST'&&bookingMatch){if(auth?.role!=='barber')return send(res,401,{error:'Inicia sesión como barbero.'});const booking=db.bookings.find(b=>b.id===decodeURIComponent(bookingMatch[1])&&b.shopId===auth.shopId);if(!booking)return send(res,404,{error:'Reserva no encontrada.'});const action=bookingMatch[2],status=action==='accept'?'Confirmada':action==='reject'?'Rechazada':'Cancelada';if(action==='cancel'?!['Pendiente','Confirmada'].includes(booking.status):booking.status!=='Pendiente')return send(res,409,{error:'La solicitud ya fue respondida.'});booking.status=status;booking.respondedAt=new Date().toISOString();if(action==='cancel'){booking.cancelledAt=new Date().toISOString();notify(db,booking.shopId,'booking-cancelled',`Reserva cancelada por el local: ${booking.customerName} · ${booking.date} ${booking.time}`)}else notify(db,booking.shopId,'booking-status',`Solicitud ${status.toLowerCase()}: ${booking.customerName}`);saveStore(dataFile,db);return send(res,200,{id:booking.id,status})}
   const publicMatch=url.pathname.match(/^\/api\/public\/shops\/([^/]+)$/);
   if(method==='GET'&&publicMatch){const shop=db.shops.find(s=>s.slug===decodeURIComponent(publicMatch[1])&&s.status==='Publicado');return shop?send(res,200,{slug:shop.slug,config:shop.config}):send(res,404,{error:'Página no encontrada.'})}
   if(method==='POST'&&url.pathname==='/api/barber/blocks'){
    if(auth?.role!=='barber')return send(res,401,{error:'Inicia sesión como barbero.'});const body=await jsonBody(req);const date=clean(body.date,10),time=clean(body.time,5),professionalId=clean(body.professionalId,20),duration=Math.min(480,Math.max(15,Math.round(Number(body.duration)||60)));const shop=db.shops.find(s=>s.id===auth.shopId);if(!shop.config.staff.some(p=>p.id===professionalId)||!validDate(date,time)||!/^\d{2}:\d{2}$/.test(time))return send(res,400,{error:'Elige un profesional, fecha y hora válidos.'});const block={id:crypto.randomUUID(),shopId:shop.id,professionalId,date,time,duration,note:clean(body.note,120)};if(db.blocks.some(b=>b.shopId===shop.id&&b.professionalId===professionalId&&b.date===date&&overlap(dateTime(date,time),duration,dateTime(date,b.time),b.duration)))return send(res,409,{error:'Ese horario ya está bloqueado.'});db.blocks.push(block);saveStore(dataFile,db);notify(db,shop.id,'block','Se bloqueó un horario en el calendario.');return send(res,201,{block});
   }
   const blockMatch=url.pathname.match(/^\/api\/barber\/blocks\/([^/]+)$/);if(method==='DELETE'&&blockMatch){if(auth?.role!=='barber')return send(res,401,{error:'Inicia sesión como barbero.'});const index=db.blocks.findIndex(b=>b.id===decodeURIComponent(blockMatch[1])&&b.shopId===auth.shopId);if(index<0)return send(res,404,{error:'Bloque no encontrado.'});db.blocks.splice(index,1);saveStore(dataFile,db);return send(res,200,{ok:true})}
   if(method==='GET'&&url.pathname==='/api/public/availability'){
    const shop=db.shops.find(s=>s.slug===clean(url.searchParams.get('slug'),80)&&s.status==='Publicado');if(!shop)return send(res,404,{error:'Página no encontrada.'});const date=clean(url.searchParams.get('date'),10),pro=shop.config.staff.find(p=>p.id===clean(url.searchParams.get('professional'),20));if(!pro||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)||!Number.isFinite(dateTime(date,'12:00')))return send(res,400,{error:'Elige una fecha y profesional válidos.'});
    const dayNo=weekday(date),dayNames=['domingo','lunes','martes','miércoles','jueves','viernes','sábado'],labels=[];const schedule=(pro.schedule||[]).join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();const range=schedule.match(/(\d{1,2}:\d{2})\s*[-–a]\s*(\d{1,2}:\d{2})/);const dayOk=!pro.daysOff?.includes(date)&&(!schedule||(dayNo>0&&/lun(?:es)?\s*(?:a|-)\s*sab(?:ado)?/.test(schedule))||schedule.includes(dayNames[dayNo])||(dayNo===1&&schedule.includes('lun'))||(dayNo===2&&schedule.includes('mar'))||(dayNo===3&&schedule.includes('mie'))||(dayNo===4&&schedule.includes('jue'))||(dayNo===5&&schedule.includes('vie'))||(dayNo===6&&schedule.includes('sab')));const startEnd=range?range.slice(1).map(x=>{const [h,m]=x.split(':').map(Number);return h*60+m}):[9*60,20*60];const service=proService(shop.config,pro.id,clean(url.searchParams.get('service'),20));const duration=service?.duration||30;
    for(let minute=Math.ceil(startEnd[0]/30)*30;minute+duration<=startEnd[1];minute+=30)labels.push(`${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`);const availability=labels.map(time=>{const [h,m]=time.split(':').map(Number),start=dateTime(date,time),booking=db.bookings.find(b=>b.shopId===shop.id&&b.professionalId===pro.id&&b.date===date&&['Pendiente','Confirmada'].includes(b.status)&&(!b.expiresAt||new Date(b.expiresAt).getTime()>Date.now())&&overlap(start,duration,dateTime(date,b.time),b.duration)),blocked=db.blocks.some(b=>b.shopId===shop.id&&b.professionalId===pro.id&&b.date===date&&overlap(start,duration,dateTime(date,b.time),b.duration)),inRange=h*60+m>=startEnd[0]&&h*60+m+duration<=startEnd[1];return {time,status:!service?'Servicio no disponible':!dayOk||!inRange?'Fuera de horario':booking?.status==='Pendiente'?'Solicitado':booking||blocked?'Ocupado':'Disponible'}});return send(res,200,{date,professional:pro.id,availability});
   }
   if(method==='GET'&&url.pathname==='/api/booking-status'){expirePending(db,dataFile);const id=clean(url.searchParams.get('id'),80),phone=clean(url.searchParams.get('contact'),40).replace(/\D/g,'');const booking=db.bookings.find(x=>x.id===id&&x.contact.replace(/\D/g,'')===phone);return booking?send(res,200,{id:booking.id,status:booking.status,date:booking.date,time:booking.time,service:booking.service}):send(res,404,{error:'No encontramos esa solicitud con esos datos.'})}
   if(method==='POST'&&url.pathname==='/api/public/bookings/cancel'){if(!rateLimit(req,20))return send(res,429,{error:'Demasiados intentos. Intenta más tarde.'});expirePending(db,dataFile);const body=await jsonBody(req),id=clean(body.id,80),phone=clean(body.contact,40).replace(/\D/g,'');const booking=db.bookings.find(x=>x.id===id&&x.contact.replace(/\D/g,'')===phone);if(!booking)return send(res,404,{error:'No encontramos esa solicitud con esos datos.'});if(!['Pendiente','Confirmada'].includes(booking.status))return send(res,409,{error:`No se puede cancelar una solicitud ${booking.status.toLowerCase()}.`});booking.status='Cancelada';booking.cancelledAt=new Date().toISOString();notify(db,booking.shopId,'booking-cancelled',`Reserva cancelada: ${booking.customerName} · ${booking.date} ${booking.time}`);saveStore(dataFile,db);return send(res,200,{id:booking.id,status:booking.status});}
   if(method==='POST'&&url.pathname==='/api/public/bookings'){
    if(!rateLimit(req,30))return send(res,429,{error:'Demasiadas solicitudes. Intenta más tarde.'});
    const body=await jsonBody(req);const shop=db.shops.find(s=>s.slug===clean(body.slug,80)&&s.status==='Publicado');if(!shop)return send(res,404,{error:'Página no encontrada.'});const pro=shop.config.staff.find(p=>p.id===body.professionalId);if(!pro)return send(res,400,{error:'Profesional inválido.'});const svc=proService(shop.config,pro.id,clean(body.serviceId,20));if(!svc)return send(res,400,{error:'Ese profesional no ofrece el servicio elegido.'});
    const day=clean(body.date,10),time=clean(body.time,5);if(!validDate(day,time))return send(res,400,{error:'Fecha u hora no disponibles.'});const start=dateTime(day,time);const [hours,mins]=time.split(':').map(Number);if((mins!==0&&mins!==30)||hours<0||hours>23)return send(res,400,{error:'Fuera de horario.'});const duration=svc.duration;
    const schedule=(pro.schedule||[]).join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();const range=schedule.match(/(\d{1,2}:\d{2})\s*[-–a]\s*(\d{1,2}:\d{2})/);const dayNo=weekday(day),dayNames=['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];const dayOk=!pro.daysOff?.includes(day)&&(!schedule||(dayNo>0&&/lun(?:es)?\s*(?:a|-)\s*sab(?:ado)?/.test(schedule))||schedule.includes(dayNames[dayNo])||(dayNo===1&&schedule.includes('lun'))||(dayNo===2&&schedule.includes('mar'))||(dayNo===3&&schedule.includes('mie'))||(dayNo===4&&schedule.includes('jue'))||(dayNo===5&&schedule.includes('vie'))||(dayNo===6&&schedule.includes('sab')));const bounds=range?range.slice(1).map(x=>{const [h,m]=x.split(':').map(Number);return h*60+m}):[9*60,20*60];const minuteOfDay=hours*60+mins;if(!dayOk||minuteOfDay<bounds[0]||minuteOfDay+duration>bounds[1])return send(res,400,{error:'Fuera del horario configurado para este profesional.'});
    const conflict=db.bookings.some(b=>b.shopId===shop.id&&b.professionalId===pro.id&&b.date===day&&['Pendiente','Confirmada'].includes(b.status)&&(!b.expiresAt||new Date(b.expiresAt).getTime()>Date.now())&&overlap(start,duration,dateTime(day,b.time),b.duration));
    const blocked=db.blocks.some(b=>b.shopId===shop.id&&b.professionalId===pro.id&&b.date===day&&overlap(start,duration,dateTime(day,b.time),b.duration));if(conflict||blocked)return send(res,409,{error:'Ese bloque se ocupó. Elige otro horario.'});
    const booking={id:crypto.randomUUID(),shopId:shop.id,professionalId:pro.id,professional:pro.name,customerName:clean(body.name,80),contact:clean(body.contact,40),serviceId:svc.id,service:svc.name,price:svc.price,duration,date:day,time,status:'Pendiente',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+20*minute).toISOString()};if(!booking.customerName||booking.contact.replace(/\D/g,'').length<8)return send(res,400,{error:'Indica nombre y contacto válido.'});db.bookings.push(booking);notify(db,shop.id,'booking',`Nueva solicitud: ${booking.customerName} · ${booking.service} · ${day} ${time}`);saveStore(dataFile,db);return send(res,201,{id:booking.id,status:booking.status,expiresAt:booking.expiresAt});
   }
   if(method==='GET'&&url.pathname==='/api/ping')return send(res,200,{ok:true});
   if(method==='GET'&&/^\/b\/[^/]+$/.test(url.pathname)){const file=fs.readFileSync(path.join(publicDir,'public.html'));res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-cache'});return res.end(file)}
   if(method==='GET'){
    const filePath=url.pathname==='/admin'?'/admin.html':url.pathname==='/barbero'?'/barbero.html':url.pathname==='/activar'?'/activar.html':url.pathname==='/vista-previa'?'/preview.html':url.pathname;
    const safePath=path.resolve(publicDir,`.${filePath==='/'?'/index.html':filePath}`);const relativePath=path.relative(publicDir,safePath);if(relativePath.startsWith('..')||path.isAbsolute(relativePath))return send(res,403,{error:'Ruta no válida.'});
    try{const file=fs.readFileSync(safePath);res.writeHead(200,{'content-type':TYPES[path.extname(safePath)]||'application/octet-stream','cache-control':'no-cache'});return res.end(file)}catch{return send(res,404,{error:'No encontrado.'})}
   }
   return send(res,404,{error:'Ruta no encontrada.'});
  }catch(err){if(err.status)return send(res,err.status,{error:err.message});if(!res.headersSent)send(res,500,{error:'Error interno. Intenta nuevamente.'});}
 });
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const server=createServer();const port=Number(process.env.PORT||8765),host=process.env.HOST||(process.env.NODE_ENV==='production'?'0.0.0.0':'127.0.0.1');server.listen(port,host,()=>console.log(`NEXORA listo en http://${host}:${port}. Datos: ${process.env.NEXORA_DATA_FILE||defaultFile}`));
}



