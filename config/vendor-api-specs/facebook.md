keywords: facebook, meta, facebook conversion, facebook revenue
last_verified: 2026-09-15
source: https://developers.facebook.com/docs/marketing-api/conversions-api/using-the-api/

# Meta Conversions API

## Endpoint
`POST https://graph.facebook.com/{API_VERSION}/{PIXEL_ID}/events`

## Authentication
Send an access token using the `access_token` query parameter or Meta's supported server authentication convention. Send a JSON or form-encoded request.

## Required fields
The body contains a `data` array. Each server event requires `event_name`, `event_time` (Unix seconds), `action_source`, and `user_data`. Website events also require `event_source_url` and `user_data.client_user_agent`.

## Optional fields
`event_id`, `custom_data`, `opt_out`, browser identifiers, IP address, and normalized SHA-256 customer fields including `em`, `ph`, `fn`, `ln`, and `external_id`.

## Example request
```bash
curl -X POST "https://graph.facebook.com/v26.0/${PIXEL_ID}/events?access_token=${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"data":[{"event_name":"Purchase","event_time":1762902353,"action_source":"website","event_source_url":"https://example.com/checkout","user_data":{"em":["<sha256-email>"],"client_user_agent":"Mozilla/5.0"},"custom_data":{"currency":"USD","value":123.45},"event_id":"order-123"}]}'
```
