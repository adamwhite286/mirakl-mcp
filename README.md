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
get_account · list_orders · get_order · accept_or_refuse_order · set_order_tracking · ship_order · list_carriers · get_order_documents · list_threads · get_thread · reply_to_thread · open_order_thread · get_thread_reasons · list_offers · update_offers · get_offer_import_status · list_invoices · list_transactions · mirakl_get
