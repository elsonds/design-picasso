// KV wrapper targeting the correct table for this Supabase project.
// The auto-generated kv_store.tsx references an old table name, so this
// module provides the same interface against kv_store_1a0af268.

import { createClient } from "jsr:@supabase/supabase-js@2.49.8";

const TABLE = "kv_store_1a0af268";

const client = () =>
  createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

export const set = async (key: string, value: any): Promise<void> => {
  const supabase = client();
  const { error } = await supabase.from(TABLE).upsert({ key, value });
  if (error) throw new Error(error.message);
};

export const get = async (key: string): Promise<any> => {
  const supabase = client();
  const { data, error } = await supabase
    .from(TABLE)
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.value;
};

export const del = async (key: string): Promise<void> => {
  const supabase = client();
  const { error } = await supabase.from(TABLE).delete().eq("key", key);
  if (error) throw new Error(error.message);
};

export const mset = async (keys: string[], values: any[]): Promise<void> => {
  const supabase = client();
  const { error } = await supabase
    .from(TABLE)
    .upsert(keys.map((k, i) => ({ key: k, value: values[i] })));
  if (error) throw new Error(error.message);
};

export const mget = async (keys: string[]): Promise<any[]> => {
  const supabase = client();
  const { data, error } = await supabase
    .from(TABLE)
    .select("value")
    .in("key", keys);
  if (error) throw new Error(error.message);
  return data?.map((d) => d.value) ?? [];
};

export const mdel = async (keys: string[]): Promise<void> => {
  const supabase = client();
  const { error } = await supabase.from(TABLE).delete().in("key", keys);
  if (error) throw new Error(error.message);
};

export const getByPrefix = async (prefix: string): Promise<any[]> => {
  const supabase = client();
  const { data, error } = await supabase
    .from(TABLE)
    .select("key, value")
    .like("key", prefix + "%");
  if (error) throw new Error(error.message);
  return data?.map((d) => d.value) ?? [];
};
