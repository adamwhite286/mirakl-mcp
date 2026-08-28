# mirakl-mcp

MCP server (Streamable HTTP) wrapping the Mirakl Seller API for the B&Q / Kingfisher marketplace.

## Env vars
| var | purpose |
|---|---|
| `MIRAKL_BASE_URL` | `https://marketplace.kingfisher.com` |
| `MIRAKL_API_KEY` | Seller API key (Personal settings → API key) |
| `MCP_TOKEN` | shared secret; endpoint served at `/mcp/<MCP_TOKEN>` |

## Run
```
npm install && npm start
```
Add `https://<host>/mcp/<MCP_TOKEN>` as a custom connector in Claude.

## Tools
get_account · list_orders · get_order · accept_or_refuse_order · set_order_tracking · ship_order · list_carriers · get_order_documents · list_threads · get_thread · reply_to_thread · open_order_thread · get_thread_reasons · list_offers · update_offers · get_offer_import_status · list_invoices · list_transactions · sync_status · run_sync_now · mirakl_get

## Shopify ↔ B&Q sync (sync.js)

| direction | what | how |
|---|---|---|
| Shopify → B&Q | stock & price | webhooks `inventory_levels/update` + `products/update` (near real-time) plus a full reconciliation every `SYNC_INTERVAL_MIN` |
| B&Q → Shopify | new orders | poller auto-accepts (`AUTO_ACCEPT_ORDERS`) then creates a Shopify order tagged `B&Q` and `BQ-<order id>`, marked paid, inventory decremented |
| Shopify → B&Q | fulfilment | fulfilled `B&Q`-tagged orders with tracking → Mirakl tracking + ship |

Matching key is the SKU (`variant.sku` == `offer.shop_sku`). Only offers that already exist on B&Q are updated – the sync never creates listings.

### Shopify app (Dev Dashboard)
Legacy custom apps can no longer be created (Jan 2026). Instead: https://dev.shopify.com → Apps → Create app →
Configuration → Admin API access scopes: `read_products, read_inventory, read_orders, write_orders, read_fulfillments, read_locations, write_webhooks`
→ Save → Install on the store → copy **Client ID** → `SHOPIFY_CLIENT_ID` and **Client secret** → `SHOPIFY_CLIENT_SECRET`.
The server exchanges these for 24-hour Admin API tokens itself (client-credentials grant) and uses the secret to verify webhooks.

### Extra env vars
| var | purpose |
|---|---|
| `SHOPIFY_SHOP` | `hneqs0-f9.myshopify.com` |
| `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` | Dev Dashboard app credentials (preferred) |
| `SHOPIFY_ACCESS_TOKEN` | legacy custom-app token (alternative) |
| `SHOPIFY_API_SECRET` | webhook HMAC key; defaults to the client secret |
| `PUBLIC_URL` | `https://mirakl-mcp.onrender.com` |
| `SYNC_INTERVAL_MIN` | default 5 |
| `AUTO_ACCEPT_ORDERS` | default true |
| `PRICE_MULTIPLIER` | default 1 |
| `SYNC_DRY_RUN` | `true` = log only, write nothing (recommended for the first day) |

MCP tools `sync_status` and `run_sync_now` expose the sync to Claude; `GET /sync/status` (Bearer `MCP_TOKEN`) does the same over HTTP.
