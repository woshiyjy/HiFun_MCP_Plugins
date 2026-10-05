import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createRemote, validateEndpoint } from '../src/connection.mjs';
import { createDiagnoser, readImage } from '../src/diagnosis.mjs';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXmQAAAAASUVORK5CYII=', 'base64');
const uri = 'skill://hifun/image-diagnosis/SKILL.md';
test('only pinned HTTPS and loopback MCP endpoints are accepted', () => {
  for (const value of ['https://www.wehifun.cn/shared-mcp','http://127.0.0.1:45678/mcp']) assert.ok(validateEndpoint(value));
  for (const value of ['https://evil.example/mcp','http://www.wehifun.cn/shared-mcp','https://www.wehifun.cn/shared-mcp?token=bad','https://u:p@www.wehifun.cn/shared-mcp']) assert.throws(() => validateEndpoint(value));
});
test('file boundaries reject hidden files, outside files, disguised types and symlink escapes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hifun-bridge-images-'));
  try {
    const allowed = path.join(root, 'allowed'); await mkdir(allowed);
    await writeFile(path.join(allowed,'image.png'),pixel);
    assert.equal((await readImage(path.join(allowed,'image.png'),[allowed])).mime,'image/png');
    await writeFile(path.join(root,'outside.png'),pixel);
    await symlink(path.join(root,'outside.png'),path.join(allowed,'escape.png'));
    await writeFile(path.join(allowed,'.secret.png'),pixel);
    await writeFile(path.join(allowed,'disguised.png'),'not a PNG');
    await writeFile(path.join(allowed,'large.png'),Buffer.alloc(8*1024*1024+1));
    for (const name of [path.join(root,'outside.png'),path.join(allowed,'escape.png'),path.join(allowed,'.secret.png'),path.join(allowed,'disguised.png'),path.join(allowed,'large.png'),'https://example.com/image.png']) {
      await assert.rejects(readImage(name,[allowed]));
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('unknown outcomes and concurrent bridges cannot repeat a charged request', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'hifun-bridge-once-'));
  try {
    const file=path.join(root,'image.png'); await writeFile(file,pixel);
    const config={token:'t'.repeat(48),allowedRoots:[root]};
    let calls=0;
    const remote={getSkill:async()=>'',diagnose:async()=>{calls++; await new Promise(r=>setTimeout(r,30)); throw new Error('unknown');}};
    const a=createDiagnoser(config,remote,path.join(root,'ledger')),b=createDiagnoser(config,remote,path.join(root,'ledger'));
    const outcomes=await Promise.allSettled([a(file),b(file)]);
    assert.ok(outcomes.every(item=>item.status==='rejected')); assert.equal(calls,1);
    await assert.rejects(a(file),/DIAGNOSIS_UNKNOWN/); assert.equal(calls,1);
  } finally {await rm(root,{recursive:true,force:true});}
});
test('real HTTP MCP transport validates Skills and submits bytes once with explicit provenance', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'hifun-bridge-wire-'));
  const source=await readFile(new URL('../skills/image-diagnosis/server-SKILL.md',import.meta.url));
  const digest='sha256:'+createHash('sha256').update(source).digest('hex');
  const entry={uri,resources:[{uri,digest,size:source.length}]};
  let calls=0,received;
  const server=createServer(async(req,res)=>{
    if(req.headers.authorization!=='Bearer '+'t'.repeat(48)){res.writeHead(401);res.end();return;}
    if(req.method!=='POST'){res.writeHead(405);res.end();return;}
    let body='';for await(const chunk of req)body+=chunk;
    const packet=JSON.parse(body);
    if(packet.id===undefined){res.writeHead(202);res.end();return;}
    let result;
    if(packet.method==='initialize')result={protocolVersion:packet.params.protocolVersion,capabilities:{tools:{},resources:{},extensions:{'io.modelcontextprotocol/skills':{}}},serverInfo:{name:'hifun-shared-capabilities',version:'test'}};
    else if(packet.method==='tools/list')result={tools:[{name:'diagnose_image',inputSchema:{type:'object',properties:{request_id:{type:'string'},image_base64:{type:'string'},mime_type:{type:'string'}}}}]};
    else if(packet.method==='skills/list')result={resultType:'complete',skills:[entry],ttlMs:300000};
    else if(packet.method==='skills/get')result={resultType:'complete',skill:entry,ttlMs:300000};
    else if(packet.method==='resources/read')result={contents:[{uri,mimeType:'text/markdown',text:source.toString()}]};
    else if(packet.method==='tools/call'){calls++;received=packet.params.arguments;result={content:[{type:'text',text:'mock scope'}],structuredContent:{route:'standard',demo:true}};}
    else throw new Error('unexpected method');
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:packet.id,result}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={url:`http://127.0.0.1:${server.address().port}/mcp`,token:'t'.repeat(48),allowedRoots:[root]};
  try {
    await assert.rejects(createRemote(config,{expectedDigest:'sha256:'+'0'.repeat(64)}).getSkill(),/SKILL_VERSION/);
    const remote=createRemote(config,{expectedDigest:digest});
    assert.equal(await remote.getSkill(),source.toString());
    const configDir=path.join(root,'config');await mkdir(configDir,{mode:0o700});
    await writeFile(path.join(configDir,'connection.json'),JSON.stringify(config),{mode:0o600});
    const standalone=path.join(root,'standalone.mjs');await writeFile(standalone,await readFile('bundle/bridge.mjs'));
    const checked=await promisify(execFile)(process.execPath,[standalone,'--check'],{cwd:root,env:{...process.env,HIFUN_MCP_CONFIG_DIR:configDir}});
    assert.equal(JSON.parse(checked.stdout).skillVerified,true); assert.equal(JSON.parse(checked.stdout).diagnosisSubmitted,false);
    const file=path.join(root,'image.png'); await writeFile(file,pixel);
    const diagnose=createDiagnoser(config,remote,path.join(root,'ledger'));
    const first=await diagnose(file),replay=await diagnose(file);
    assert.equal(calls,1); assert.equal(first.source.transport,'MCP'); assert.equal(first.source.cached,false); assert.equal(replay.source.cached,true);
    assert.deepEqual(Buffer.from(received.image_base64,'base64'),pixel); assert.match(received.request_id,/^[a-f0-9-]{36}$/);
    assert.equal(JSON.stringify(first).includes(received.image_base64),false); assert.equal(JSON.stringify(first).includes(config.token),false);
  } finally {await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
});
test('bundled stdio artifact is discoverable without node_modules and has no image byte argument', async()=>{
  const client=new Client({name:'distribution-test',version:'0.1.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('bundle/bridge.mjs')],stderr:'pipe'});
  let errors='';transport.stderr?.on('data',chunk=>errors+=chunk);
  try {
    await client.connect(transport);
    const tools=await client.listTools();assert.deepEqual(tools.tools.map(t=>t.name),['diagnose_image']);
    assert.deepEqual(Object.keys(tools.tools[0].inputSchema.properties),['image_path']);
    const resources=await client.listResources();assert.equal(resources.resources[0].uri,uri);
    assert.equal(errors,'');
  }finally{await client.close();}
});
