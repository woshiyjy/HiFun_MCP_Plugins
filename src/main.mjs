import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { readFile, mkdir, writeFile, rename, chmod, realpath, copyFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { loadConfig, configDir, configPath, defaultEndpoint, validateEndpoint, createRemote, skillUri } from './connection.mjs';
import { createDiagnoser, readImage } from './diagnosis.mjs';

// Generated at build time from the public server Skill; an upstream change invalidates this release.
const sourceDigest = __SKILL_DIGEST__;
const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function saveConfig(config) {
  validateEndpoint(config.url);
  if (!/^[A-Za-z0-9._~-]{32,128}$/.test(config.token) || !config.allowedRoots?.length) throw new Error('配置无效。');
  const roots = await Promise.all(config.allowedRoots.map(root => realpath(root)));
  if (roots.some(root => root === path.parse(root).root || root === homedir())) throw new Error('请选择专用图片目录，不要开放整个磁盘或用户主目录。');
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await chmod(configDir(), 0o700);
  const temp = configPath() + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify({ url: config.url, token: config.token, allowedRoots: roots }), { mode: 0o600 });
  await rename(temp, configPath());
}

async function maskedToken(prompt) {
  if (!process.stdin.isTTY) throw new Error('请在交互终端中配置凭证。');
  process.stdout.write(prompt);
  process.stdin.setRawMode(true); process.stdin.resume();
  try {
    return await new Promise((resolve, reject) => {
      let value = '';
      const onData = data => {
        for (const char of data.toString()) {
          if (char === '\u0003') { process.stdin.off('data', onData); reject(new Error('配置已取消。')); return; }
          if (char === '\r' || char === '\n') { process.stdin.off('data', onData); resolve(value); return; }
          if (char === '\u007f' || char === '\b') value = value.slice(0,-1);
          else if (/^[A-Za-z0-9._~-]$/.test(char)) value += char;
        }
      };
      process.stdin.on('data', onData);
    });
  } finally { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); }
}

async function configure() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let url, root;
  try {
    url = (await rl.question(`MCP 地址 [${defaultEndpoint}]: `)).trim() || defaultEndpoint;
    root = (await rl.question('允许诊断的图片目录（绝对路径）: ')).trim();
  } finally { rl.close(); }
  const token = await maskedToken('调用凭证（输入不显示）: ');
  await saveConfig({ url, token, allowedRoots: [root] });
  console.log('连接配置已保存；凭证不会写入插件或聊天。运行 --check 验证连接。');
}

async function installPi() {
  const dir = path.join(homedir(), '.pi', 'agent');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const destination = path.join(dir, 'mcp.json');
  let settings = {};
  try { settings = JSON.parse(await readFile(destination, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Pi MCP 配置不能安全合并，请在 Pi Web 的 MCP 设置中导入本仓库 examples/pi-mcp.json。'); }
  if (settings.mcpServers?.hifun_mcp || settings.mcpServers?.hifun_diagnosis) throw new Error('Pi 已有嗨番 MCP 配置；未覆盖，请按 README 的旧版升级说明核对。');
  const skillDir = path.join(dir, 'skills', 'hifun-image-diagnosis');
  await mkdir(skillDir, { recursive: true });
  await copyFile(path.join(pluginRoot, 'skills', 'image-diagnosis', 'SKILL.md'), path.join(skillDir, 'SKILL.md'), 1);
  const config = { command: process.execPath, args: [path.join(pluginRoot, 'bundle', 'bridge.mjs')], timeout: 180, exposure: 'direct', description: '嗨番 MCP 共享工具集合；当前提供图像诊断，凭证与图片字节由本机适配器处理。' };
  settings.mcpServers = { ...settings.mcpServers, hifun_mcp: config };
  const temp = destination + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, destination);
  console.log('已添加 Pi/Pi Web MCP 配置；既有条目已保留。请在 Pi Web 新建会话或重新加载。');
}

export async function main() {
  const command = process.argv[2];
  if (command === '--configure') return configure();
  if (command === '--provision') {
    // Admin automation only: token is consumed from a pipe, never an argv or log.
    let token = ''; for await (const chunk of process.stdin) token += chunk;
    await saveConfig({ url: process.argv[3] || defaultEndpoint, token: token.trim(), allowedRoots: [process.argv[4]] });
    console.log('本机连接已配置。'); return;
  }
  if (command === '--install-pi') return installPi();
  if (command === '--reset-image') {
    if (process.argv[4] !== '--confirmed') throw new Error('需由用户明确核对后加 --confirmed；可能产生一次新的诊断费用。');
    const config = await loadConfig();
    const image = await readImage(process.argv[3], config.allowedRoots);
    const key = createHash('sha256').update(config.token).update(image.mime).update(image.bytes).digest('hex');
    await unlink(path.join(configDir(), 'requests', key + '.json'));
    console.log('本机记录已显式重置；服务端仍保留其已有状态。'); return;
  }
  let loaded;
  async function connection() {
    if (!loaded) {
      const config = await loadConfig();
      const remote = createRemote(config, { expectedDigest: sourceDigest });
      loaded = { remote, diagnose: createDiagnoser(config, remote, path.join(configDir(), 'requests')) };
    }
    return loaded;
  }
  if (command === '--check') {
    const { remote } = await connection();
    const skill = await remote.getSkill();
    console.log(JSON.stringify({ connected: true, service: 'HiFun_MCP_Server', tool: 'diagnose_image', skillVerified: true, skillBytes: Buffer.byteLength(skill), diagnosisSubmitted: false })); return;
  }
  if (command) throw new Error('未知命令；支持 --configure、--check、--install-pi。');
  const server = new McpServer({ name: 'hifun-mcp', title: '嗨番 MCP', version: '0.1.1' }, { capabilities: { tools: {}, resources: {} } });
  server.registerTool('diagnose_image', {
    title: '图像诊断',
    description: '通过 HiFun_MCP_Server 分析本次用户明确提供的番茄图片。只传图片绝对路径，本机适配器读取并发送图片字节；不要读取或发送凭证，不要自动重试。',
    inputSchema: z.object({ image_path: z.string().min(1).max(4096) }),
  }, async ({ image_path }) => {
    try {
      const result = await (await connection()).diagnose(image_path);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const message = /^(CONFIG|IMAGE_|SKILL|SERVICE|CONNECTION|DIAGNOSIS_UNKNOWN|STATE|BUSY|RESULT|ENDPOINT)/.test(error.message) ? error.message : 'DIAGNOSIS_UNKNOWN: 本次诊断未确认，不会自动重试。';
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  });
  server.registerResource('image-diagnosis-skill', skillUri, { mimeType: 'text/markdown', description: 'HiFun 服务端白名单诊断使用指南，读取时校验来源和摘要。' }, async uri => {
    const text = await (await connection()).remote.getSkill();
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
  });
  await server.connect(new StdioServerTransport());
}

main().catch(() => { console.error('HiFun 插件未能启动；请核对本机配置和安装说明。'); process.exitCode = 1; });
