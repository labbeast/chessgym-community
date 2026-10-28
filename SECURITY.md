# Security

ChessGym is currently a local, single-user alpha. It is intended to listen only on loopback and to be used from the same computer. Remote hosting, LAN access and multiple users are not supported by this release. Removing those restrictions changes its security assumptions.

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
