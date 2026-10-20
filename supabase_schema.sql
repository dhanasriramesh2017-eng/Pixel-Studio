-- =====================================================================
-- Pixel Studio — Supabase Cloud Database & Storage Schema
-- =====================================================================
-- This script configures Postgres tables, Row Level Security (RLS)
-- policies, and storage bucket security if deploying to Supabase.

-- 1. Profiles Table (extends Supabase auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS on profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id);

-- Trigger to auto-create profile on auth.users signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1))
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- 2. User Uploaded Images Table
CREATE TABLE IF NOT EXISTS public.user_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  width INTEGER DEFAULT 0,
  height INTEGER DEFAULT 0,
  size_bytes BIGINT DEFAULT 0,
  mime_type TEXT DEFAULT 'image/png',
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS on user_images
ALTER TABLE public.user_images ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own uploaded images"
  ON public.user_images FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own uploaded images"
  ON public.user_images FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own uploaded images"
  ON public.user_images FOR DELETE
  USING (auth.uid() = user_id);

-- 3. User Download History Table
CREATE TABLE IF NOT EXISTS public.user_downloads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  operation TEXT NOT NULL,
  format TEXT NOT NULL, -- 'png' or 'txt'
  width INTEGER DEFAULT 0,
  height INTEGER DEFAULT 0,
  size_bytes BIGINT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS on user_downloads
ALTER TABLE public.user_downloads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own download history"
  ON public.user_downloads FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own downloads"
  ON public.user_downloads FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete items from their download history"
  ON public.user_downloads FOR DELETE
  USING (auth.uid() = user_id);

-- 4. Supabase Storage Buckets
-- Run this in the Supabase SQL editor or create via Supabase Dashboard > Storage:
-- INSERT INTO storage.buckets (id, name, public) VALUES ('user-uploads', 'user-uploads', false);
-- INSERT INTO storage.buckets (id, name, public) VALUES ('user-downloads', 'user-downloads', false);

-- Storage bucket RLS Policies:
-- Allow authenticated users to upload and read only within their own folder: (folder name matches user_id)
-- CREATE POLICY "User Uploads - Access Own Folder" ON storage.objects
--   FOR ALL USING (bucket_id = 'user-uploads' AND auth.uid()::text = (storage.foldername(name))[1])
--   WITH CHECK (bucket_id = 'user-uploads' AND auth.uid()::text = (storage.foldername(name))[1]);

-- CREATE POLICY "User Downloads - Access Own Folder" ON storage.objects
--   FOR ALL USING (bucket_id = 'user-downloads' AND auth.uid()::text = (storage.foldername(name))[1])
--   WITH CHECK (bucket_id = 'user-downloads' AND auth.uid()::text = (storage.foldername(name))[1]);
