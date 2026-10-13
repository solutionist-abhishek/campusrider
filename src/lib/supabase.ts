import { createClient } from '@supabase/supabase-js'

const projectUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const publicAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()

export const supabase = projectUrl && publicAnonKey
  ? createClient(projectUrl, publicAnonKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      persistSession: true,
    },
  })
  : null