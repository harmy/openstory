---
title: Settings
description: Configure API keys, passkeys, and account settings
section: User Guide
order: 11
---

Access settings from the user menu in the header. Settings are organized into sections:

## API Keys

Manage your BYOK (Bring Your Own Key) credentials. See [Credits & Billing](/docs/user-guide/credits-and-billing) for details on:

- Fal.ai API key for media generation
- OpenRouter API key or OAuth for LLM access

After connecting via OpenRouter OAuth, the settings page shows a success message. If there's an error, the error details are displayed.

## Passkeys

Manage passwordless authentication via passkeys (WebAuthn). You can:

- **Register new passkeys** — Add hardware keys or biometric authentication
- **View registered passkeys** — See all your registered devices
- **Remove passkeys** — Deregister devices you no longer use

Passkeys provide a secure, passwordless login experience.

## Generation Settings Persistence

While not in the settings page itself, your generation preferences (aspect ratio, selected models, auto-generation toggles) are automatically saved to localStorage. When you create a new sequence, your last-used settings are pre-filled.
