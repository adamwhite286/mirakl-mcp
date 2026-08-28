// Mirakl Seller API → MCP server (Streamable HTTP)
// Exposes a B&Q / Kingfisher marketplace seller account to Claude as MCP tools.
//
// Env vars:
//   MIRAKL_BASE_URL  e.g. https://marketplace.kingfisher.com   (required)
//   MIRAKL_API_KEY   seller API key from Personal settings → API key (required)
//   MCP_TOKEN        shared secret; MCP endpoint is served at /mcp/<MCP_TOKEN>
//                    (also accepted as "Authorization: Bearer <MCP_TOKEN>" on /mcp)
//   PORT             defaults to 3000

import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as sync from './sync.js';

const BASE = (process.env.MIRAKL_BASE_URL || 'https://marketplace.kingfisher.com').replace(/\/$/, '');
const API_KEY = process.env.MIRAKL_API_KEY;
const MCP_TOKEN = process.env.MCP_TOKEN;
const PORT = Number(process.env.PORT || 3000);

if (!API_KEY) console.error('WARNING: MIRAKL_API_KEY is not set – every tool call will fail.');
if (!MCP_TOKEN) console.error('WARNING: MCP_TOKEN is not set – the endpoint will be unauthenticated.');

// ---------- Mirakl HTTP helper ----------
async function mirakl(method, path, { query, body } = {}) {
  const url = new URL(BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: API_KEY || '',
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error(`Mirakl ${method} ${path} → HTTP ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: e.message || String(e) }] });
const run = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };

// ---------- Build the MCP server ----------
function buildServer() {
  const server = new McpServer({ name: 'mirakl-bq-marketplace', version: '1.1.0' });

  // --- Account ---
  server.registerTool('get_account', {
    title: 'Get shop account',
    description: 'Shop account details: name, contact info, channels, currency, KPIs (Mirakl A01).',
    inputSchema: {}
  }, run(() => mirakl('GET', '/api/account')));

  // --- Orders ---
  server.registerTool('list_orders', {
    title: 'List orders',
    description: 'List orders (Mirakl OR11). Filter by state, date, or specific order ids. States: STAGING, WAITING_ACCEPTANCE, WAITING_DEBIT, WAITING_DEBIT_PAYMENT, SHIPPING, SHIPPED, TO_COLLECT, RECEIVED, CLOSED, REFUSED, CANCELED.',
    inputSchema: {
      order_state_codes: z.array(z.string()).optional().describe('Filter by order states, e.g. ["WAITING_ACCEPTANCE","SHIPPING"]'),
      order_ids: z.array(z.string()).optional().describe('Specific order ids'),
      start_date: z.string().optional().describe('ISO 8601 – orders created/updated after this date'),
      end_date: z.string().optional(),
      start_update_date: z.string().optional().describe('ISO 8601 – orders updated after this date'),
      customer_debited: z.boolean().optional(),
      has_incident: z.boolean().optional(),
      max: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
      sort: z.string().optional().describe('e.g. dateCreated or lastUpdatedDate'),
      order: z.enum(['asc', 'desc']).optional()
    }
  }, run((a) => mirakl('GET', '/api/orders', { query: a })));

  server.registerTool('get_order', {
    title: 'Get one order',
    description: 'Full detail for a single order id, including order lines, customer, shipping and totals.',
    inputSchema: { order_id: z.string() }
  }, run(async ({ order_id }) => {
    const r = await mirakl('GET', '/api/orders', { query: { order_ids: order_id } });
    return r.orders?.[0] || { error: 'Order not found', order_id };
  }));

  server.registerTool('accept_or_refuse_order', {
    title: 'Accept or refuse order lines',
    description: 'Accept or refuse order lines on an order in WAITING_ACCEPTANCE (Mirakl OR21). Provide every order line id with accepted true/false.',
    inputSchema: {
      order_id: z.string(),
      order_lines: z.array(z.object({ id: z.string().describe('order line id'), accepted: z.boolean() })).min(1)
    }
  }, run(({ order_id, order_lines }) => mirakl('PUT', `/api/orders/${encodeURIComponent(order_id)}/accept`, { body: { order_lines } }).then(r => r ?? { ok: true })));

  server.registerTool('set_order_tracking', {
    title: 'Set tracking info',
    description: 'Add carrier / tracking number to an order (Mirakl OR23). Use list_carriers to get valid carrier codes; for an unlisted carrier give carrier_name + carrier_url instead of carrier_code.',
    inputSchema: {
      order_id: z.string(),
      carrier_code: z.string().optional(),
      carrier_name: z.string().optional(),
      carrier_url: z.string().optional(),
      tracking_number: z.string().optional()
    }
  }, run(({ order_id, ...body }) => mirakl('PUT', `/api/orders/${encodeURIComponent(order_id)}/tracking`, { body }).then(r => r ?? { ok: true })));

  server.registerTool('ship_order', {
    title: 'Mark order shipped',
    description: 'Confirm shipment of an order in SHIPPING state (Mirakl OR24). Set tracking first with set_order_tracking.',
    inputSchema: { order_id: z.string() }
  }, run(({ order_id }) => mirakl('PUT', `/api/orders/${encodeURIComponent(order_id)}/ship`).then(r => r ?? { ok: true })));

  server.registerTool('list_carriers', {
    title: 'List carriers',
    description: 'Carriers configured on the marketplace, with codes usable in set_order_tracking (Mirakl SH21).',
    inputSchema: {}
  }, run(() => mirakl('GET', '/api/shipping/carriers')));

  server.registerTool('get_order_documents', {
    title: 'List order documents',
    description: 'List documents (invoices, delivery notes) attached to an order (Mirakl OR72).',
    inputSchema: { order_id: z.string() }
  }, run(({ order_id }) => mirakl('GET', '/api/orders/documents', { query: { order_ids: order_id } })));

  // --- Inbox / customer messages ---
  server.registerTool('list_threads', {
    title: 'List message threads',
    description: 'List inbox threads with customers / operator (Mirakl M11). Newest first. Filter by entity (e.g. an order id) or updated_since.',
    inputSchema: {
      entity_type: z.enum(['MMP_ORDER', 'MMP_OFFER', 'MMP_PRODUCT']).optional(),
      entity_id: z.string().optional().describe('Order id when entity_type is MMP_ORDER'),
      updated_since: z.string().optional().describe('ISO 8601'),
      with_messages: z.boolean().default(false).describe('Include message bodies'),
      limit: z.number().int().min(1).max(100).default(20),
      page_token: z.string().optional()
    }
  }, run((a) => mirakl('GET', '/api/inbox/threads', { query: a })));

  server.registerTool('get_thread', {
    title: 'Get thread',
    description: 'Full message thread including all messages and participants (Mirakl M12).',
    inputSchema: { thread_id: z.string() }
  }, run(({ thread_id }) => mirakl('GET', `/api/inbox/threads/${encodeURIComponent(thread_id)}`)));

  server.registerTool('reply_to_thread', {
    title: 'Reply to thread',
    description: 'Post a reply in an existing thread (Mirakl M13). to defaults to the customer; use ["OPERATOR"] to write to B&Q instead, or both.',
    inputSchema: {
      thread_id: z.string(),
      body: z.string().describe('Plain-text message body'),
      to: z.array(z.enum(['CUSTOMER', 'OPERATOR'])).default(['CUSTOMER'])
    }
  }, run(({ thread_id, body, to }) =>
    mirakl('POST', `/api/inbox/threads/${encodeURIComponent(thread_id)}/message`, {
      body: { body, to: to.map(t => ({ type: t === 'CUSTOMER' ? 'CUSTOMER_USER' : 'OPERATOR_USER' })) }
    }).then(r => r ?? { ok: true })));

  server.registerTool('open_order_thread', {
    title: 'Open new thread on an order',
    description: 'Start a new conversation attached to an order (Mirakl OR43). topic_type REASON_CODE requires a code from get_thread_reasons; FREE_TEXT takes any subject.',
    inputSchema: {
      order_id: z.string(),
      body: z.string(),
      topic_type: z.enum(['REASON_CODE', 'FREE_TEXT']).default('FREE_TEXT'),
      topic_value: z.string().describe('Reason code, or free-text subject'),
      to: z.array(z.enum(['CUSTOMER', 'OPERATOR'])).default(['CUSTOMER'])
    }
  }, run(({ order_id, body, topic_type, topic_value, to }) =>
    mirakl('POST', `/api/orders/${encodeURIComponent(order_id)}/threads`, {
      body: { body, topic: { type: topic_type, value: topic_value }, to: to.map(t => ({ type: t === 'CUSTOMER' ? 'CUSTOMER_USER' : 'OPERATOR_USER' })) }
    })));

  server.registerTool('get_thread_reasons', {
    title: 'Thread reason codes',
    description: 'Reason codes available when opening a thread (Mirakl RE01).',
    inputSchema: {}
  }, run(() => mirakl('GET', '/api/reasons', { query: { type: 'ORDER_MESSAGING' } })));

  // --- Offers / price & stock ---
  server.registerTool('list_offers', {
    title: 'List offers',
    description: 'List the shop\'s offers (listings) with price, quantity and state (Mirakl OF21).',
    inputSchema: {
      sku: z.string().optional().describe('Filter by shop SKU'),
      product_id: z.string().optional(),
      max: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0)
    }
  }, run((a) => mirakl('GET', '/api/offers', { query: a })));

  server.registerTool('update_offers', {
    title: 'Update offers (price / stock)',
    description: 'Update price and/or quantity on existing offers by shop SKU (Mirakl OF24, async import). Returns an import_id; poll get_offer_import_status. To take an offer offline set quantity 0; set update_delete "delete" to remove it.',
    inputSchema: {
      offers: z.array(z.object({
        shop_sku: z.string(),
        price: z.number().optional(),
        quantity: z.number().int().optional(),
        state_code: z.string().optional().describe('Offer condition code, usually "11" = New'),
        product_id: z.string().optional(),
        product_id_type: z.string().optional().describe('e.g. EAN or SHOP_SKU'),
        update_delete: z.enum(['update', 'delete']).default('update')
      })).min(1)
    }
  }, run(({ offers }) => mirakl('POST', '/api/offers', { body: { offers } })));

  server.registerTool('get_offer_import_status', {
    title: 'Offer import status',
    description: 'Status of an offer import launched by update_offers (Mirakl OF02), plus error report if any lines failed.',
    inputSchema: { import_id: z.string() }
  }, run(async ({ import_id }) => {
    const status = await mirakl('GET', `/api/offers/imports/${encodeURIComponent(import_id)}`);
    let errors = null;
    if (status?.lines_in_error > 0) {
      try { errors = await mirakl('GET', `/api/offers/imports/${encodeURIComponent(import_id)}/error_report`); } catch (e) { errors = e.message; }
    }
    return { status, errors };
  }));

  // --- Accounting ---
  server.registerTool('list_invoices', {
    title: 'List accounting documents',
    description: 'Invoices / credit notes issued by the marketplace to the shop (Mirakl IV01).',
    inputSchema: {
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      max: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0)
    }
  }, run((a) => mirakl('GET', '/api/invoices', { query: a })));

  server.registerTool('list_transactions', {
    title: 'List transaction logs',
    description: 'Financial transaction lines: order amounts, commissions, refunds, payouts (Mirakl TL01).',
    inputSchema: {
      order_id: z.string().optional(),
      date_created_from: z.string().optional(),
      date_created_to: z.string().optional(),
      transaction_types: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(100).default(50),
      page_token: z.string().optional()
    }
  }, run((a) => mirakl('GET', '/api/sellerpayment/transactions_logs', { query: a })));

  // --- Shopify sync ---
  server.registerTool('sync_status', {
    title: 'Shopify sync status',
    description: 'State of the Shopify ↔ B&Q sync: enabled?, last run result, counters, recent log lines.',
    inputSchema: { log_lines: z.number().int().min(0).max(200).default(30) }
  }, run(({ log_lines }) => ({ ...sync.state, log: sync.recentLog(log_lines) })));

  server.registerTool('run_sync_now', {
    title: 'Run Shopify sync now',
    description: 'Trigger an immediate sync pass: reconcile stock/price to B&Q, import new B&Q orders into Shopify, push Shopify fulfilments back to B&Q. Choose "all" or one stage.',
    inputSchema: { stage: z.enum(['all', 'offers', 'orders', 'fulfilments']).default('all') }
  }, run(async ({ stage }) => {
    if (!sync.enabled) return { error: 'Sync disabled – SHOPIFY_SHOP / SHOPIFY_ACCESS_TOKEN not set on the server' };
    if (stage === 'offers') return sync.reconcileOffers();
    if (stage === 'orders') return sync.syncOrders();
    if (stage === 'fulfilments') return sync.syncFulfilments();
    return sync.runAll('manual');
  }));

  // --- Escape hatch ---
  server.registerTool('mirakl_get', {
    title: 'Raw GET request',
    description: 'Read-only escape hatch: perform any GET against the Mirakl Seller API, e.g. path "/api/products" with query {"product_references":"EAN|123"}. See https://help.mirakl.net for endpoint docs.',
    inputSchema: {
      path: z.string().regex(/^\/api\//).describe('Path starting with /api/'),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
    }
  }, run(({ path, query }) => mirakl('GET', path, { query })));

  return server;
}

// ---------- HTTP wiring ----------
const app = express();

// Shopify webhooks need the raw body for HMAC verification – mount before the JSON parser.
app.post('/webhooks/shopify', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  const topic = req.get('x-shopify-topic') || '';
  if (!sync.verifyWebhook(req.body, req.get('x-shopify-hmac-sha256'))) return res.status(401).end();
  res.status(200).end(); // ack fast; Shopify retries on slow responses
  let payload; try { payload = JSON.parse(req.body.toString('utf8')); } catch { return; }
  sync.handleWebhook(topic, payload);
});

app.use(express.json({ limit: '2mb' }));

app.get('/', (_req, res) => res.json({ ok: true, service: 'mirakl-mcp', base: BASE, endpoint: '/mcp/<token>' }));

function authorised(req) {
  if (!MCP_TOKEN) return true;
  if (req.params.token && req.params.token === MCP_TOKEN) return true;
  const h = req.get('authorization') || '';
  return h === `Bearer ${MCP_TOKEN}`;
}

async function handleMcp(req, res) {
  if (!authorised(req)) return res.status(401).json({ error: 'unauthorised' });
  // Stateless: a fresh server + transport per request.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('MCP error', e);
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  }
}

for (const route of ['/mcp', '/mcp/:token']) {
  app.post(route, handleMcp);
  app.get(route, handleMcp);
  app.delete(route, handleMcp);
}

app.get('/sync/status', (req, res) => {
  if (MCP_TOKEN && (req.get('authorization') || '') !== `Bearer ${MCP_TOKEN}`) return res.status(401).json({ error: 'unauthorised' });
  res.json({ ...sync.state, log: sync.recentLog(50) });
});

sync.init(mirakl);
app.listen(PORT, '0.0.0.0', () => { console.log(`mirakl-mcp listening on :${PORT} → ${BASE}`); sync.start(); });
