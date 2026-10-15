#!/usr/bin/env node
// Isolated real HTTP + Chromium acceptance for the ag dash Audio tab and the
// generated audio player. Requires ffmpeg and Playwright (PLAYWRIGHT_MODULE /
// optional PLAYWRIGHT_CHROMIUM executable). Never touches live fleet data or
// plays through the operator's speakers (headless Chromium uses a fake sink).
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,mkdir,rm,stat} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const repo=path.resolve(import.meta.dirname,'..');
const root=await mkdtemp(path.join(os.tmpdir(),'ag-audio-browser-'));
const out=path.resolve(process.env.AG_AUDIO_QA_OUT||await mkdtemp(path.join(os.tmpdir(),'ag-audio-dash-evidence-')));await mkdir(out,{recursive:true});
let server,browser;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,ms=15000){const end=Date.now()+ms;while(!await fn()){assert.ok(Date.now()<end,'condition timed out');await sleep(100)}}
const clips=[
  ['chirp-agent','Bossa riff in E minor (take 3)','A short bossa nova riff rendered with chirp; nylon guitar, brushes.','mp3','audio/mpeg',18,'sine=frequency=220:duration=18'],
  ['chirp-agent','Rain loop','Seamless 12 s ambience loop for the timer screen.','ogg','audio/ogg',12,'anoisesrc=d=12:c=pink:a=0.05'],
  ['ui-agent','Notification chime',null,'wav','audio/wav',1.2,'sine=frequency=880:duration=1.2'],
  ['ui-agent','Error buzz (rejected)','Candidate sound for failed validation.','flac','audio/flac',0.8,'sine=frequency=110:duration=0.8'],
  ['codec-agent','Sample: 8 kHz phone band','Before/after comparison for the codec bug.','wav','audio/wav',6,'sine=frequency=400:duration=6'],
  ['codec-agent','Legacy AIFF export',null,'aiff','audio/aiff',3,'sine=frequency=330:duration=3'],
];
try{
  const archive=path.join(root,'archive');
  for(const [i,[agent,title,description,ext,mime,seconds,source]] of clips.entries()){
    await mkdir(path.join(archive,agent),{recursive:true});
    const file=path.join(archive,agent,`aud-${String(i).padStart(64,'0')}.${ext}`);
    execFileSync('ffmpeg',['-loglevel','error','-y','-f','lavfi','-i',source,'-ac','2','-ar','44100',file]);
    const bytes=await readFile(file);
    const id=`${agent}/${path.basename(file)}`;
    await writeFile(file+'.json',JSON.stringify({version:1,id,sha256:createHash('sha256').update(bytes).digest('hex'),mimeType:mime,bytes:bytes.length,timestamp:`2026-10-14T0${i}:12:00.000Z`,agent,session:'fixture',host:'fixture',source:{kind:'tool',tool:'audio_share',label:path.basename(file)},title,...(description?{description}:{}),durationMs:Math.round(seconds*1000)}));
  }
  const ssh=path.join(root,'ssh');await writeFile(ssh,"#!/bin/sh\necho 'Connection refused' >&2\nexit 255\n",{mode:0o700});
  await writeFile(path.join(root,'config.json'),JSON.stringify({hosts:[{name:'helsinki',local:true,paths:{audio_dir:archive}},{name:'astra',address:'fixture-offline'}],ssh_command:ssh,paratenic:{enabled:false},paths:{tts_feed:path.join(root,'speech.jsonl'),tts_mute:path.join(root,'mute.json')}}));
  server=spawn(process.env.AG_TEST_BIN||path.join(repo,'ag/target/debug/ag'),['--json','--config',path.join(root,'config.json'),'dash','--no-images','--no-tts','--no-open','--bind','127.0.0.1:0'],{env:{PATH:process.env.PATH,HOME:root,XDG_STATE_HOME:path.join(root,'state'),XDG_CONFIG_HOME:path.join(root,'config'),XDG_CACHE_HOME:path.join(root,'cache')},stdio:['ignore','pipe','pipe']});
  let stdout='',errors='';server.stdout.on('data',v=>stdout+=v);server.stderr.on('data',v=>errors=(errors+v).slice(-4000));
  await until(()=>stdout.includes('\n'));
  const ready=JSON.parse(stdout.split('\n')[0]).data,url=new URL(ready.url),origin=url.origin;
  const cookie=`ag_dash_${url.port}=${url.searchParams.get('token')}`;
  const state=async()=>(await fetch(origin+'/api/state',{headers:{cookie}})).json();
  await until(async()=>(await state()).audio.available===true);
  const first=await state();
  assert.equal(first.audio.clips,clips.length);
  assert.equal(first.audio.hosts.find(h=>h.host==='astra').state,'unavailable');
  browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required'],...(process.env.PLAYWRIGHT_CHROMIUM?{executablePath:process.env.PLAYWRIGHT_CHROMIUM}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:900},timezoneId:'UTC'}),page=await context.newPage();
  const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
  const ranged=[];page.on('request',request=>{if(request.url().includes('/audio/hosts/')&&request.headers().range)ranged.push(request.headers().range)});
  await page.goto(ready.url);
  await page.getByRole('tab',{name:/^Audio/}).click();
  assert.equal(await page.locator('#b-audio').textContent(),String(clips.length));
  const frame=page.frameLocator('#audframe iframe');
  await frame.locator('.clip').nth(clips.length-1).waitFor();
  assert.match(await page.locator('#audstatus').textContent(),/6 clips · 0:41 · pulled/);
  // Newest first; the AIFF row explains it cannot play in Chromium.
  assert.equal(await frame.locator('.clip .title').first().textContent(),'Legacy AIFF export');
  assert.match(await frame.locator('.clip').first().textContent(),/cannot play audio\/aiff/);
  await page.screenshot({path:path.join(out,'audio-dark-1440x900.png')});
  // Play the bossa riff, then seek (exercises HTTP Range).
  await frame.getByText('Bossa riff in E minor (take 3)').click();
  const player=frame.locator('#player');
  await until(async()=>await player.evaluate(p=>!p.paused&&p.currentTime>0.3),10000);
  await player.evaluate(p=>{p.currentTime=9});
  await until(async()=>await player.evaluate(p=>p.currentTime>=9&&!p.paused),10000);
  assert.ok(ranged.length>0,'media requests used Range');
  assert.equal(await frame.locator('#np-title').textContent(),'Bossa riff in E minor (take 3)');
  await page.screenshot({path:path.join(out,'audio-playing-dark-1440x900.png')});
  // A background sync while playing must not reload the player.
  const before=(await state()).audio.finished_ms;
  await fetch(origin+'/api/refresh',{method:'POST',headers:{cookie,'x-ag-dash':'1','content-type':'application/json'},body:JSON.stringify({what:['audio']})});
  await until(async()=>(await state()).audio.finished_ms>before);
  await until(async()=>!(await page.locator('#audreload').isHidden()),8000);
  assert.equal(await player.evaluate(p=>!p.paused),true,'still playing after sync');
  await page.locator('#audreload').click();
  await until(async()=>await page.locator('#audreload').isHidden());
  // Keyboard: j/k select, Space plays, n advances; filters narrow by agent.
  await frame.locator('#list').focus();
  await page.keyboard.press('j');await page.keyboard.press('Space');
  await until(async()=>await frame.locator('#player').evaluate(p=>!p.paused));
  await frame.locator('#player').evaluate(p=>p.pause());
  await frame.locator('#agent').selectOption('ui-agent');
  assert.equal(await frame.locator('.clip').count(),2);
  await frame.locator('#agent').selectOption('');
  await frame.locator('#search').fill('rain');
  assert.equal(await frame.locator('.clip').count(),1);
  await frame.locator('#search').fill('');
  await frame.locator('#theme').click();await page.locator('#theme').click();
  await page.screenshot({path:path.join(out,'audio-light-1440x900.png')});
  for(const [width,height] of [[390,844],[320,600]]){
    await page.setViewportSize({width,height});
    await sleep(200);
    await page.screenshot({path:path.join(out,`audio-light-${width}x${height}.png`)});
    if(process.env.AG_AUDIO_QA_DEBUG)console.error(JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+0.5).slice(0,12).map(e=>[e.tagName,e.id,e.className,Math.round(e.getBoundingClientRect().width)]))));
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
    assert.equal(overflow,false,`no horizontal overflow at ${width}`);
    const inner=await frame.locator('body').evaluate(b=>b.scrollWidth>b.clientWidth+1);
    assert.equal(inner,false,`player fits at ${width}`);
  }
  assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({ok:true,out,ranged:ranged.slice(0,3),clips:clips.length}));
}finally{
  await browser?.close();
  if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r))}
  await rm(root,{recursive:true,force:true});
}
