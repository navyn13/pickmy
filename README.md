# Pickmy — WhatsApp outreach + auto-reply bot

Excel → WhatsApp first message → live replies → Gemini answers from `business.md` → you take over from a dashboard when needed.

## Setup
```bash
npm install
cp .env.example .env      # set GEMINI_API_KEY, DEFAULT_COUNTRY_CODE
npm start                 # dashboard on http://localhost:3001
```
1. Click the **WhatsApp** status (top bar) and scan the QR (WhatsApp → Linked devices). The session is saved in `.wwebjs_auth/`.
2. Edit **business.md** (top bar) with your services, prices, timings, location, FAQs.
3. Review **Settings** (messages, daily limit, delays, follow-ups, approval mode).
4. **Upload Excel** (.xlsx/.csv; column named phone/mobile/number, optional name column).
5. **Start campaign**.

## How it works
- Numbers are cleaned (country code added, duplicates removed) and stored in SQLite (`data/bot.db`).
- Statuses: NEW → SENT → REPLIED / NEEDS_HUMAN / NO_RESPONSE / DONE (+ STOPPED, INVALID).
- First messages: random 20–60 s delay, daily limit. Follow-ups every N minutes up to a max, then NO_RESPONSE.
- Replies come from Gemini using only `business.md`; unknown → holding message + NEEDS_HUMAN (bot pauses).
- Customer says STOP → bot stops. Asks for a human → hand-off.
- Messages you send (dashboard or phone) auto-pause the bot for that chat; untick "Pause bot" to resume.
- Approval mode: the bot drafts, you edit/approve.

**Risk:** this uses an unofficial WhatsApp Web client — against WhatsApp's ToS, the number can be banned. Use a spare number, start small, message only people who agreed to hear from you.
