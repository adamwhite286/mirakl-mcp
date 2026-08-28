// Minimal fake Shopify Admin GraphQL endpoint for exercising sync.js locally.
import express from 'express';
const app = express(); app.use(express.json());
const variants = [
  { id: 'gid://shopify/ProductVariant/1', sku: 'IM/00PPS11.4-1', price: '99.99', inventoryQuantity: 9904, inventoryItem: { id: 'gid://shopify/InventoryItem/11', tracked: true }, product: { id: 'gid://shopify/Product/1', status: 'ACTIVE', title: 'Passive Purple' } },
  { id: 'gid://shopify/ProductVariant/2', sku: 'IM/00FRED10WHITE', price: '150.00', inventoryQuantity: 0, inventoryItem: { id: 'gid://shopify/InventoryItem/12', tracked: true }, product: { id: 'gid://shopify/Product/2', status: 'ACTIVE', title: 'FRED' } }
];
const calls = [];
app.post('/admin/api/:v/graphql.json', (req, res) => {
  const q = req.body.query; calls.push(q.slice(0, 60));
  if (q.includes('productVariants(first:250')) return res.json({ data: { productVariants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: variants } } });
  if (q.includes('inventoryItem(id')) return res.json({ data: { inventoryItem: { variant: variants[0] } } });
  if (q.includes('productVariants(first:1')) { const sku = /sku:\\?"([^"\\]+)/.exec(req.body.variables.q)?.[1]; return res.json({ data: { productVariants: { nodes: variants.filter(v => v.sku === sku) } } }); }
  if (q.includes('orders(first:1')) return res.json({ data: { orders: { nodes: [] } } });
  if (q.includes('orders(first:50')) return res.json({ data: { orders: { nodes: [{ id: 'gid://shopify/Order/9', name: '#1009', tags: ['B&Q', 'BQ-TEST-ORDER-1'], displayFulfillmentStatus: 'FULFILLED', fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ company: 'DPD UK', number: '1234567890', url: null }] }] }] } } });
  if (q.includes('orderCreate')) return res.json({ data: { orderCreate: { order: { id: 'gid://shopify/Order/10', name: '#1010' }, userErrors: [] } } });
  if (q.includes('webhookSubscriptions(first')) return res.json({ data: { webhookSubscriptions: { nodes: [] } } });
  if (q.includes('webhookSubscriptionCreate')) return res.json({ data: { webhookSubscriptionCreate: { userErrors: [] } } });
  res.json({ errors: [{ message: 'unhandled query: ' + q.slice(0, 80) }] });
});
app.get('/calls', (_r, res) => res.json(calls));
app.listen(3099, () => console.log('mock shopify on 3099'));
