export function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: "⚡ Buy", callback_data: "trade:buy" }, { text: "💰 Sell", callback_data: "trade:sell" }],
      [{ text: "💼 Portfolio", callback_data: "portfolio" }, { text: "🔎 Discover", callback_data: "discover" }],
      [{ text: "👛 Wallet", callback_data: "wallet" }, { text: "💸 Creator fees", callback_data: "fees:refresh" }],
      [{ text: "⚙️ Settings", callback_data: "settings" }]
    ]
  };
}
