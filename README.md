# form-to-clearstream

A Google Apps Script that connects a Google Form to [Clearstream](https://getclearstream.com/):
each form submission becomes a Clearstream subscriber, gets tagged by which form/event they
signed up from, and new subscribers receive a welcome text.

See the comment block at the top of [`Code.gs`](./Code.gs) for how it works, what you need to
configure, and how to set up the trigger in Apps Script.

`Code_phone_only.gs` is an alternate variant for forms that always require a phone number
(simpler, no email-only fallback).

## Deploying

Real API keys are kept out of git. Create `env/production.env` with your Clearstream API key,
then run `./deploy.sh` (or `./deploy.sh Code_phone_only.gs`) to copy a deploy-ready version of the
script to your clipboard, ready to paste into the Apps Script editor. See `Code.gs` for details.
