// Shopify ↔ Mirakl (B&Q) sync
//
//  Shopify → B&Q : stock & price. Webhooks (inventory_levels/update, products/update)
//                  give near-real-time pushes; a periodic reconciliation catches anything missed.
//  B&Q → Shopify : new marketplace orders are (optionally auto-accepted and) created as
//                  Shopify orders tagged "B&Q" + "BQ-<order id>" so they can be picked/fulfilled
//                  alongside web orders.
//  Shopify → B&Q : when a B&Q-tagged order is fulfilled in Shopify with a tracking number,
//                  the carrier + tracking are sent to Mirakl and the order is marked shipped.
//
// Env vars:
//   SHOPIFY_SHOP            e.g. hneqs0-f9.myshopify.com
//   SHOPIFY_CLIENT_ID +     Dev Dashboard app credentials – the server exchanges them for
//   SHOPIFY_CLIENT_SECRET   short-lived Admin API tokens (client-credentials grant). Preferred.
//   SHOPIFY_ACCESS_TOKEN    alternatively, a legacy custom-app Admin API token
//   SHOPIFY_API_SECRET      webhook HMAC key (defaults to SHOPIFY_CLIENT_SECRET)
//   PUBLIC_URL              this service's public URL, e.g. https://mirakl-mcp.onrender.com
//   SYNC_INTERVAL_MIN       reconciliation / order poll interval (default 5)
//   AUTO_ACCEPT_ORDERS      "true" (default) to accept WAITING_ACCEPTANCE orders automatically
//   PRICE_MULTIPLIER        multiply Shopify price before sending to B&Q (default 1)
//   SYNC_DRY_RUN            "true" → log what would change but write nothing
//
// Matching key everywhere is the SKU: Shopify variant.sku === Mirakl offer.shop_sku.

import crypto from 'node:crypto';

const SHOP = process.env.SHOPIFY_SHOP;
const STATIC_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;           // legacy custom app token (optional)
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;                  // Dev Dashboard app (preferred)
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SECRET = process.env.SHOPIFY_API_SECRET || CLIENT_SECRET;   // webhook HMAC key
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MIN || 5) * 60 * 1000;
const AUTO_ACCEPT = (process.env.AUTO_ACCEPT_ORDERS || 'true') === 'true';
const PRICE_MULT = Number(process.env.PRICE_MULTIPLIER || 1);
const DRY_RUN = process.env.SYNC_DRY_RUN === 'true';
const API_VERSION = '2025-07';
const TAG_ALL = 'B&Q';
const TAG_PREFIX = 'BQ-';

export const enabled = Boolean(SHOP && (STATIC_TOKEN || (CLIENT_ID && CLIENT_SECRET)));

// ---------- activity log (in-memory ring buffer, surfaced via sync_status) ----------
const LOG_MAX = 200;
const log = [];
export const state = {
  enabled, dryRun: DRY_RUN, autoAccept: AUTO_ACCEPT, intervalMin: INTERVAL_MS / 60000,
  lastRun: null, lastError: null, running: false, counters: { offersUpdated: 0, ordersImported: 0, ordersAccepted: 0, ordersShipped: 0, webhooks: 0 }
};
function note(level, msg, extra) {
  const line = { t: new Date().toISOString(), level, msg, ...(extra ? { extra } : {}) };
  log.push(line); if (log.length > LOG_MAX) log.shift();
  (level === 'error' ? console.error : console.log)(`[sync] ${msg}`, extra ? JSON.stringify(extra) : '');
}
export const recentLog = (n = 50) => log.slice(-n);

// ---------- Shopify Admin GraphQL ----------
const shopBase = () => (SHOP.startsWith('http') ? SHOP : `https://${SHOP}`); // http form only for local testing

// Client-credentials grant: tokens last 24h; refresh a few minutes early.
let tokenCache = { value: STATIC_TOKEN || null, expiresAt: STATIC_TOKEN ? Infinity : 0 };
async function accessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  const res = await fetch(`${shopBase()}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'client_credentials' })
  });
  const d = await res.json();
  if (!res.ok || !d.access_token) throw new Error(`Shopify token exchange failed: ${JSON.stringify(d)}`);
  tokenCache = { value: d.access_token, expiresAt: Date.now() + Math.max(60, (d.expires_in || 86400) - 300) * 1000 };
  note('info', 'Obtained Shopify access token via client credentials');
  return d.access_token;
}

async function gql(query, variables = {}) {
  const res = await fetch(`${shopBase()}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await accessToken() },
    body: JSON.stringify({ query, variables })
  });
  const data = await res.json();
  if (!res.ok || data.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(data.errors || data)}`);
  return data.data;
}

async function allShopifyVariants() {
  const out = []; let after = null;
  do {
    const d = await gql(`query($after:String){ productVariants(first:250, after:$after){
      pageInfo{hasNextPage endCursor}
      nodes{ id sku price inventoryQuantity inventoryItem{ id tracked } product{ id status title } } } }`, { after });
    out.push(...d.productVariants.nodes);
    after = d.productVariants.pageInfo.hasNextPage ? d.productVariants.pageInfo.endCursor : null;
  } while (after);
  return out;
}

async function variantsByInventoryItem(inventoryItemGid) {
  const d = await gql(`query($id:ID!){ inventoryItem(id:$id){ variant{ id sku price inventoryQuantity product{ status } } } }`, { id: inventoryItemGid });
  return d.inventoryItem?.variant ? [d.inventoryItem.variant] : [];
}

async function variantBySku(sku) {
  const d = await gql(`query($q:String!){ productVariants(first:1, query:$q){ nodes{ id sku price product{ id title status } } } }`, { q: `sku:"${sku.replace(/"/g, '')}"` });
  return d.productVariants.nodes.find(v => v.sku === sku) || null;
}

async function findShopifyOrderByTag(tag) {
  const d = await gql(`query($q:String!){ orders(first:1, query:$q){ nodes{ id name tags } } }`, { q: `tag:'${tag}'` });
  return d.orders.nodes.find(o => o.tags.includes(tag)) || null;
}

async function fulfilledBQOrders(sinceIso) {
  const d = await gql(`query($q:String!){ orders(first:50, query:$q){ nodes{ id name tags displayFulfillmentStatus
      fulfillments{ status trackingInfo{ company number url } } } } }`,
    { q: `tag:'${TAG_ALL}' fulfillment_status:shipped updated_at:>'${sinceIso}'` });
  return d.orders.nodes;
}

// ---------- Mirakl helpers (injected from server.js so one HTTP helper is shared) ----------
let mirakl;
export function init(miraklFn) { mirakl = miraklFn; }

async function allMiraklOffers() {
  const out = []; let offset = 0;
  for (;;) {
    const r = await mirakl('GET', '/api/offers', { query: { max: 100, offset } });
    out.push(...(r.offers || []));
    offset += 100;
    if (out.length >= (r.total_count || 0) || !(r.offers || []).length) break;
  }
  return out;
}

let carrierCache = null;
async function carriers() {
  if (!carrierCache) carrierCache = (await mirakl('GET', '/api/shipping/carriers')).carriers || [];
  return carrierCache;
}
function matchCarrier(list, company = '') {
  const c = company.toLowerCase();
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return list.find(x => norm(x.label) === norm(c)) || list.find(x => norm(x.code) === norm(c))
    || list.find(x => c && (norm(x.label).includes(norm(c)) || norm(c).includes(norm(x.label))));
}

// ---------- Stock / price push ----------
function desiredOffer(variant) {
  const active = variant.product?.status === 'ACTIVE';
  const qty = active ? Math.max(0, Number(variant.inventoryQuantity ?? 0)) : 0;
  const price = Math.round(Number(variant.price) * PRICE_MULT * 100) / 100;
  return { qty, price };
}

async function pushOffers(updates) {
  if (!updates.length) return;
  if (DRY_RUN) { note('info', `DRY RUN – would update ${updates.length} offers`, updates); return; }
  const r = await mirakl('POST', '/api/offers', { body: { offers: updates.map(u => ({ shop_sku: u.shop_sku, quantity: u.qty, price: u.price, update_delete: 'update' })) } });
  state.counters.offersUpdated += updates.length;
  note('info', `Pushed ${updates.length} offer update(s) to B&Q`, { import_id: r?.import_id, skus: updates.map(u => u.shop_sku) });
}

// Full reconciliation: every Mirakl offer whose SKU exists in Shopify gets Shopify's qty/price.
export async function reconcileOffers() {
  const [offers, variants] = await Promise.all([allMiraklOffers(), allShopifyVariants()]);
  const bySku = new Map();
  for (const v of variants) if (v.sku) { if (bySku.has(v.sku)) note('warn', `Duplicate SKU in Shopify: ${v.sku} – first one wins`); else bySku.set(v.sku, v); }
  const updates = [];
  for (const o of offers) {
    const v = bySku.get(o.shop_sku);
    if (!v) continue;
    const want = desiredOffer(v);
    if (Number(o.quantity) !== want.qty || Math.abs(Number(o.price) - want.price) > 0.004) updates.push({ shop_sku: o.shop_sku, ...want, was: { qty: o.quantity, price: o.price } });
  }
  note('info', `Reconcile: ${offers.length} B&Q offers, ${variants.length} Shopify variants, ${updates.length} to update`);
  await pushOffers(updates);
  return { offers: offers.length, variants: variants.length, updated: updates.length };
}

// Webhook-driven push for a handful of variants (only those that exist as B&Q offers).
async function pushVariants(variants) {
  const updates = [];
  for (const v of variants) {
    if (!v.sku) continue;
    let offer;
    try { offer = (await mirakl('GET', '/api/offers', { query: { sku: v.sku, max: 1 } })).offers?.[0]; } catch (e) { note('error', `offer lookup failed for ${v.sku}: ${e.message}`); continue; }
    if (!offer || offer.shop_sku !== v.sku) continue;
    const want = desiredOffer(v);
    if (Number(offer.quantity) !== want.qty || Math.abs(Number(offer.price) - want.price) > 0.004) updates.push({ shop_sku: v.sku, ...want });
  }
  await pushOffers(updates);
}

// ---------- Orders: B&Q → Shopify ----------
function miraklAddressToShopify(a = {}) {
  return {
    firstName: a.firstname, lastName: a.lastname, company: a.company || undefined,
    address1: a.street_1, address2: a.street_2 || undefined, city: a.city, zip: a.zip_code,
    countryCode: (a.country_iso_code || 'GB').slice(0, 2) === 'GB' ? 'GB' : a.country_iso_code, phone: a.phone || a.phone_secondary || undefined
  };
}

export async function importOrder(o) {
  const tag = TAG_PREFIX + o.order_id;
  if (await findShopifyOrderByTag(tag)) return false;
  const lineItems = [];
  for (const l of o.order_lines || []) {
    if (['REFUSED', 'CANCELED'].includes(l.order_line_state)) continue;
    const v = await variantBySku(l.offer_sku);
    const unit = Number(l.price_unit ?? (l.price / l.quantity));
    lineItems.push(v
      ? { variantId: v.id, quantity: l.quantity, priceSet: { shopMoney: { amount: unit.toFixed(2), currencyCode: o.currency_iso_code || 'GBP' } } }
      : { title: `${l.product_title || l.offer_sku} (B&Q SKU ${l.offer_sku})`, sku: l.offer_sku, quantity: l.quantity, requiresShipping: true, priceSet: { shopMoney: { amount: unit.toFixed(2), currencyCode: o.currency_iso_code || 'GBP' } } });
  }
  if (!lineItems.length) { note('warn', `Order ${o.order_id} has no importable lines`); return false; }
  const ship = o.customer?.shipping_address || {};
  const bill = o.customer?.billing_address || ship;
  const shippingTotal = Number(o.shipping_price || 0);
  const order = {
    email: o.customer_notification_email || undefined,
    tags: [TAG_ALL, tag],
    note: `B&Q marketplace order ${o.order_id} (commercial id ${o.commercial_id || '-'}). Created ${o.created_date}. Do not email the customer directly – use the B&Q inbox.`,
    customAttributes: [{ key: 'bq_order_id', value: o.order_id }, { key: 'bq_commercial_id', value: String(o.commercial_id || '') }],
    financialStatus: 'PAID',
    sourceName: 'B&Q Marketplace',
    lineItems,
    shippingAddress: miraklAddressToShopify(ship),
    billingAddress: miraklAddressToShopify(bill),
    shippingLines: [{ title: `B&Q ${o.shipping_type_label || 'delivery'}`, priceSet: { shopMoney: { amount: shippingTotal.toFixed(2), currencyCode: o.currency_iso_code || 'GBP' } } }],
    taxesIncluded: true
  };
  if (DRY_RUN) { note('info', `DRY RUN – would create Shopify order for ${o.order_id}`, order); return true; }
  const d = await gql(`mutation($order:OrderCreateOrderInput!,$options:OrderCreateOptionsInput){ orderCreate(order:$order, options:$options){ order{ id name } userErrors{ field message } } }`,
    { order, options: { inventoryBehaviour: 'DECREMENT_OBEYING_POLICY', sendReceipt: false, sendFulfillmentReceipt: false } });
  const ue = d.orderCreate.userErrors;
  if (ue?.length) throw new Error(`orderCreate ${o.order_id}: ${JSON.stringify(ue)}`);
  state.counters.ordersImported++;
  note('info', `Imported B&Q order ${o.order_id} as Shopify ${d.orderCreate.order.name}`);
  return true;
}

export async function syncOrders() {
  const since = new Date(Date.now() - 14 * 864e5).toISOString();
  // 1. auto-accept
  if (AUTO_ACCEPT) {
    const w = await mirakl('GET', '/api/orders', { query: { order_state_codes: 'WAITING_ACCEPTANCE', max: 100 } });
    for (const o of w.orders || []) {
      const lines = (o.order_lines || []).map(l => ({ id: l.order_line_id, accepted: true }));
      if (DRY_RUN) { note('info', `DRY RUN – would accept ${o.order_id}`); continue; }
      await mirakl('PUT', `/api/orders/${encodeURIComponent(o.order_id)}/accept`, { body: { order_lines: lines } });
      state.counters.ordersAccepted++;
      note('info', `Accepted B&Q order ${o.order_id} (${lines.length} line(s))`);
    }
  }
  // 2. import paid orders awaiting shipment (and recently shipped ones, in case we missed them)
  const r = await mirakl('GET', '/api/orders', { query: { order_state_codes: 'SHIPPING,SHIPPED,TO_COLLECT', start_update_date: since, max: 100 } });
  let imported = 0;
  for (const o of r.orders || []) { try { if (await importOrder(o)) imported++; } catch (e) { note('error', e.message); } }
  return { checked: (r.orders || []).length, imported };
}

// ---------- Fulfilment: Shopify → B&Q ----------
export async function syncFulfilments() {
  const since = new Date(Date.now() - 14 * 864e5).toISOString();
  const orders = await fulfilledBQOrders(since);
  const list = await carriers();
  let shipped = 0;
  for (const so of orders) {
    const tag = so.tags.find(t => t.startsWith(TAG_PREFIX));
    if (!tag) continue;
    const id = tag.slice(TAG_PREFIX.length);
    const mo = (await mirakl('GET', '/api/orders', { query: { order_ids: id } })).orders?.[0];
    if (!mo || mo.order_state !== 'SHIPPING') continue;
    const f = so.fulfillments.find(x => x.status === 'SUCCESS' && x.trackingInfo?.length) || so.fulfillments[0];
    const ti = f?.trackingInfo?.[0] || {};
    const carrier = matchCarrier(list, ti.company || '');
    const body = carrier
      ? { carrier_code: carrier.code, tracking_number: ti.number || undefined }
      : { carrier_name: ti.company || 'Courier', carrier_url: ti.url || undefined, tracking_number: ti.number || undefined };
    if (DRY_RUN) { note('info', `DRY RUN – would ship ${id}`, body); continue; }
    try {
      if (ti.number || ti.company) await mirakl('PUT', `/api/orders/${encodeURIComponent(id)}/tracking`, { body });
      await mirakl('PUT', `/api/orders/${encodeURIComponent(id)}/ship`);
      state.counters.ordersShipped++; shipped++;
      note('info', `Marked B&Q order ${id} shipped (${so.name})`, body);
    } catch (e) { note('error', `ship ${id}: ${e.message}`); }
  }
  return { checked: orders.length, shipped };
}

// ---------- Webhooks ----------
export function verifyWebhook(rawBody, hmacHeader) {
  if (!SECRET) return false;
  const digest = crypto.createHmac('sha256', SECRET).update(rawBody).digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader || '')); } catch { return false; }
}

export async function handleWebhook(topic, payload) {
  state.counters.webhooks++;
  try {
    if (topic === 'inventory_levels/update') {
      const gid = `gid://shopify/InventoryItem/${payload.inventory_item_id}`;
      await pushVariants(await variantsByInventoryItem(gid));
    } else if (topic === 'products/update') {
      const status = String(payload.status || '').toUpperCase();
      await pushVariants((payload.variants || []).map(v => ({ sku: v.sku, price: v.price, inventoryQuantity: v.inventory_quantity, product: { status } })));
    }
  } catch (e) { note('error', `webhook ${topic}: ${e.message}`); }
}

export async function ensureWebhooks() {
  if (!PUBLIC_URL) { note('warn', 'PUBLIC_URL not set – skipping webhook registration'); return; }
  const want = { INVENTORY_LEVELS_UPDATE: `${PUBLIC_URL}/webhooks/shopify`, PRODUCTS_UPDATE: `${PUBLIC_URL}/webhooks/shopify` };
  const d = await gql(`{ webhookSubscriptions(first:50){ nodes{ id topic endpoint{ ... on WebhookHttpEndpoint{ callbackUrl } } } } }`);
  const have = new Set(d.webhookSubscriptions.nodes.map(n => `${n.topic}|${n.endpoint?.callbackUrl}`));
  for (const [topic, url] of Object.entries(want)) {
    if (have.has(`${topic}|${url}`)) continue;
    const r = await gql(`mutation($t:WebhookSubscriptionTopic!,$s:WebhookSubscriptionInput!){ webhookSubscriptionCreate(topic:$t, webhookSubscription:$s){ userErrors{ message } } }`,
      { t: topic, s: { callbackUrl: url, format: 'JSON' } });
    const ue = r.webhookSubscriptionCreate.userErrors;
    note(ue?.length ? 'error' : 'info', `webhook ${topic}: ${ue?.length ? JSON.stringify(ue) : 'registered'}`);
  }
}

// ---------- Scheduler ----------
export async function runAll(trigger = 'timer') {
  if (state.running) return { skipped: 'already running' };
  state.running = true;
  const result = { trigger, startedAt: new Date().toISOString() };
  try {
    result.offers = await reconcileOffers();
    result.orders = await syncOrders();
    result.fulfilments = await syncFulfilments();
    state.lastError = null;
  } catch (e) { state.lastError = e.message; note('error', `sync run failed: ${e.message}`); result.error = e.message; }
  state.running = false; state.lastRun = result;
  return result;
}

export function start() {
  if (!enabled) { note('warn', 'Shopify sync disabled – set SHOPIFY_SHOP plus SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET (or SHOPIFY_ACCESS_TOKEN)'); return; }
  note('info', `Shopify sync enabled for ${SHOP}; every ${INTERVAL_MS / 60000} min; auto-accept=${AUTO_ACCEPT}; dryRun=${DRY_RUN}`);
  ensureWebhooks().catch(e => note('error', `ensureWebhooks: ${e.message}`));
  setTimeout(() => runAll('startup'), 5000);
  setInterval(() => runAll('timer'), INTERVAL_MS);
}
