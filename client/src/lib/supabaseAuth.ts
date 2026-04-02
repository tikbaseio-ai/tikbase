import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://ntapskfgodvynlfyulnv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50YXBza2Znb2R2eW5sZnl1bG52Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MzEyNzUsImV4cCI6MjA4OTIwNzI3NX0.jOA-9kwBrOsfc8uqFFcyp0PajoKl9HQcRmaliYELBQo';

export const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
