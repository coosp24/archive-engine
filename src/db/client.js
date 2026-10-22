import { createClient } from "@supabase/supabase-js";

// The archive's tables are read-only to everyone else under RLS; the engine
// writes with the secret key, which bypasses it. Safe here — the engine only
// runs locally or on CI, never in a browser.
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;

if (!url || !key) {
  throw new Error("Set SUPABASE_URL and SUPABASE_SECRET_KEY in .env");
}

const supabase = createClient(url, key, {
  auth: { persistSession: false },
});

export default supabase;
