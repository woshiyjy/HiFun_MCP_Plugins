import { homedir } from 'node:os';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export const skillUri = 'skill://hifun/image-diagnosis/SKILL.md';
export const defaultEndpoint = 'https://www.wehifun.cn/shared-mcp';
export const configDir = () => process.env.HIFUN_MCP_CONFIG_DIR || path.join(homedir(), '.config', 'hifun-mcp');
export const configPath = () => path.join(configDir(), 'connection.json');
export function validateEndpoint(value) {
  const url = new URL(value);
  const loopback = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/mcp';
  if ((!loopback && url.href !== defaultEndpoint) || url.username || url.password || url.search || url.hash) throw new Error('ENDPOINT: 使用 HiFun 官方 HTTPS 地址或本机 loopback /mcp 测试地址。');
  return url;
}
export async function loadConfig() {
  try {
    const meta = await stat(configPath());
    if (process.platform !== 'win32' && (meta.mode & 0o077)) throw new Error();
    const value = JSON.parse(await readFile(configPath(), 'utf8'));
    validateEndpoint(value.url);
    if (!/^[A-Za-z0-9._~-]{32,128}$/.test(value.token) || !Array.isArray(value.allowedRoots) || !value.allowedRoots.length
      || value.allowedRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) throw new Error();
    return value;
  } catch { throw new Error('CONFIG: 请在终端运行安装目录中的 node bundle/bridge.mjs --configure 完成连接和图片目录配置；不要把凭证发给聊天模型。'); }
}
export function createRemote(config, { fetcher = fetch, expectedDigest } = {}) {
  const endpoint = validateEndpoint(config.url);
  const headers = { Authorization: `Bearer ${config.token}` };
  let cached, loading;
  async function extension(method, params) {
    const response = await fetcher(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!response.ok) throw new Error('CONNECTION: MCP 连接或鉴权失败。');
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 65536) throw new Error('SKILL: 清单过大。');
    const packet = JSON.parse(response.headers.get('content-type')?.includes('text/event-stream') ? raw.split('\n').filter(line => line.startsWith('data: ')).at(-1)?.slice(6) : raw);
    if (packet.error || !packet.result) throw new Error('SKILL: MCP Skill 方法不可用。');
    return packet.result;
  }
  async function withClient(fn) {
    const client = new Client({ name: 'hifun-desktop-bridge', version: '0.1.1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers, redirect: 'error' }, fetch: fetcher }), { timeout: 15000 });
      const tools = await client.listTools();
      if (tools.tools.length !== 1 || tools.tools[0].name !== 'diagnose_image') throw new Error('SERVICE: 远端工具清单不符合 HiFun 约定。');
      if (!client.getServerCapabilities()?.extensions?.['io.modelcontextprotocol/skills']) throw new Error('SKILL: 远端未声明 Skills 扩展。');
      return await fn(client);
    } finally { await client.close().catch(() => {}); }
  }
  async function loadSkill() {
    const list = await extension('skills/list', {});
    const entry = list.skills?.find(item => item.uri === skillUri);
    const get = await extension('skills/get', { uri: skillUri });
    const resource = get.skill?.resources?.find(item => item.uri === skillUri);
    const listed = entry?.resources?.find(item => item.uri === skillUri);
    if (list.resultType !== 'complete' || get.resultType !== 'complete' || !resource || !listed || resource.digest !== listed.digest
      || resource.size !== listed.size || !/^sha256:[a-f0-9]{64}$/.test(resource.digest) || resource.size > 16384
      || (expectedDigest && expectedDigest !== resource.digest)) throw new Error('SKILL_VERSION: 远端使用指南发生变化，请更新插件后再诊断。');
    const result = await withClient(client => client.readResource({ uri: skillUri }));
    const parts = result.contents.filter(item => item.uri === skillUri && typeof item.text === 'string');
    if (parts.length !== 1 || Buffer.byteLength(parts[0].text) !== resource.size
      || `sha256:${createHash('sha256').update(parts[0].text).digest('hex')}` !== resource.digest) throw new Error('SKILL: 使用指南完整性校验失败。');
    cached = { text: parts[0].text, expires: Date.now() + Math.min(300000, Math.max(0, Number(get.ttlMs) || 0)) };
    return cached.text;
  }
  return {
    async getSkill() {
      if (cached?.expires > Date.now()) return cached.text;
      if (!loading) loading = loadSkill().catch(error => { cached = null; throw error; }).finally(() => { loading = null; });
      return loading;
    },
    async diagnose(bytes, mime, requestId) {
      await this.getSkill();
      const result = await withClient(client => client.callTool({ name: 'diagnose_image', arguments: { request_id: requestId, image_base64: bytes.toString('base64'), mime_type: mime } }, undefined, { timeout: 150000 }));
      if (result.isError) throw new Error('DIAGNOSIS_UNKNOWN: 本次诊断未取得确认结果，不会自动重试；请先核对服务状态。');
      const value = result.structuredContent;
      if (!value || !['standard', 'human_machine', 'block'].includes(value.route) || Buffer.byteLength(JSON.stringify(value)) > 131072) throw new Error('RESULT: 远端诊断结果不符合约定。');
      return value;
    },
  };
}
