# GS1 Vault Pro

Offline PWA for pharmacy / retail barcode workflows.

## Key logic
- Company barcode is the primary identity key.
- GTIN is separate and never auto-treated as the same field.
- If a scanned 13/14-digit code is **not** found in company barcode, it is checked as GTIN.
- GS1 AIs parsed: `(01) GTIN`, `(17) Expiry`, `(10) Batch`, `(21) Serial`, `(30)/(37) Quantity`.
- Fuzzy description review only shows suggestions at **85%+** similarity.
- If uncertain, fields stay blank.

## Seed data
The bundled seed file is based on the uploaded `PHARMASCAN DATABASE V3 2.csv`.

## Deploy
Host on HTTPS (GitHub Pages is fine), open once online to cache assets, then install.
