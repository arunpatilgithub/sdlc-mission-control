keywords: pinterest, pinterest conversion, pinterest revenue
last_verified: 2026-09-15
source: https://developers.pinterest.com/docs/track-conversions/track-conversions-in-the-api/

# Pinterest Conversions API

## Endpoint
`POST https://api.pinterest.com/v5/ad_accounts/{AD_ACCOUNT_ID}/events`

## Authentication
Use `Authorization: Bearer {TOKEN}` with a conversion token or OAuth token carrying `ads:write`, and send JSON.

## Required fields
The body contains `data`. Each event requires `event_name`, `action_source`, `event_time` (Unix seconds), `event_id`, and `user_data` with at least one match identifier.

## Optional fields
`event_source_url`, `opt_out`, IP address, user agent, hashed customer identifiers, and `custom_data` such as currency, value, order ID, and contents.

## Example request
```bash
curl -X POST "https://api.pinterest.com/v5/ad_accounts/${AD_ACCOUNT_ID}/events" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"data":[{"event_name":"checkout","action_source":"web","event_time":1769818901,"event_id":"order-123","user_data":{"em":["<sha256-email>"]},"custom_data":{"currency":"USD","value":"66.95"}}]}'
```
