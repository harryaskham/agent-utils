import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// A real shell/process peer with a separate HOME, but no network/auth. The shim
// deliberately rejects receive/probe: pull must never push back from its source.
export async function installSourcePeer({ binDir, sourceHome, env, log, loseAction, marker }) {
  await mkdir(binDir, { recursive: true });
  const path = join(binDir, 'ssh');
  await writeFile(path, `#!${process.execPath}
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const args=process.argv.slice(2);
if(!args.includes('BatchMode=yes')||!args.includes('source-host'))process.exit(98);
const input=fs.readFileSync(0);const request=JSON.parse(input);
if(!['inspect','snapshot','objects'].includes(request.action))process.exit(97);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({action:request.action,id:request.id,sessionId:request.sessionId})+'\\n');
const r=spawnSync('sh',['-c',args.at(-1)],{cwd:${JSON.stringify(sourceHome)},input,env:{...process.env,HOME:${JSON.stringify(sourceHome)},PI_CODING_AGENT_DIR:${JSON.stringify(join(sourceHome, '.pi/agent'))}},timeout:125000,maxBuffer:300*1024*1024});
if(request.action===${JSON.stringify(loseAction || '')}&&${JSON.stringify(marker || '')}&&fs.existsSync(${JSON.stringify(marker || '')})&&r.status===0&&JSON.parse(r.stdout).ok){fs.unlinkSync(${JSON.stringify(marker || '')});process.stderr.write('lost source response after snapshot/object commit');process.exit(255);}
process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||r.error?.message||'');process.exitCode=r.status??1;
`);
  await chmod(path, 0o700);
  env.PATH = `${binDir}:${env.PATH}`;
  return path;
}
