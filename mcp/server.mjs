#!/usr/bin/env node
/**
 * MCP 接口（stdio JSON-RPC，零依赖）
 *
 * 设计原则：接口只收「枚举 + 整数」，不收自由文本。
 *   —— 调用方可以是大模型，但它没法把"大概禁食 8 小时吧"变成数字，
 *      因为 fasting_hours 要么是 0-24 的整数，要么不存在。
 *      揣测在 schema 层被挡住，不靠提示词祈祷。
 *
 * 注册到 WorkBuddy / Claude Desktop：
 *   { "command": "node", "args": ["<绝对路径>/mcp/server.mjs"] }
 *
 * 工具：
 *   list_catalog      科室/病种/术式树 + 麻醉/装置枚举（调用方先查可选值）
 *   build_preop_book  受控参数 → 绘本 JSON（含缺失项、建议提问、版本）
 */
import { createInterface } from 'node:readline';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeCase, flattenProcedures } from '../web/engine/compose.mjs';
import { assembleBook } from '../web/engine/assemble.mjs';
import { validateBook } from '../web/engine/validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const manifest = JSON.parse(readFileSync(join(ROOT, 'assets/manifest.json'), 'utf8'));
const catalog = JSON.parse(readFileSync(join(ROOT, 'web/engine/catalog.json'), 'utf8'));

const skDir = join(ROOT, 'web/engine/skeletons');
const skeletons = {};
for (const f of readdirSync(skDir).filter((x) => x.endsWith('.json') && x !== 'index.json')) {
  const sk = JSON.parse(readFileSync(join(skDir, f), 'utf8'));
  skeletons[sk.key] = sk;
}

const PROCEDURE_IDS = flattenProcedures(catalog).map((p) => p.id);
const ANESTHESIA_IDS = (catalog.anesthesia || []).map((a) => a.id);
const DEVICE_IDS = (catalog.devices || []).map((d) => d.id);

const TOOLS = [
  {
    name: 'list_catalog',
    description:
      '返回受控词表：科室/病种/术式（含是否有专属故事）+ 麻醉方式 + 装置枚举。任何生成前先调它拿可选值。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'build_preop_book',
    description:
      '用受控参数生成一本术前绘本。只接受枚举与整数，不接受自由文本；未提供的字段不会出现在书里，' +
      '只会在 missing 与 questions 中体现。返回 { version, mode, missing, questions, book }。',
    inputSchema: {
      type: 'object',
      properties: {
        procedure_id: { type: 'string', enum: PROCEDURE_IDS, description: '术式 id（来自 list_catalog）' },
        child_name: { type: 'string', description: '患儿昵称，可省略' },
        age: { type: 'integer', minimum: 0, maximum: 18, description: '年龄（岁）' },
        anesthesia_id: { type: 'string', enum: ANESTHESIA_IDS },
        fasting_hours: { type: 'integer', minimum: 0, maximum: 24, description: '术前禁食小时数：确认过才传' },
        liquid_hours: { type: 'integer', minimum: 0, maximum: 24, description: '术前禁水小时数：确认过才传' },
        stay_days: { type: 'integer', minimum: 0, maximum: 30 },
        devices: { type: 'array', items: { type: 'string', enum: DEVICE_IDS } },
      },
      required: ['procedure_id'],
      additionalProperties: false,
    },
  },
];

function call(name, args) {
  if (name === 'list_catalog') {
    return {
      note: catalog.note,
      review: catalog.review,
      departments: (catalog.departments || []).map((d) => ({
        id: d.id,
        label: d.label,
        groups: (d.groups || []).map((g) => ({
          id: g.id,
          label: g.label,
          procedures: (g.procedures || []).map((p) => ({
            id: p.id,
            label: p.label,
            has_story: Boolean(p.skeleton),
          })),
        })),
      })),
      anesthesia: catalog.anesthesia,
      devices: catalog.devices,
    };
  }

  if (name === 'build_preop_book') {
    // 未知术式直接拒，不做任何猜测
    if (!PROCEDURE_IDS.includes(args.procedure_id)) {
      throw new Error(`procedure_id 不在词表内：${args.procedure_id}`);
    }
    const caseObj = composeCase({
      catalog,
      procedureId: args.procedure_id,
      childName: args.child_name,
      age: args.age ?? null,
      anesthesiaId: args.anesthesia_id ?? null,
      fastingHours: args.fasting_hours ?? null,
      liquidHours: args.liquid_hours ?? null,
      stayDays: args.stay_days ?? null,
      devices: args.devices ?? [],
    });
    const book = assembleBook(caseObj, manifest, skeletons);
    const report = validateBook(book);
    if (!report.ok) {
      throw new Error(
        `事实校验未通过：${report.issues.filter((i) => i.level === 'error').map((i) => i.message).join('；')}`
      );
    }
    return {
      version: book.version,
      mode: book.mode,
      missing: book.missing,
      questions: book.questions,
      book,
    };
  }

  throw new Error(`未知工具：${name}`);
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
        serverInfo: { name: 'preop-storybook', version: '0.2.0' },
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
        result: { content: [{ type: 'text', text: `错误：${e.message}` }], isError: true },
      });
    }
  }
  if (method === 'notifications/initialized' || method === 'ping') {
    if (id != null) send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (id != null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未支持：${method}` } });
});
