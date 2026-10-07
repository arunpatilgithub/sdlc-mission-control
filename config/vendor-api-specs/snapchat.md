keywords: snapchat, snap, snapchat conversion, snapchat revenue
last_verified: 2026-09-15
source: https://developers.snap.com/marketing-api/Conversions-API/UsingTheAPI

# Snapchat Conversions API v3

## Endpoint
`POST https://tr.snapchat.com/v3/{PIXEL_ID}/events`

## Authentication
Send the organization-scoped Conversions API token in the `access_token` query parameter and use `Content-Type: application/json`.

## Required fields
The body contains a `data` array. Web events require `event_name`, `event_time` (Unix seconds or milliseconds), `action_source`, `event_source_url`, and at least one matching signal in `user_data`.

## Optional fields
`event_id`, `custom_data`, `app_data`, click/cookie identifiers, and hashed `em` or `ph`. IP address plus user agent may serve as a matching signal.

## Example request
```bash
curl -X POST "https://tr.snapchat.com/v3/${PIXEL_ID}/events?access_token=${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"data":[{"event_name":"PURCHASE","event_time":1705508777,"action_source":"WEB","event_source_url":"https://example.com/checkout","user_data":{"em":["<sha256-email>"]},"custom_data":{"currency":"USD","value":"99.99"}}]}'
```
