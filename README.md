# DayGoal

Daily goals (morning), what-I-did log (evening), long-term goals with steps, a per-day knowledge bank, and exact-text search over all of it. Synced across devices with Supabase.

```
pc/        Electron desktop app (Windows, runs in tray)
supabase/  Database schema (run once)
```

## Setup (all free)

1. **Supabase** (free tier): create a project at https://supabase.com.
   - SQL Editor → paste and run `supabase/schema.sql`.
   - Authentication → Sign In / Providers → Email: enabled, and turn **Confirm email** off (no emails are sent; sign-in is email + password).
   - Project Settings → API: copy the **Project URL** and **anon public key** into `pc/renderer/config.js`.
2. **Run the PC app**
   ```
   cd pc
   npm install
   npm start          # dev
   npm run dist       # builds installer in pc/dist/
   ```

## Behaviour
- Closing the window hides to the tray; tray menu → Quit to exit. The installed app starts with Windows (toggle in Settings).
- Morning/evening times are set in Settings and synced to all devices. If the PC was off at that time, you're prompted the next time the app runs that day. "Later" snoozes 30 min.
- Shortcuts: `Ctrl+1..4` views, `Ctrl+F` search, `Ctrl+N` new note, `Ctrl+Enter` save in dialogs.

## Notes
- Supabase free projects pause after ~1 week of no activity (daily use keeps it awake; resume from the dashboard if it happens).
- No in-app password reset yet (it needs email sending), so keep your password somewhere safe.
