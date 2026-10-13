# Campus Rider

Campus Rider is a responsive NIT Srinagar student delivery web app. The initial release includes a welcome page, Supabase email/password authentication, email confirmation and password recovery, and a protected empty dashboard. Canteen and product listings intentionally contain no sample data.
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

In the Supabase dashboard, open **SQL Editor → New query** and run both migration files in timestamp order:

1. `supabase/migrations/20261012000000_initial_campus_rider.sql`
2. `supabase/migrations/20261012010000_dual_role_delivery_workflows.sql`

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
4. In Supabase → SQL Editor, run both migration files in the order listed above, then confirm email/password sign-in and email confirmation are enabled under Authentication → Providers → Email.
5. Redeploy after changing Vercel environment variables. Test signup with an `@nitsri.ac.in` address, open the confirmation link, then log in. Test password recovery from the deployed origin as well.

`vercel.json` routes browser paths back to the Vite app so auth links and client-side screens load on refresh. Supabase's built-in email sender has restrictive limits; configure a supported SMTP provider in Supabase for dependable verification and recovery emails.

## Supabase configuration
1. Create a project at [Supabase](https://supabase.com/dashboard) and keep its database and API secrets private.
2. In **Authentication → URL Configuration**, add `http://localhost:5173` to the allowed redirect URLs. Add the production origin before deployment.
3. In **Authentication → Providers → Email**, enable email/password sign-in and require email confirmation. Keep confirmation enabled in every deployed environment so accounts cannot sign in before verification.
4. Set the minimum password length to 12 or greater. The client also requires uppercase, lowercase, number, and symbol; provider-side password policy remains authoritative.
5. Configure custom SMTP for dependable verification and recovery mail in production. Supabase's built-in email sender has restrictive delivery/rate limits and is for evaluation, not production traffic.
6. Copy the project URL and anon/publishable key from **Project Settings → API** into `.env.local`. Restart Vite after changing environment variables.
7. Apply both files in `supabase/migrations/` in timestamp order in the Supabase SQL editor.

The frontend validates and lowercases/trims addresses for quick feedback. Independently, a `BEFORE INSERT OR UPDATE` trigger on `auth.users` lowercases and rejects any address outside `@nitsri.ac.in`, including direct Auth API requests. The database's `is_verified_nitsri_user()` helper and RLS policies additionally require `email_confirmed_at` before exposing profile/catalog/order data. Verification links are sent by Supabase Auth; an unverified signup does not get dashboard access. Passwords are stored and checked only by Supabase Auth, which uses its managed password hashing. Password reset links return to the app and open the change-password view.
## Data model

The migrations create these empty tables:
- `canteens`: `id`, `name`, `description`, `location`, `operating_hours` (JSON), `is_active`, timestamps.
- `products`: `id`, `canteen_id`, `name`, `description`, `category`, `price`, `image_url`, `is_available`, timestamps.
- `profiles`: auth user ID, normalized college email, full name, timestamps; provisioned by a database trigger.
- `orders` and `order_items`: customer, canteen, lifecycle status, delivery location, and database-priced item snapshots.
- `rider_profiles`: one-to-one with the student profile; provisioned automatically for every student, with online/offline presence.
- `deliveries`: unique order assignment, pickup/destination, status and completion time.
- `earnings_ledger`: unique per completed delivery. Until rider compensation is configured, completed jobs are recorded as `pending_configuration` with a null amount, not displayed as earnings.
- `delivery_settings`: one private settings row. Set `rider_compensation_per_delivery` only after Campus Rider has decided the real rate; no fee or earnings rate is invented.

After deciding the real compensation policy, a trusted project administrator can configure the single rate in the Supabase SQL editor, for example: `update public.delivery_settings set rider_compensation_per_delivery = <approved_amount>, updated_at = now() where singleton = true;`. Do not grant this table to app users. The amount is recorded only for deliveries completed after the setting is configured; earlier rows remain pending until deliberately reconciled.

Row-level security is enabled and default table grants are revoked. Verified students can browse active canteens and products, and read only their own profile, orders, delivery assignments, and earnings. Database RPCs derive identity from `auth.uid()`: `place_order` calculates prices from currently available database products; `set_rider_availability` controls online presence; `accept_delivery` atomically claims one available job and excludes its customer; and `update_delivery_status` allows only assigned riders to move accepted → picked up → delivered. Completion inserts one unique ledger row. Direct client writes to order totals, assignments, status, and earnings are not granted.

The same account can order and deliver; there is no second rider signup. The dashboard loads real catalog/order/delivery data after login. With no active canteens it shows “No canteens available yet. Campus Rider is preparing to launch.” With no rider requests it shows “No deliveries available right now. Go online to receive eligible delivery opportunities.” A student must be online to see/accept opportunities, cannot accept their own order, and cannot update another rider’s delivery.

There is no payment provider configured. The order panel states that no payment is collected. To add researched listings later, create canteen/product records through an admin-only backend or controlled SQL migration; keep `is_active` / `is_available` false until reviewed. A product belongs to a canteen through `products.canteen_id`; orders retain item-name and price snapshots. Do not grant public client writes for catalog, order, delivery, or ledger tables.

## Commands
```sh
npm run dev
npm run build
npm run lint
```
The project uses React 19, TypeScript, Vite, Lucide icons, and `@supabase/supabase-js`.
