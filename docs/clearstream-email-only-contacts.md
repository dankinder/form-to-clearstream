# Email-only contacts in the Clearstream API

Source: message from Clearstream support, received 2026-11-11. This feature was released that
week and is **not in the public API docs** (https://api-docs.clearstream.io) as of that date, so
this file is the reference for how `Code.gs` handles people who give an email but no phone number.
The section "Our notes" at the bottom is ours, not Clearstream's.

---

## Clearstream's message

Contacts no longer need a mobile number. You can create and manage contacts that only have an
email address through the API. Our API docs haven't caught up yet, so here's a summary of what
changed.

### Create an email-only contact

Send email without mobile_number to POST /v1/subscribers.

```json
POST /v1/subscribers

{
  "email": "jane@example.com",
  "first": "Jane",
  "last": "Doe",
  "lists": [123],
  "tags": [456]
}
```

- If a contact with that email already exists, we update it instead of creating a new one. A
  deleted match is restored.
- The contact is opted in right away. double_optin and autoresponse_header/autoresponse_body are
  ignored, since there's no number to text.
- One exception: if the email matches an existing contact that has a mobile number but isn't opted
  in, we treat it like a mobile number request. The confirmation text and autoresponse go out as
  usual.
- If the email address is opted out, the request fails with a 422. override_optouts only applies
  to SMS, so it won't get around this.
- If you send both mobile_number and email, the mobile number is used to find the contact, same as
  before.

### New /contacts endpoints

These endpoints use the contact's id instead of a mobile number, so they work for every contact.

| Action | New endpoint | Request body | Existing endpoint |
| --- | --- | --- | --- |
| List contacts | GET /v1/contacts | | GET /v1/subscribers |
| View a contact | GET /v1/contacts/{id} | | GET /v1/subscribers/{mobile_number} |
| Update a contact | PUT /v1/contacts/{id} | Same fields as before | PUT /v1/subscribers/{mobile_number} |
| Opt out of SMS | DELETE /v1/contacts/{id}/sms | | DELETE /v1/subscribers/{mobile_number} |
| Opt out of email | DELETE /v1/contacts/{id}/email | | DELETE /v1/subscribers/{email} |
| List contacts in a list | GET /v1/lists/{list}/contacts | | GET /v1/lists/{list}/subscribers |
| Add contacts to a list | POST /v1/lists/{list}/contacts | contact_ids (array) | POST /v1/lists/{list}/subscribers |
| Remove a contact from a list | DELETE /v1/lists/{list}/contacts/{id} | | DELETE /v1/lists/{list}/subscribers/{mobile_number} |
| Add a tag to contacts | POST /v1/tags/{tag}/contacts | contact_ids (array) | POST /v1/tags/{tag}/subscribers |
| Add contacts to a workflow | POST /v1/workflows/{workflow}/contacts | contact_ids (array), prevent_repeats | POST /v1/workflows/{workflow}/subscribers |

- The list endpoints take the same filters, sorting and paging as their /subscribers versions.
  filter[search] matches name, email or mobile number.
- The two opt-out endpoints return 204 No Content.
- contact_ids must be a JSON array, like "contact_ids": [101, 102].

### Email addresses on the existing /subscribers endpoints

The /subscribers endpoints still work. Anywhere you used a mobile number, you can now use an email
address instead.

- GET /v1/subscribers/{email}
- PUT /v1/subscribers/{email}
- DELETE /v1/subscribers/{email} opts every contact with that address out of email.
- POST /v1/lists/{list}/subscribers with email in the body.
- DELETE /v1/lists/{list}/subscribers/{email}
- POST /v1/tags/{tag}/subscribers with an emails array. You can send it alongside mobile_numbers.
- POST /v1/workflows/{workflow}/subscribers with email in the body.

Email matching isn't case sensitive. If more than one contact has the same address, we pick one.
Contacts that aren't deleted come first, then contacts without a mobile number.

### Response changes

- mobile_number is null for email-only contacts.
- status is the contact's SMS status. Email-only contacts show "ACTIVE" there even though they
  can't get texts. Use email_status ("ACTIVE" or "OPTOUT") to check whether they can get email.
- GET /v1/subscribers and GET /v1/lists/{list}/subscribers only return contacts with a mobile
  number. Use the /contacts versions to get everyone.

### Limits

- POST /v1/subscribers/batch still requires mobile_number on every row.
- PUT can't remove the email from a contact that has no mobile number. A contact needs at least
  one of the two.
- Email opt-outs can't be reversed through the API. status on PUT only changes the SMS status.

---

## Our notes

### How Code.gs uses this

We use the "minimal" approach: the phone-number flow is unchanged, and the email addresses are
used only when there is no phone, or when the phone lookup finds nobody.

- No phone: `GET /subscribers/{email}`, then `PUT /subscribers/{email}` if found, else
  `POST /subscribers` with no `mobile_number`.
- Phone given but not found in Clearstream, and an email was given: look the email up too. If it
  matches a contact with **no** mobile number (a previous email-only signup), update that contact
  and add the phone, instead of creating a duplicate. If the email matches a contact with a
  *different* mobile number we create a new contact, since that is a different person or a new
  number.
- The email fallback only runs if the phone lookup succeeded (HTTP 200) and found nobody. After a
  failed phone lookup we create the contact as before rather than guessing by email.
- Tagging: `POST /tags/{id}/subscribers` with `emails` for email-matched or email-only contacts,
  `mobile_numbers` otherwise.
- No welcome text for contacts without a phone (nothing to text). The fallback case above does not
  text either: that person has never been texted, and we have not confirmed whether adding a phone
  through PUT opts them into SMS.
- A non-2xx response when creating or updating an email-only contact (for example the 422 for an
  opted-out email) is logged as a warning, and tagging is skipped.

### Not verified yet (not stated in Clearstream's message)

Check these against the real API and update this file when known:

- The response shape of `GET /v1/subscribers/{email}`: a single object or a `data` array, and
  whether it includes `id`. `Code.gs` accepts either.
- Whether `GET /v1/subscribers/{email}` returns 404 or an empty result when nothing matches.
  `Code.gs` treats both as "not found".
- The existing code updates with `PATCH`, but Clearstream's message lists `PUT` for updates, so
  email-based updates use `PUT`. The phone path still uses `PATCH` by id, unchanged.
- Whether `PUT /v1/subscribers/{email}` accepts `mobile_number` (needed to add a phone to an
  email-only contact).
- Whether `POST /v1/subscribers` merges or replaces `lists` on an existing contact. That is why we
  still do our own lookup-and-merge.
