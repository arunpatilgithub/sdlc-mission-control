keywords: reddit, reddit conversion, reddit revenue
last_verified: 2026-09-15
source: https://business.reddithelp.com/s/article/conversions-api-parameters

# Reddit Conversions API v3

## Endpoint
`POST https://ads-api.reddit.com/api/v3/pixels/{PIXEL_ID}/conversion_events`

## Authentication
Use `Authorization: Bearer {TOKEN}` with a conversion access token or OAuth2 token carrying `adsconversions`, and send JSON.

## Required fields
The body requires `data.events`. Each event requires `event_at` (Unix milliseconds), `action_source`, and `type` containing at least `tracking_type`.

## Optional fields
`click_id`, `event_source_url`, `custom_event_name`, conversion metadata, products, and user match fields such as external ID, email, phone, IP address, and user agent.

## Example request
```bash
curl -X POST "https://ads-api.reddit.com/api/v3/pixels/${PIXEL_ID}/conversion_events" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"data":{"events":[{"event_at":1514764800000,"action_source":"WEBSITE","type":{"tracking_type":"PAGE_VISIT"},"metadata":{"conversion_id":"order-123","currency":"USD","value":10.99}}]}}'
```
