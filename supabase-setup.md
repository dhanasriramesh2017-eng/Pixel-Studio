# Supabase Setup Guide for Pixel Studio

Pixel Studio includes built-in persistent SQLite authentication and storage that runs locally out of the box with zero external dependencies.

If you also wish to connect Pixel Studio to **Supabase Cloud**, follow these instructions:

## 1. Create a Supabase Project
1. Go to [https://supabase.com](https://supabase.com) and create an account or log in.
2. Click **New Project**, name it `pixel-studio`, set a secure database password, and choose your preferred region.

## 2. Execute Database Schema
1. Open your Supabase Dashboard and go to the **SQL Editor**.
2. Open the file [`supabase_schema.sql`](file:///c:/Images/supabase_schema.sql) in this repository.
3. Paste its contents into the SQL Editor and click **Run**.
4. This will create:
   - `public.profiles` with automatic user signup trigger.
   - `public.user_images` with Row Level Security (RLS) policies.
   - `public.user_downloads` with Row Level Security (RLS) policies.

## 3. Configure Storage Buckets
1. In the Supabase Dashboard, navigate to **Storage**.
2. Click **New Bucket**:
   - Create bucket `user-uploads` (set as Private).
   - Create bucket `user-downloads` (set as Private).
3. Apply the storage folder policies included at the end of `supabase_schema.sql` so each user can only read/write files under their own `auth.uid()` path.

## 4. Environment Variables
Add your project credentials to an `.env` file or pass them as environment variables:
```bash
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_ANON_KEY=your-anon-public-key
```

When running locally with the built-in server (`node server.js`), all authentication and personal library features operate using the local SQLite database and segregated disk storage in `storage/users/<userId>/` without requiring cloud keys!
