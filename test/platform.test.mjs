import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.mjs';

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nexora-test-'));
const server=createServer({dataFile:path.join(temp,'store.json'),adminPassword:'test-admin-passphrase-123'});
let base='',adminCookie='',barberCookie='',orderId='',shopSlug='';
const config={businessName:'Taller Test',description:'Muestra',whatsapp:'+56912345678',address:'Providencia',hours:'Lunes a sábado 10:00-19:00',plan:'equipo',services:[{name:'Corte',price:15000,duration:60}],staff:[{name:'Ana',schedule:['Lunes a sábado 10:00-19:00']},{name:'Beto',schedule:['Lunes a sábado 10:00-19:00'],services:[{id:'svc-1',name:'Corte',price:19000,duration:30}]}],photos:[]};
const buyer={name:'Comprador de prueba',contact:'+56911112222'};
async function api(p,opt={}){const r=await fetch(base+p,opt);let data={};try{data=await r.json()}catch{}return {status:r.status,data,cookie:r.headers.get('set-cookie')}}
function json(body,cookie=''){return {method:'POST',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(body)}}
function nextWeekday(){const d=new Date();d.setDate(d.getDate()+10);while(d.getDay()===0)d.setDate(d.getDate()+1);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
test.before(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`});
test.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true})});
test('checkout is persistent and unpublished until payment is verified',async()=>{
 let r=await api('/api/orders',json({plan:'equipo',config,buyer}));assert.equal(r.status,201);orderId=r.data.id;assert.equal(r.data.total,29990);
 r=await api(`/api/order-status`,json({id:orderId}));assert.equal(r.status,404,'order status is private without buyer contact');r=await api(`/api/order-status`,json({id:orderId,contact:buyer.contact}));assert.equal(r.data.status,'Pendiente de pago');
 r=await api('/api/admin/login',json({password:'test-admin-passphrase-123'}));assert.equal(r.status,200);adminCookie=r.cookie.split(';')[0];
 r=await api(`/api/admin/order?id=${orderId}`);assert.equal(r.status,401,'order detail is restricted to admin');r=await api(`/api/admin/order?id=${orderId}`,{headers:{cookie:adminCookie}});assert.equal(r.data.order.buyer.name,buyer.name,'admin can inspect buyer details');
 r=await api(`/api/admin/orders/${orderId}/publish`,json({},adminCookie));assert.equal(r.status,409);
 r=await api(`/api/admin/orders/${orderId}/paid`,json({reference:'Verificado en medio de pago'},adminCookie));assert.equal(r.status,200);assert.equal(r.data.status,'Pago confirmado');
 r=await api(`/api/admin/orders/${orderId}/publish`,json({},adminCookie));assert.equal(r.status,200);shopSlug=r.data.publicUrl.split('/').at(-1);assert.equal(r.data.status,'Publicado');
 const persisted=JSON.parse(fs.readFileSync(path.join(temp,'store.json'),'utf8'));assert.equal(persisted.orders[0].id,orderId);assert.equal(persisted.shops[0].slug,shopSlug);
 r=await api(`/b/${shopSlug}`);assert.equal(r.status,200);assert.match(await (await fetch(base+`/b/${shopSlug}`)).text(),/booking-form/);
});
test('barber invitations, tenant sessions and booking overlap rules',async()=>{
 let r=await api(`/api/admin/orders/${orderId}/invite`,json({},adminCookie));assert.equal(r.status,201);const token=new URL(r.data.inviteUrl,'http://x').searchParams.get('token');
 r=await api('/api/barber/accept-invite',json({token,email:'owner@example.test',password:'barber-passphrase-123'}));assert.equal(r.status,201);barberCookie=r.cookie.split(';')[0];
 r=await api('/api/barber/me',{headers:{cookie:barberCookie}});assert.equal(r.status,200);assert.equal(r.data.shop.config.businessName,'Taller Test');
 const date=nextWeekday();const booking={slug:shopSlug,professionalId:'pro-1',serviceId:'svc-1',date,time:'10:00',name:'Cliente de prueba',contact:'+56987654321'};
 r=await api('/api/public/bookings',json(booking));assert.equal(r.status,201);const bookingId=r.data.id;
 r=await api('/api/public/bookings',json(booking));assert.equal(r.status,409,'overlapping request for one professional is rejected');
 r=await api('/api/public/bookings',json({...booking,professionalId:'pro-2'}));assert.equal(r.status,201,'separate professional calendar remains available');assert.equal(JSON.parse(fs.readFileSync(path.join(temp,'store.json'),'utf8')).bookings.at(-1).price,19000,'professional-specific price is saved');
 r=await api(`/api/public/availability?slug=${shopSlug}&date=${date}&professional=pro-1&service=svc-1`);assert.equal(r.status,200);assert.equal(r.data.availability.find(x=>x.time==='10:00').status,'Solicitado');
 r=await api(`/api/barber/bookings/${bookingId}/accept`,json({},barberCookie));assert.equal(r.status,200);assert.equal(r.data.status,'Confirmada');
 r=await api('/api/booking-status?id='+encodeURIComponent(bookingId)+'&contact='+encodeURIComponent(booking.contact));assert.equal(r.data.status,'Confirmada');
 r=await api('/api/public/bookings/cancel',json({id:bookingId,contact:booking.contact}));assert.equal(r.status,200);assert.equal(r.data.status,'Cancelada');r=await api('/api/public/bookings',json({...booking,name:'Cliente después de cancelación'}));assert.equal(r.status,201,'canceling a confirmed booking releases its slot');
 r=await api('/api/barber/blocks',json({professionalId:'pro-1',date,time:'13:00',duration:60,note:'Almuerzo'},barberCookie));assert.equal(r.status,201);const blockId=r.data.block.id;r=await api(`/api/public/availability?slug=${shopSlug}&date=${date}&professional=pro-1&service=svc-1`);assert.equal(r.data.availability.find(x=>x.time==='13:00').status,'Ocupado');r=await api(`/api/barber/blocks/${blockId}`,{method:'DELETE',headers:{cookie:barberCookie}});assert.equal(r.status,200);
 const rejected={...booking,time:'11:00'};r=await api('/api/public/bookings',json(rejected));assert.equal(r.status,201);const rejectedId=r.data.id;r=await api(`/api/barber/bookings/${rejectedId}/reject`,json({},barberCookie));assert.equal(r.data.status,'Rechazada');r=await api('/api/public/bookings',json({...rejected,name:'Siguiente cliente'}));assert.equal(r.status,201,'rejected booking releases its slot');
 const edited={...config,services:[{name:'Corte actualizado',price:17000,duration:60}],staff:[{...config.staff[0],daysOff:[date]},{...config.staff[1],services:[{id:'svc-1',name:'Corte actualizado',price:19000,duration:30}]}]};r=await api('/api/barber/me',{method:'PUT',headers:{'content-type':'application/json',cookie:barberCookie},body:JSON.stringify({config:edited})});assert.equal(r.status,200);r=await api(`/api/public/shops/${shopSlug}`);assert.equal(r.data.config.services[0].price,17000,'barber price edits update the public page');r=await api(`/api/public/availability?slug=${shopSlug}&date=${date}&professional=pro-1&service=svc-1`);assert.equal(r.data.availability.find(x=>x.time==='10:00').status,'Fuera de horario','professional day off blocks availability');
 const solo={...config,businessName:'Otro Local',plan:'individual',staff:[{name:'Cris',schedule:['Lunes a sábado 10:00-19:00']}]};r=await api('/api/orders',json({plan:'individual',config:solo,buyer}));assert.equal(r.status,201);const secondId=r.data.id;r=await api(`/api/admin/orders/${secondId}/paid`,json({reference:'Verificado'},adminCookie));assert.equal(r.status,200);r=await api(`/api/admin/orders/${secondId}/publish`,json({},adminCookie));assert.equal(r.status,200);const otherSlug=r.data.publicUrl.split('/').at(-1);const otherBooking={...booking,slug:otherSlug,professionalId:'pro-1',serviceId:'svc-1'};r=await api('/api/public/bookings',json(otherBooking));assert.equal(r.status,201);const otherBookingId=r.data.id;r=await api(`/api/barber/bookings/${otherBookingId}/accept`,json({},barberCookie));assert.equal(r.status,404,'a barber cannot act on another shop\'s booking');r=await api('/api/barber/me',{headers:{cookie:barberCookie}});assert.equal(r.data.bookings.some(x=>x.id===otherBookingId),false,'private booking lists are tenant-scoped');
 r=await api('/api/barber/me');assert.equal(r.status,401,'barber panel requires session');
});




