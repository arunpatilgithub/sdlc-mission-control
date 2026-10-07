keywords: tiktok, tik tok, tiktok conversion, tiktok revenue
last_verified: 2026-09-15
source: https://business-api.tiktok.com/portal/docs/report-app-web-offline-or-crm-events/v1.3

# TikTok Events API 2.0

## Endpoint
`POST https://business-api.tiktok.com/open_api/v1.3/event/track/`

## Authentication
Send the token in the `Access-Token` header and use `Content-Type: application/json`.

## Required fields
The request requires `event_source`, `event_source_id`, and `data`. Each event in `data` requires `event` and `event_time` (Unix seconds).

## Optional fields
`event_id`, user identifiers and request context, plus event `properties` such as currency, value, content type, description, and contents.

## Example request
```bash
curl -X POST "https://business-api.tiktok.com/open_api/v1.3/event/track/" \
  -H "Access-Token: ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"event_source":"web","event_source_id":"PIXEL_CODE","data":[{"event":"Purchase","event_time":1687758765,"event_id":"order-123","properties":{"currency":"USD","value":200}}]}'
```
