#!/usr/bin/env node
/**
 * MCP 接口（stdio JSON-RPC，零依赖）
 * 把管线暴露给任意 Agent：贴一张术前须知 → 拿回一本绘本的 JSON。
 *
 * 注册到 WorkBuddy / Claude Desktop：
 *   { "command": "node", "args": ["<绝对路径>/mcp/server.mjs"] }
 *
 * 暴露的工具：
 *   list_skeletons     当前支持的术式骨架
 *   parse_preop_notice 术前须知 → 结构化病例（含事实出处）
 *   build_preop_book   术前须知 → 完整绘本 JSON（含事实保真校验结果）
 */
import { createInterface } from 'node:readline';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNotice } from '../web/engine/parse.mjs';
import { assembleBook } from '../web/engine/assemble.mjs';
import { validateBook } from '../web/engine/validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const manifest = JSON.parse(readFileSync(join(ROOT, 'assets/manifest.json'), 'utf8'));
const skDir = join(ROOT, 'web/engine/skeletons');
const skeletons = {};
for (const f of readdirSync(skDir).filter((x) => x.endsWith('.json') && x !== 'index.json')) {
  const sk = JSON.parse(readFileSync(join(skDir, f), 'utf8'));
  skeletons[sk.key] = sk;
}

const TOOLS = [
  {
    name: 'list_skeletons',
    description: '列出当前故事骨架库支持的术式（骨架=疾病角色+章节结构）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'parse_preop_notice',
    description: '把术前须知文本解析成结构化病例：术式、麻醉方式、禁食时长、留置针、住院天数，每条事实都带原文出处。只抽取不推断。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '术前须知全文（脱敏或合成）' } },
      required: ['text'],
    },
  },
  {
    name: 'build_preop_book',
    description: '把术前须知装配成一本患儿绘本的完整 JSON：封面、逐页文案、每页配图素材 id、医学事实卡、徽章。返回前会做事实保真校验。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '术前须知全文（脱敏或合成）' },
        child_name: { type: 'string', description: '患儿昵称（可选，缺省从须知里取）' },
      },
      required: ['text'],
    },
  },
];

function call(name, args) {
  if (name === 'list_skeletons') {
    return Object.values(skeletons).map((s) => ({ key: s.key, label: s.label, pages: s.pages.length }));
  }
  if (name === 'parse_preop_notice') {
    const c = parseNotice(args.text, { childName: args.child_name });
    return { procedure: c.procedure, child: c.child, facts: c.facts, missing: c.missing };
  }
  if (name === 'build_preop_book') {
    const c = parseNotice(args.text, { childName: args.child_name });
    const book = assembleBook(c, manifest, skeletons);
    const report = validateBook(book);
    return { book, validation: report };
  }
  throw new Error(`未知工具: ${name}`);
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;

  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'preop-storybook', version: '0.1.0' },
      },
    });
  }
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    try {
      const data = call(params.name, params.arguments || {});
      return send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] },
      });
    } catch (e) {
      return send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: `错误: ${e.message}` }], isError: true },
      });
    }
  }
  if (method === 'notifications/initialized' || method === 'ping') {
    if (id != null) send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (id != null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未支持: ${method}` } });
});
