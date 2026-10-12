#!/usr/bin/env node
// Isolated real HTTP + Chromium acceptance. Requires Playwright (or
// PLAYWRIGHT_MODULE / NODE_PATH pointing at the configured playwright-cli dep).
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,appendFile,mkdir,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const repo=path.resolve(import.meta.dirname,'..');
const root=await mkdtemp(path.join(os.tmpdir(),'ag-tts-browser-'));
const out=path.resolve(process.env.AG_TTS_QA_OUT||await mkdtemp(path.join(os.tmpdir(),'ag-tts-dash-evidence-')));await mkdir(out,{recursive:true});
let server,browser,exit;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,ms=8000){const end=Date.now()+ms;while(!await fn()){assert.ok(Date.now()<end,'condition timed out');await sleep(50)}}
const record=(text,host,i=0)=>JSON.stringify({timestamp:`2026-10-07T08:${String(10+Math.floor(i/60)).padStart(2,'0')}:${String(i%60).padStart(2,'0')}Z`,kind:['tts','narrate','read','choices'][i%4],agent:i%2?'render-agent':'codec-agent',session:'fixture-session',cwd:'/work/agent-utils',text})+'\n';
try{
  const names=['helsinki','ms-dev'];
  const hosts=[];
  const phrases=['The preview lifecycle fix is ready. Pending callbacks are cancelled before the old context is invalidated.',
    'Checking the dashboard service and the shared speech stream. One collector is running for the fleet.',
    'The incoming transcript is rendered as plain text. Metadata stays above the message, with a quiet separator between entries.',
    'Choose the next test target: desktop, compact window, or phone. The backend continues while this view is paused.'];
  for(const name of names){const file=path.join(root,name+'.jsonl');await writeFile(file,Array.from({length:18},(_,i)=>record(phrases[i%4],name,i)).join(''));hosts.push({name,local:true,paths:{tts_feed:file}})}
  const ssh=path.join(root,'ssh');await writeFile(ssh,"#!/bin/sh\necho 'Connection refused' >&2\nexit 255\n",{mode:0o700});
  hosts.push({name:'astra',address:'fixture-offline'});
  await writeFile(path.join(root,'config.json'),JSON.stringify({hosts,ssh_command:ssh,paratenic:{enabled:false},poll_ms:100,paths:{tts_mute:path.join(root,'mute.json'),image_dir:path.join(root,'images')}}));
  server=spawn(process.env.AG_TEST_BIN||path.join(repo,'ag/target/debug/ag'),['--json','--config',path.join(root,'config.json'),'dash','--no-images','--no-open','--bind','127.0.0.1:0'],{env:{PATH:process.env.PATH,HOME:root,XDG_STATE_HOME:path.join(root,'state'),XDG_CONFIG_HOME:path.join(root,'config'),XDG_CACHE_HOME:path.join(root,'cache')},stdio:['ignore','pipe','pipe']});
  exit=new Promise((resolve,reject)=>{server.once('exit',resolve);server.once('error',reject)});exit.catch(()=>{});
  let stdout='',errors='';server.stdout.on('data',v=>stdout+=v);server.stderr.on('data',v=>errors=(errors+v).slice(-4000));
  await until(()=>stdout.includes('\n'));
  const ready=JSON.parse(stdout.split('\n')[0]).data,url=new URL(ready.url),origin=url.origin;
  const cookie=`ag_dash_${url.port}=${url.searchParams.get('token')}`;
  const snapshot=async()=>{const r=await fetch(origin+'/api/tts',{headers:{cookie}});return r.json()};
  await until(async()=> (await snapshot()).received_speech===36);
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:900},timezoneId:'UTC'}),page=await context.newPage();
  const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
  await page.goto(ready.url);assert.equal(page.url(),origin+'/');
  await page.getByRole('tab',{name:/^TTS/}).click();
  await page.locator('.speech').nth(35).waitFor();
  await until(async()=> (await snapshot()).subscribers===1);
  // Render without timestamps from the operator, account data or real agents.
  await page.screenshot({path:path.join(out,'tts-dark-1440x900.png')});
  await page.locator('#tts-host').selectOption('ms-dev');assert.equal(await page.locator('.speech').count(),18);
  await page.locator('#tts-kind').selectOption('choices');assert.equal(await page.locator('.speech').count(),4);
  await page.locator('#tts-search').fill('no fixture matches');assert.equal(await page.locator('.speech').count(),0);
  await page.locator('#tts-search').fill('');await page.locator('#tts-kind').selectOption('');await page.locator('#tts-host').selectOption('');
  await page.locator('#tts-log').evaluate(e=>{e.scrollTop=0});
  await until(async()=>await page.locator('#tts-follow').getAttribute('aria-pressed')==='false');
  const before=await page.locator('#tts-log').textContent();
  await appendFile(path.join(root,'helsinki.jsonl'),record('Arrived while reading older entries.','helsinki',30));
  await until(async()=> (await page.locator('#tts-follow').textContent()).includes('new'));
  assert.equal(await page.locator('#tts-log').textContent(),before,'paused content moved');
  await page.setViewportSize({width:1440,height:600});
  await page.screenshot({path:path.join(out,'tts-paused-dark-1440x600.png')});
  await page.setViewportSize({width:1440,height:900});
  await page.locator('#tts-follow').click();await page.getByText('Arrived while reading older entries.',{exact:true}).waitFor();
  // Never parse speech as HTML, markdown or executable controls.
  const hostile='<img src=x onerror="window.pwned=1"> <script>window.pwned=1</script>';
  await appendFile(path.join(root,'helsinki.jsonl'),record(hostile,'helsinki',31));await page.getByText(hostile,{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.pwned),undefined);assert.equal(await page.locator('#tts-log img,#tts-log script').count(),0);
  // Leave the tab: unsubscribe, but collection continues. Return replays once.
  await page.getByRole('tab',{name:/^Health/}).click();await until(async()=> (await snapshot()).subscribers===0);
  await appendFile(path.join(root,'ms-dev.jsonl'),record('Collected with no TTS view open.','ms-dev',32));await until(async()=> (await snapshot()).received_speech===39);
  await page.getByRole('tab',{name:/^TTS/}).click();await page.getByText('Collected with no TTS view open.',{exact:true}).waitFor();assert.equal(await page.getByText('Collected with no TTS view open.',{exact:true}).count(),1);
  await context.setOffline(true);await until(async()=> (await page.locator('#tts-connection').textContent()).includes('Reconnecting'));
  await appendFile(path.join(root,'helsinki.jsonl'),record('Reconnected without a second collector.','helsinki',33));
  await context.setOffline(false);await page.getByText('Reconnected without a second collector.',{exact:true}).waitFor({timeout:15000});
  // Real event-to-visible timing distribution, not a mocked UI event.
  const timings=[];for(let i=0;i<12;i++){const text=`Latency sample ${i}`,start=performance.now();await appendFile(path.join(root,'helsinki.jsonl'),record(text,'helsinki',40+i));await page.getByText(text,{exact:true}).waitFor();timings.push(performance.now()-start)}
  timings.sort((a,b)=>a-b);assert.ok(timings.at(-1)<1500);
  await page.locator('#tts-search').fill('preview lifecycle');
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Switch color theme'}).click();
  await page.screenshot({path:path.join(out,'tts-light-390x844.png')});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow');
  await page.setViewportSize({width:320,height:480});await page.locator('#tts-search').fill('');
  await page.screenshot({path:path.join(out,'tts-light-320x480.png')});
  const overflow=await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>({id:e.id,tag:e.tagName,right:e.getBoundingClientRect().right})).slice(0,12));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'compact horizontal overflow: '+JSON.stringify(overflow));
  await page.setViewportSize({width:1440,height:420});
  await page.locator('#tab-tts').focus();await page.keyboard.press('ArrowRight');assert.equal(await page.locator('#tab-images').getAttribute('aria-selected'),'true');
  await page.keyboard.press('ArrowLeft');assert.equal(await page.locator('#tab-tts').getAttribute('aria-selected'),'true');
  await page.locator('#tts-follow').click();await page.screenshot({path:path.join(out,'tts-light-1440x420.png')});
  await context.clearCookies();await page.getByText('Session expired',{exact:true}).waitFor({timeout:8000});
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.keyboard.press('r');
  await until(async()=> (await snapshot()).subscribers===0);
  assert.deepEqual(pageErrors,[]);
  server.kill('SIGTERM');let shutdownTimer;
  try{await Promise.race([exit,new Promise((_,reject)=>{shutdownTimer=setTimeout(()=>reject(new Error('dash shutdown timed out')),5000)})])}finally{clearTimeout(shutdownTimer)}
  await assert.rejects(fetch(origin+'/api/tts'));
  await writeFile(path.join(out,'receipt.json'),JSON.stringify({ok:true,source:'isolated ag + Chromium',timing_ms:{samples:timings.length,p50:timings[5],p95:timings.at(-1)},pageErrors,cleanExit:server.exitCode===0,states:['dark','light','390x844','320x480','1440x420','filtered','paused','offline-reconnect','tab-reconnect','keyboard','hostile-text','auth-expired']},null,2));
  console.log(JSON.stringify({ok:true,evidence:out,p95_ms:timings.at(-1)}));
}finally{
  await browser?.close();if(server&&server.exitCode===null){server.kill('SIGKILL');await exit.catch(()=>{})}
  if(!out.startsWith(root+path.sep))await rm(root,{recursive:true,force:true});
}
