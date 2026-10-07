keywords: openai, chatgpt, openai ads, conversions api
last_verified: 2026-09-15
source: https://developers.openai.com/ads/conversions-api

# OpenAI Ads Conversions API

## Endpoint
`POST https://bzr.openai.com/v1/events?pid={PIXEL_ID}`

## Authentication
Send the ad-account Conversions API key as `Authorization: Bearer {OPENAI_CONVERSIONS_API_KEY}` and JSON as `Content-Type: application/json`.

## Required fields
Each event requires `id`, `type`, `timestamp_ms` (integer Unix milliseconds, within seven days and no more than ten minutes ahead), `action_source`, and `data`. Hashed PII fields such as `emails_sha256`, `phone_numbers_sha256`, and `external_ids_sha256` are arrays of lowercase SHA-256 hex strings.

## Optional fields
`oppref`, `source_url`, `user.obref`, geographic arrays, `ip_address`, `user_agent`, and event-specific data fields. Monetary amounts use ISO 4217 minor units with a currency.

## Example request
```bash
curl -X POST "https://bzr.openai.com/v1/events?pid=${PIXEL_ID}" \
  -H "Authorization: Bearer ${OPENAI_CONVERSIONS_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"id":"order_12345","type":"order_created","timestamp_ms":1773892800000,"action_source":"web","user":{"emails_sha256":["b4c9a289323b21a01c3e940f150eb9b8c542587f1abfd8f0e1cc1ffc5e475514"]},"data":{"type":"contents"}}'
```
