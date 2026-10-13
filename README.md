# Campus Rider

Campus Rider is a responsive NIT Srinagar student delivery web app. It includes Supabase email/password authentication, email confirmation and password recovery, and a protected dashboard. Its initial database setup seeds Gasha Canteen and Cafeteria as active canteens; products are not seeded.
## Run locally

Requirements: Node.js 20.19+ or 22.12+ and an npm-compatible package manager.
```sh
npm install
```
Create a Supabase project (see below), copy `.env.example` to `.env.local`, and set the project URL and public anon/publishable key:

```dotenv
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-or-publishable-key
```
These `VITE_` values are visible in the browser. The anon/publishable key is designed for client use and is restricted by database RLS. Never put a `service_role` key, database password, SMTP password, or other secret in a `VITE_` variable.

In the Supabase dashboard, open **SQL Editor → New query** and run all migration files in timestamp order:

1. `supabase/migrations/20261012000000_initial_campus_rider.sql`
2. `supabase/migrations/20261012010000_dual_role_delivery_workflows.sql`
3. `supabase/migrations/20261013000000_seed_canteens.sql`
4. `supabase/migrations/20261013010000_pickup_chat_quotes.sql`
5. `supabase/migrations/20261014000000_rider_pickup_pricing.sql`
6. `supabase/migrations/20261014010000_pickup_rider_discovery_diagnostics.sql`
7. `supabase/migrations/20261014020000_fix_pickup_settings_jsonb_validation.sql`
8. `supabase/migrations/20261014030000_rider_upi_order_payments.sql`

Then start the app:
```sh
npm run dev
```
Open the local URL printed by Vite. Without Supabase configuration, the welcome page remains usable and the auth screen explains that sign-in needs configuration; it does not accept fake credentials.

## Free deployment with Vercel

The frontend can be deployed on Vercel's free plan and use a Supabase project on its free plan for authentication and the database. Free-plan quotas and terms can change. Real signup/login needs both services configured; deploying the frontend alone does not create accounts.

1. Push this project to a GitHub repository and import it into [Vercel](https://vercel.com/new). Keep the Vite defaults (`npm run build` and `dist`) or set those values in Project Settings → Build and Deployment.
2. In Vercel → Project Settings → Environment Variables, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` using the values from Supabase → Project Settings → API. These are public client settings; never add a Supabase `service_role` key. Set them for Production and Preview as needed, and set `VITE_DEV_BYPASS_AUTH` to `false`.
3. Deploy the project. In Supabase → Authentication → URL Configuration, set **Site URL** to the deployed Vercel origin (for example, `https://your-project.vercel.app`) and add that origin to **Redirect URLs**. Keep `http://localhost:5173` there for local development. Add any Vercel preview origins you plan to use.
4. In Supabase → SQL Editor, run all eight migration files in the order listed above, then confirm email/password sign-in and email confirmation are enabled under Authentication → Providers → Email.
5. Redeploy after changing Vercel environment variables. Test signup with an `@nitsri.ac.in` address, open the confirmation link, then log in. Test password recovery from the deployed origin as well.

`vercel.json` routes browser paths back to the Vite app so auth links and client-side screens load on refresh. Supabase's built-in email sender has restrictive limits; configure a supported SMTP provider in Supabase for dependable verification and recovery emails.

## Supabase configuration
1. Create a project at [Supabase](https://supabase.com/dashboard) and keep its database and API secrets private.
2. In **Authentication → URL Configuration**, add `http://localhost:5173` to the allowed redirect URLs. Add the production origin before deployment.
3. In **Authentication → Providers → Email**, enable email/password sign-in and require email confirmation. Keep confirmation enabled in every deployed environment so accounts cannot sign in before verification.
4. Set the minimum password length to 12 or greater. The client also requires uppercase, lowercase, number, and symbol; provider-side password policy remains authoritative.
5. Configure custom SMTP for dependable verification and recovery mail in production. Supabase's built-in email sender has restrictive delivery/rate limits and is for evaluation, not production traffic.
6. Copy the project URL and anon/publishable key from **Project Settings → API** into `.env.local`. Restart Vite after changing environment variables.
7. Apply all eight files in `supabase/migrations/` in timestamp order in the Supabase SQL editor. The third migration adds Gasha Canteen and Cafeteria as active canteens if they do not already exist. The fourth adds pickup chat and quoting. The fifth adds rider-set pickup charges and administrator-approved fee limits. The sixth adds privacy-preserving diagnostics for why no riders are available. The seventh fixes JSONB validation in rider pickup settings. The eighth adds optional rider UPI settings, private QR storage, and participant-authorized order payment status.

The frontend validates and lowercases/trims addresses for quick feedback. Independently, a `BEFORE INSERT OR UPDATE` trigger on `auth.users` lowercases and rejects any address outside `@nitsri.ac.in`, including direct Auth API requests. The database's `is_verified_nitsri_user()` helper and RLS policies additionally require `email_confirmed_at` before exposing profile/catalog/order data. Verification links are sent by Supabase Auth; an unverified signup does not get dashboard access. Passwords are stored and checked only by Supabase Auth, which uses its managed password hashing. Password reset links return to the app and open the change-password view.
## Data model

The migrations create these tables:
- `canteens`: `id`, `name`, `description`, `location`, `operating_hours` (JSON), `is_active`, timestamps.
- `products`: `id`, `canteen_id`, `name`, `description`, `category`, `price`, `image_url`, `is_available`, timestamps.
- `profiles`: auth user ID, normalized college email, full name, timestamps; provisioned by a database trigger.
- `orders` and `order_items`: customer, canteen, lifecycle status, delivery location, and database-priced item snapshots.
- `rider_profiles`: one-to-one with the student profile; provisioned automatically for every student, with online/offline presence.
- `deliveries`: unique order assignment, pickup/destination, status and completion time.
- `earnings_ledger`: unique per completed delivery. Until rider compensation is configured, completed jobs are recorded as `pending_configuration` with a null amount, not displayed as earnings.
- `delivery_settings`: one private settings row. Set `rider_compensation_per_delivery` only after Campus Rider has decided the real rate; no fee or earnings rate is invented.
- `pickup_locations`: the Canteen, Cafeteria and Gate rendezvous points, including administrator-configured minimum and maximum rider delivery charges.
- `rider_profiles`: also stores each rider's configured INR delivery charge by pickup location.
- `rider_profiles`: optional rider-provided UPI ID and private QR object path, enabled per rider.
- `order_payment_events`: append-only status history for accepted pickup-order payments; visible only to the order's participants.
- `conversations`, `delivery_requests`, `messages`, `quotes` and `quote_items`: participant-scoped rider chats, request history and immutable itemized quote revisions.
- Pickup orders extend `orders` with the accepted quote, pickup point and agreed delivery fee; the amount and item prices are calculated and stored when the customer accepts.

After deciding the real compensation policy, a trusted project administrator can configure the single rate in the Supabase SQL editor, for example: `update public.delivery_settings set rider_compensation_per_delivery = <approved_amount>, updated_at = now() where singleton = true;`. Do not grant this table to app users. The amount is recorded only for deliveries completed after the setting is configured; earlier rows remain pending until deliberately reconciled.

Row-level security is enabled and default table grants are revoked. Verified students can browse active canteens and products, and read only their own profile, orders, delivery assignments, and earnings. Database RPCs derive identity from `auth.uid()`: `place_order` calculates prices from currently available database products; `set_rider_availability` controls legacy delivery availability; pickup availability, eligible rider discovery, message sending, quote creation, quote acceptance and pickup-order status changes use dedicated checked RPCs. Conversations and messages are visible only to the two participants; clients cannot directly insert or edit messages, quotes, orders, delivery assignments or totals.

To let riders set pickup charges, a trusted administrator must first configure the allowed price range for every pickup location in the Supabase SQL editor. Replace each placeholder only with an approved amount; do not paste the placeholders literally:

```sql
update public.pickup_locations
set minimum_rider_delivery_fee = <approved_minimum>,
    maximum_rider_delivery_fee = <approved_maximum>,
    updated_at = now()
where id = 'canteen';
```

Repeat for `cafeteria` and `gate`. The administrator-configured legacy `delivery_fee` column is retained for compatibility but is no longer added to pickup quotes. Each rider sets their own charge within the approved range. Quote totals are calculated in the database, and the agreed charge is snapshotted on acceptance so later rider price changes do not affect existing orders. Applying the pricing migration supersedes any still-proposed quotes made under the previous fixed-fee rule; customers can request a new quote.

The same account can order and deliver; there is no second rider signup. After email verification, a student activates rider mode by selecting supported pickup locations, setting a fee for each location, then choosing **Start Delivering**. New accounts are not automatically activated or made available. The dashboard keeps the catalog and legacy delivery workspace and adds three pickup cards, currently eligible riders, participant-only real-time chat, itemized quote review, and pickup-order tracking. Riders can start or stop accepting new requests. A student must be verified, within the administrator-approved fee range, and under their active workload capacity to appear; riders cannot quote while offline or at capacity. Going offline does not cancel accepted orders or close existing conversations.

UPI QR payments are optional, direct rider-to-customer payments; Campus Rider does not process, collect, or automatically verify transfers. A verified rider can configure a UPI ID, upload a PNG/JPG/WebP QR (maximum 5 MB), or both in **Payment Settings**. The QR image is stored in a private bucket. When an order has an accepted quote, the app generates an order-specific UPI URI and QR locally from the rider-provided UPI ID and the exact accepted database total; if only a static QR is configured, customers must verify the recipient and enter the displayed exact amount themselves. UPI ownership is not verified by Campus Rider. Customers may report that they paid, but this remains unverified until the assigned rider checks their UPI app and confirms receipt. Payment status history is retained for the order participants. No screenshot, customer report, QR display, or UPI-app launch is treated as proof of payment; automated payment verification requires a real payment provider and authenticated webhook integration.

To add researched listings later, create canteen/product records through an admin-only backend or controlled SQL migration; keep `is_active` / `is_available` false until reviewed. A product belongs to a canteen through `products.canteen_id`; orders retain item-name and price snapshots. Do not grant public client writes for catalog, order, delivery, or ledger tables.

## Commands
```sh
npm run dev
npm run build
npm run lint
```
The project uses React 19, TypeScript, Vite, Lucide icons, and `@supabase/supabase-js`.
