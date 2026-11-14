// Playwright: локально (npm i playwright) или путь к index.mjs в переменной PLAYWRIGHT
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
import http from 'http'; import fs from 'fs'; import path from 'path';
const HERE=path.dirname(new URL(import.meta.url).pathname);
const ROOT=path.resolve(HERE,'../../src'), T=process.env.SMOKE_OUT||path.join(HERE,'out');   // T: фикстуры (make-fixtures.py) и скриншоты
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
const srv=http.createServer((q,r)=>{let p=decodeURIComponent(q.url.split('?')[0]); if(p==='/')p='/index.html'; const f=path.join(ROOT,p); if(!fs.existsSync(f)){r.writeHead(404);return r.end();} r.writeHead(200,{'content-type':types[path.extname(f)]||'application/octet-stream'}); r.end(fs.readFileSync(f));}).listen(8791);
const br=await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const ctx=await br.newContext({viewport:{width:1360,height:860}}); const page=await ctx.newPage();
const errs=[]; page.on('pageerror',e=>errs.push('PAGEERR '+e.message)); page.on('console',m=>{if(m.type()==='error')errs.push('CONSOLE '+m.text())});
await page.route('https://raw.githubusercontent.com/**',async route=>{const u=decodeURIComponent(route.request().url()); const h={'access-control-allow-origin':'*'};
  if(u.endsWith('.png')) return route.fulfill({body:fs.readFileSync(T+(u.includes('sponsors')?'/sponsors.png':'/decals.png')),contentType:'image/png',headers:h});
  if(u.endsWith('.obj')) return route.fulfill({body:fs.readFileSync(T+'/model.obj'),contentType:'text/plain',headers:h});
  if(u.endsWith('.json')) return route.fulfill({body:JSON.stringify({baseRoughness:0.2,metallic:0.6}),contentType:'application/json',headers:h});
  route.fulfill({status:404});});
await page.addInitScript(()=>{ try{localStorage.setItem('isAdmin','true');localStorage.setItem('workerUrl','"https://w.example.dev"');localStorage.setItem('ghToken','"ghp_x"');localStorage.setItem('ghLogin','"tester"');}catch{}
  const mk=(id,team,name,n,car)=>({id,team,name,files:[{name:'decals.png',path:id+'/decals.png',sha:'d'+name,size:1},{name:'sponsors.png',path:id+'/sponsors.png',sha:'s'+name,size:1},{name:'decals.json',path:id+'/decals.json',sha:'j'+name,size:1}],junkCount:2,junkPaths:[],sig:'sig'+name,carFile:null,meta:{carModelType:car,raceNumber:n,customSkinName:name}});
  const data={commit:'abc',owner:'kirillkoltun0-ops',repo:'dobeg-liveries',truncated:false,
   liveries:[mk('Dobeg Racing/Alpha','Dobeg Racing','Alpha',77,35),mk('Dobeg Racing/Beta','Dobeg Racing','Бета',5,32),mk('Team X/Gamma','Team X','Gamma',12,34),mk('Solo','','Solo',9,30)],
   models:[{name:'McLaren 720S GT3 Evo.obj',path:'models/McLaren 720S GT3 Evo.obj',sha:'m1',size:1},{name:'Ferrari 296 GT3.obj',path:'models/Ferrari 296 GT3.obj',sha:'m2',size:1},{name:'Porsche 992 GT3 R.obj',path:'models/Porsche 992 GT3 R.obj',sha:'m3',size:1}]};
  const inst={}; window.__calls=[];
  window.__TAURI__={core:{invoke:async(c,a)=>{window.__calls.push([c,a&&Object.keys(a)]);
    switch(c){case 'default_customs_path':return 'C:/Docs/ACC/Customs';case 'ensure_customs':return {existed:true};case 'installed_state':return {...inst};
    case 'sync_remote':await new Promise(r=>setTimeout(r,300));return data;
    case 'install_livery':inst[a.livery.id]={folder:a.livery.name,carFile:null,sig:a.livery.sig,installedAt:1};return inst[a.livery.id];
    case 'uninstall_livery':delete inst[a.id];return;case 'uninstall_all':Object.keys(inst).forEach(k=>delete inst[k]);return 0;
    case 'github_put_file':(window.__puts??=[]).push(a.path);return 'sha';case 'github_check_token':return {login:'tester',canPush:true};case 'open_folder':return;
    case 'fetch_b64':throw 'no';default:throw 'unknown '+c;}}},event:{listen:async()=>()=>{}},dialog:{open:async()=>null}};
});
await page.goto('http://localhost:8791/');
await page.waitForSelector('.card',{timeout:10000});
await page.waitForTimeout(1500); await page.screenshot({path:T+'/1-library.png'});
console.log('cards:',await page.locator('.card').count(), 'installed after autoinstall:', await page.textContent('#stInst'));
// фильтр
await page.fill('#q','#77'); await page.waitForTimeout(300); console.log('search #77 ->',await page.locator('.card').count()); await page.fill('#q','');await page.waitForTimeout(300);
await page.click('[data-team="Team X"]'); await page.waitForTimeout(300); console.log('team filter ->',await page.locator('.card').count()); await page.click('[data-team="all"]');
// шоурум
await page.waitForTimeout(300); await page.locator('.card').first().locator('.thumb').click(); 
await page.waitForFunction(()=>document.querySelector('#shLoader').hidden,{timeout:20000}); await page.waitForTimeout(1800);
await page.screenshot({path:T+'/2-showroom.png'}); /*wheels-shot*/
console.log('preview img on card:',await page.locator('.card .thumb img').count());
await page.click('#shFlip'); await page.click('#shShot'); await page.waitForTimeout(500);
await page.keyboard.press('Escape'); await page.waitForTimeout(500);
await page.screenshot({path:T+'/3-library-previews.png'});
// настройки + темы
await page.click('#btnSettings'); await page.waitForTimeout(500);
await page.screenshot({path:T+'/5-settings.png'});
await page.click('.theme[data-id="cyber"]'); await page.waitForTimeout(1400);
console.log('theme attr:',await page.evaluate(()=>document.documentElement.dataset.theme));
await page.click('.theme[data-id="synth"]'); await page.waitForTimeout(1400);
await page.screenshot({path:T+'/6-settings-synth.png'});
await page.click('.set-nav [data-pane="sync"]'); await page.waitForTimeout(300); await page.screenshot({path:T+'/7-sync.png'});
await page.selectOption('[data-cfg="syncMin"]','5');
console.log('cfg saved:',await page.evaluate(()=>JSON.parse(localStorage.getItem('cfg')).syncMin));
await page.click('.theme[data-id="frost"]',{force:true}).catch(()=>{}); await page.click('.set-nav [data-pane="look"]'); await page.click('.theme[data-id="frost"]'); await page.waitForTimeout(1400);
await page.screenshot({path:T+'/8-frost.png'});
await page.click('.set-nav [data-close]'); await page.waitForTimeout(500);
await page.screenshot({path:T+'/9-frost-library.png'});
await page.evaluate(()=>{ const r=document.documentElement; r.dataset.theme='dobeg'; });
// админ (локальные токен/роль заданы init-скриптом)
console.log('role:',await page.textContent('#roleName'));
if(!(await page.isVisible('#view-admin'))) await page.click('#tab-admin');
await page.waitForTimeout(400);
await page.setInputFiles('#dirInput',T+'/skin'); await page.waitForFunction(()=>window.__puts&&window.__puts.length>=4,{timeout:40000}).catch(()=>{}); await page.waitForTimeout(500);
const puts=await page.evaluate(()=>window.__calls.filter(c=>c[0]==='github_put_file').length);
const paths=await page.evaluate(()=>window.__puts);
console.log('auto-publish put calls:',puts, paths);
await page.screenshot({path:T+'/10-admin-auto.png',fullPage:true});
console.log('token title:',await page.textContent('#tokenTitle'),'|',await page.textContent('#tokenOkText'));
console.log('sync args:',JSON.stringify(await page.evaluate(()=>window.__calls.find(c=>c[0]==='sync_remote'))));
const before=await page.evaluate(()=>window.__puts.length);
await page.setInputFiles('#modelInput',T+'/model.obj'); await page.waitForTimeout(1500);
console.log('model put:',JSON.stringify(await page.evaluate((b)=>window.__puts.slice(b),before)), 'model args:', JSON.stringify(await page.evaluate(()=>window.__calls.filter(c=>c[0]==='github_put_file').at(-1)[1])));
await page.click('#profile'); await page.click('#cfYes'); await page.waitForTimeout(400);
console.log('after logout:',await page.textContent('#roleName'), 'admin tab hidden:',await page.isHidden('#tab-admin'));
await page.click('#profile'); await page.fill('#loginUser','Кирилл'); await page.fill('#loginPass','secret'); await page.press('#loginPass','Enter'); await page.waitForTimeout(600);
console.log('after login:',await page.textContent('#roleName'),'admin view visible:',await page.isVisible('#view-admin'));
console.log('ERRORS:',errs.length?errs:'none');
await br.close(); srv.close();
