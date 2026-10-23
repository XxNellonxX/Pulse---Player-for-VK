# SoundCloud stream API diagnostics

Observed on 22 October 2026 with Pulse 0.5.0-preview.3, using the documented
SoundCloud client-credentials flow on an Ubuntu 24.04 VPS in the Netherlands.
The account owner confirms an active Artist Pro subscription. No credentials,
OAuth tokens or signed media URLs are included in this report.

Update, 23 October: preview.4 enables the public gateway and bounded session
caches by default. Real audio has since decoded for 150 seconds, and a separate
live Edge check played “капля испуга”, sought near the end and reached `ended`
without HLS/decoder/network errors. This does not invalidate the provider
failures recorded below or establish universal availability. See the
[preview.4 verification](release-0.5.0-preview.4-verification.md) for the exact
test boundaries, remaining FFmpeg warnings and per-track direct-VK fallback.

## Observed behavior

OAuth token exchange succeeds. Public track search and metadata return HTTP 200
with `access: playable` and `streamable: true`. The following documented GET
requests intermittently return HTTP 500 with `{"error":"Middleware error"}`
or HTTP 503 (plain text):

```text
https://api.soundcloud.com/tracks/soundcloud:tracks:293/streams
https://api.soundcloud.com/tracks/soundcloud:tracks:2398325895/streams
https://api.soundcloud.com/tracks/soundcloud:tracks:2418736365/streams
```

Some control requests returned HTTP 200 with the documented HLS fields. Failures
also reproduce directly on the VPS, outside Pulse's gateway. The same token was
reused within each control series. These observations do not establish a cause,
account entitlement issue or general SoundCloud outage.

Headers compared:

```http
Authorization: OAuth <REDACTED>
Accept: application/json; charset=utf-8
User-Agent: PulseGateway/1.0 (https://github.com/XxNellonxX/Pulse---Player-for-VK)
```

The standard OAuth2 Bearer alternative, numeric IDs and encoded URNs were also
compared. Changing headers improved one series but did not resolve subsequent
failures. The final gateway probe still failed at `/streams` with the safe
public error `502 provider_unavailable`; full playback and seeking remain
unverified.

Example provider trace IDs from unsuccessful direct requests:

- `6e06af49f72e4ba6e37605ebeeff57b9` — track 293, HTTP 500.
- `6355903ebab2cf38b3c4e46f5dee4bcf` — track 2398325895, HTTP 500.
- `5bb61357d53a4145b01ee5d440982637` — track 2418736365, HTTP 500.

## Relevant source

- [OAuth exchange, reuse and refresh](../services/pulse-gateway/src/oauth.mjs).
- [API requests, headers, canonical URNs and safe error mapping](../services/pulse-gateway/src/gateway.mjs).
- [Authenticated media requests, redirects and bounded retry](../services/pulse-gateway/src/media.mjs).
- [Pinned HTTPS transport and response limits](../services/pulse-gateway/src/transport.mjs).
- [Deployment probe](../services/pulse-gateway/src/probe.mjs).
- [Retry regressions](../services/pulse-gateway/test/retry.test.mjs).

The gateway retries an explicit transient 500/502/503/504 once after 500 ms,
within the shared deadline and without replacing the token. It does not hide a
persistent provider failure or substitute a preview for a full recording. OAuth
is sent only to `api.soundcloud.com`, never to the CDN.

The owner can provide the Client ID privately to official support if requested.
Client Secret, access/refresh tokens, credential JSON and signed stream URLs
must not be posted in a public issue.

References: [registration](https://developers.soundcloud.com/docs/api/register-app),
[official OpenAPI](https://github.com/soundcloud/api/blob/master/openapi/api.yaml),
[API access discussion](https://github.com/soundcloud/api/issues/577).
