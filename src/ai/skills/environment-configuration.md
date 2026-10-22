---
name: environment-configuration
description: Inspect, register or update runtime settings and provider credentials for a requested configuration task.
---
Use only for relevant configuration work, not every product discussion. Inspect existing settings before changing them. Preserve user-selected providers and existing secrets. Load preview-operations when runtime diagnosis or restart verification is needed; source repairs belong in ticket delivery.

## Fill development settings yourself
In a development preview or test environment you own the app's internal settings. When the app needs them, set them with setEnvVar instead of asking the user:
- **Generated values**: session secrets, shared secrets, internal usernames and passwords, signing keys. Use long random values (32+ characters) and mark them secret.
- **Switches and defaults**: feature, test and approval toggles a test needs (set them on), and sensible defaults for names, schedules, limits and retention.
- **Preview URLs**: addresses of the preview's own web app and workers come from the running preview (getPreviewDiagnostics); set them, don't ask for them.

Ask the user only for what you cannot produce: third-party credentials (provider API keys, account IDs, phone numbers) and actions in their own provider account. Ask for those in one short message; never send a list of internal settings to fill in.

After setting values, restart the preview so they apply, verify the change, and save what you set (and why) to Notes. Never overwrite a value the user entered. Production settings are different: there, confirm before changing anything.
