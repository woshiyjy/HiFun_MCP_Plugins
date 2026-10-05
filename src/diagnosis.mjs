import path from 'node:path';
import { constants } from 'node:fs';
import { realpath, open, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

export async function readImage(imagePath, allowedRoots) {
  if (typeof imagePath !== 'string' || !path.isAbsolute(imagePath) || imagePath.split(/[\\/]/).some(part => part.startsWith('.'))) throw new Error('IMAGE_PATH: 只接受本次用户指定的普通图片绝对路径。');
  const resolved = await realpath(imagePath);
  if (resolved.split(/[\\/]/).some(part => part.startsWith('.'))) throw new Error('IMAGE_PATH: 隐藏目录不可作为图片来源。');
  const roots = await Promise.all(allowedRoots.map(root => realpath(root)));
  if (!roots.some(root => resolved !== root && !path.relative(root, resolved).startsWith('..' + path.sep)
    && path.relative(root, resolved) !== '..' && !path.isAbsolute(path.relative(root, resolved)))) throw new Error('IMAGE_SCOPE: 图片不在你已配置的允许目录中。');
  const ext = path.extname(resolved).toLowerCase();
  const mime = ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' })[ext];
  if (!mime) throw new Error('IMAGE_TYPE: 只支持 JPEG、PNG、WebP。');
  const file = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const meta = await file.stat();
    if (!meta.isFile() || meta.size < 4 || meta.size > 8 * 1024 * 1024) throw new Error('IMAGE_SIZE: 图片必须是最多 8 MiB 的普通文件。');
    const bytes = Buffer.alloc(meta.size);
    let count = 0;
    while (count < bytes.length) {
      const part = await file.read(bytes, count, bytes.length - count, count);
      if (!part.bytesRead) throw new Error('IMAGE_CHANGED: 图片读取期间发生变化。');
      count += part.bytesRead;
    }
    const after = await file.stat();
    if (after.size !== meta.size || after.mtimeMs !== meta.mtimeMs) throw new Error('IMAGE_CHANGED: 请在图片保存完成后重新提交。');
    const matches = mime === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP';
    if (!matches) throw new Error('IMAGE_TYPE: 文件内容与图片格式不符。');
    return { bytes, mime };
  } finally { await file.close(); }
}

export function createDiagnoser(config, remote, ledgerDir) {
  let busy = false;
  return async imagePath => {
    if (busy) throw new Error('BUSY: 请等待当前诊断完成。');
    busy = true;
    try {
      const image = await readImage(imagePath, config.allowedRoots);
      await remote.getSkill();
      const key = createHash('sha256').update(config.token).update(image.mime).update(image.bytes).digest('hex');
      await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
      const dest = path.join(ledgerDir, key + '.json');
      let previous;
      try { previous = JSON.parse(await readFile(dest, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('STATE: 本机调用记录无法确认。'); }
      if (previous && previous.expires > Date.now()) {
        if (previous.state === 'done') return { ...previous.result, source: { transport: 'MCP', service: 'HiFun_MCP_Server', cached: true } };
        throw new Error('DIAGNOSIS_UNKNOWN: 这张图片已有未确认的诊断，不会重复提交。请联系服务管理员核对后重置本机记录。');
      }
      if (previous) throw new Error('STATE_EXPIRED: 这张图片的调用记录已过期，请由用户在终端显式重置后开始新诊断。');
      const record = { requestId: randomUUID(), expires: Date.now() + 24 * 60 * 60 * 1000, state: 'running' };
      try { await writeFile(dest, JSON.stringify(record), { mode: 0o600, flag: 'wx' }); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('BUSY: 这张图片已有诊断请求。'); throw error; }
      const result = await remote.diagnose(image.bytes, image.mime, record.requestId);
      const temp = dest + '.' + randomUUID() + '.tmp';
      await writeFile(temp, JSON.stringify({ ...record, state: 'done', result }), { mode: 0o600 });
      await rename(temp, dest);
      return { ...result, source: { transport: 'MCP', service: 'HiFun_MCP_Server', cached: false } };
    } finally { busy = false; }
  };
}
