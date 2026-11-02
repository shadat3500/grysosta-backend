# Postman collection

1. In Postman: **Import** → choose `GRYSOSTA-API.postman_collection.json`.
2. Open the collection → **Variables** tab: set `serverUrl` (default `http://localhost:4000`), `adminEmail` and `adminPassword`.
3. Run **3. Auth › Login** — the admin token is saved automatically and used by every admin request.
4. Run **1. Public › Signup — join referral program** to create a referrer (saves `referralCode` and `referrerEmail`).
5. Run **A5 › List** and **A6 › List** to fill `memberId` and `referrerId`. Other IDs (`announcementId`, `draftId`, `saleId`, `emailLogId`, `referrerToken`) are saved by the requests that create them.

You can also run the whole collection top to bottom with the **Collection Runner**.

**Notes**
- **File uploads** (CSV import, images): pick a file in the request's *Body › form-data* field. `EtsySoldOrders-sample.csv` is a small test file. Put a real referral code from *A6 › List* in its *Coupon Code* column to see commissions.
- **Exports:** use **Send and Download** to save the CSV/Excel file.
- **Signup rate limit:** 5 signups per IP per hour (SRS 6.1). If you get `429`, wait or restart the API in development.
- **My Referrals magic link:** locally (no `BREVO_API_KEY`) the token is returned and saved automatically. In production, paste the `token=` value from the email into `magicToken`.
