import { describe, expect, it } from "vitest";
import { authConfig, chatConfig, stocktakeAuth } from "./env.ts";

describe("build env", () => {
  it("has no chat, sign-in or stocktake without the variables", () => {
    expect(chatConfig({})).toBeNull();
    expect(authConfig({ SUPABASE_URL: "https://x.supabase.co" })).toBeNull();
    expect(stocktakeAuth({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "k" })).toBeNull();
  });

  it("reads the chat, with CHAT_PUBLIC=false (or 0/off/no) turning off the bubble for signed-out visitors", () => {
    expect(chatConfig({ CHAT_API_URL: "https://api/chat" })).toEqual({ api: "https://api/chat", publicOff: false });
    for (const v of ["false", "FALSE", " 0 ", "off", "No"]) expect(chatConfig({ CHAT_API_URL: "https://api/chat", CHAT_PUBLIC: v })?.publicOff).toBe(true);
    expect(chatConfig({ CHAT_API_URL: "https://api/chat", CHAT_PUBLIC: "true" })?.publicOff).toBe(false);
  });

  it("drops the trailing slash of the Supabase URL and needs all three values for the stocktake", () => {
    const env = { SUPABASE_URL: "https://x.supabase.co/", SUPABASE_ANON_KEY: "k", STOCKTAKE_API_URL: "https://api/stocktake" };
    expect(authConfig(env)).toEqual({ supabaseUrl: "https://x.supabase.co", supabaseKey: "k" });
    expect(stocktakeAuth(env)).toEqual({ supabaseUrl: "https://x.supabase.co", supabaseKey: "k", api: "https://api/stocktake" });
  });
});
