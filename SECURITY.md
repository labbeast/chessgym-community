# Security

ChessGym is a single-user alpha. By default it listens only on loopback, and access on the host computer requires no account or login. Optional private access permits paired devices on a trusted LAN or private Tailscale network. It is disabled until the owner enables it locally and restarts the application.

Private access requires a strong pairing secret and a signed, expiring HttpOnly cookie. Private client addresses, exact detected host IPs and browser origins are checked; forwarding headers do not grant access. Enabling, disabling and rotating access are restricted to local requests. Revoke devices to invalidate existing cookies and pairing links. Pairing links and the access configuration contain credentials and must not be posted in issues or screenshots.

Direct LAN HTTP is not encrypted; use it only on a trusted network. Tailscale encrypts its device-to-device transport. Public Internet hosting, router port forwarding and Tailscale Funnel are outside the supported access model. Do not remove the address, origin or pairing checks to make a public reverse proxy work.

## Report a vulnerability privately

Please do not publish exploit details, credentials or affected personal data in a public issue or pull request.

If GitHub private vulnerability reporting is available for this repository, use **Security → Report a vulnerability** at:

https://github.com/labbeast/chessgym-community/security/advisories/new

If that option is unavailable, open a general issue requesting a private contact, without including vulnerability details. Wait for a private reporting channel before sharing the technical information. Private reporting availability is being configured as part of the community release.

A useful private report includes the affected version, the required conditions, concise reproduction steps, the impact and any proposed fix. Redact tokens and use a minimal example rather than a personal backup.

## Supported versions

During the alpha period, security fixes will target the latest community release and current main branch. There is no commitment to maintain older alpha versions. Keep a verified personal backup before updating.

## Local data and external resources

Personal backups, data/, logs and downloaded collections may contain private information. Do not attach them unreviewed to reports or commit them to a public fork. Install engines and models from trusted sources; they execute locally. Review the separate licences and requirements of optional resources.
