// Drives Code.gs's onFormSubmit with a stubbed UrlFetchApp so we can assert on the Clearstream
// requests it makes. Email-only behavior is described in docs/clearstream-email-only-contacts.md.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const BASE_URL = "https://api.getclearstream.com/v1";
const SOURCE = fs.readFileSync(path.join(__dirname, "..", "Code.gs"), "utf8");
const SHEET_NAME = "Responses";
const TAG_ID = 7;

const PHONE = "+15551234567";
const EMAIL = "Jane@Example.com";
const ENCODED_EMAIL = encodeURIComponent(EMAIL);

function defaultResponse(method, route) {
  switch (true) {
    case method === "GET" && route.startsWith("/subscribers?mobile_number="):
      return [200, { data: [] }];
    case method === "GET" && route.startsWith("/subscribers/"):
      return [404, { message: "Not found" }];
    case method === "GET" && route.startsWith("/tags?"):
      return [200, { data: [{ id: TAG_ID, name: `Signup: ${SHEET_NAME}` }] }];
    default:
      return [200, { data: {} }];
  }
}

// overrides maps "METHOD /route" (route is the URL minus the base URL) to [statusCode, body].
function submitForm({ first = "Jane", last = "Doe", phone = "", email = "", interests = "", overrides = {} }) {
  const requests = [];
  const logs = { warn: [], error: [] };

  const UrlFetchApp = {
    fetch(url, options) {
      const method = options.method.toUpperCase();
      const route = url.slice(BASE_URL.length);
      requests.push({ method, route, body: options.payload ? JSON.parse(options.payload) : undefined });
      const [code, body] = overrides[`${method} ${route}`] || defaultResponse(method, route);
      return { getResponseCode: () => code, getContentText: () => (typeof body === "string" ? body : JSON.stringify(body)) };
    },
  };
  const console = {
    log() {},
    warn: (...args) => logs.warn.push(args.join(" ")),
    error: (...args) => logs.error.push(args.join(" ")),
  };

  const context = vm.createContext({ UrlFetchApp, console });
  vm.runInContext(SOURCE, context);

  context.onFormSubmit({
    namedValues: {
      "First name": [first],
      "Last name": [last],
      "Email": [email],
      "Phone number": [phone],
      "What would you like to be contacted about?": [interests],
    },
    range: { getSheet: () => ({ getName: () => SHEET_NAME }) },
  });

  return { requests, logs };
}

const find = (requests, method, route) => requests.find((r) => r.method === method && r.route === route);
const tagRequest = (requests) => find(requests, "POST", `/tags/${TAG_ID}/subscribers`);
const textRequests = (requests) => requests.filter((r) => r.route === "/texts");
const writes = (requests) =>
  requests.filter((r) => ["POST", "PUT", "PATCH"].includes(r.method) && r.route.startsWith("/subscribers"));

test("email-only signup that is not found creates a contact without a mobile number and tags it by email", () => {
  const { requests } = submitForm({ email: EMAIL, interests: "Workshops, Church" });

  const post = find(requests, "POST", "/subscribers");
  assert.ok(find(requests, "GET", `/subscribers/${ENCODED_EMAIL}`));
  assert.equal(post.body.email, EMAIL);
  assert.equal("mobile_number" in post.body, false);
  assert.deepEqual(post.body.lists, [333208, 338088]);
  assert.deepEqual(tagRequest(requests).body, { emails: [EMAIL] });
  assert.equal(textRequests(requests).length, 0);
});

test("email-only signup that already exists is updated by email with lists merged", () => {
  const existing = { id: 5, email: EMAIL, first: "Jane", last: "Doe", mobile_number: null, lists: [{ id: 111 }] };
  const { requests } = submitForm({
    email: EMAIL,
    interests: "Workshops",
    overrides: { [`GET /subscribers/${ENCODED_EMAIL}`]: [200, { data: existing }] },
  });

  const put = find(requests, "PUT", `/subscribers/${ENCODED_EMAIL}`);
  assert.deepEqual(put.body.lists, [111, 333208]);
  assert.equal("mobile_number" in put.body, false);
  assert.equal(writes(requests).length, 1);
  assert.deepEqual(tagRequest(requests).body, { emails: [EMAIL] });
  assert.equal(textRequests(requests).length, 0);
});

test("email lookup also accepts a data array response", () => {
  const existing = { id: 5, email: EMAIL, mobile_number: null, lists: [] };
  const { requests } = submitForm({
    email: EMAIL,
    overrides: { [`GET /subscribers/${ENCODED_EMAIL}`]: [200, { data: [existing] }] },
  });

  assert.ok(find(requests, "PUT", `/subscribers/${ENCODED_EMAIL}`));
  assert.equal(find(requests, "POST", "/subscribers"), undefined);
});

test("email addresses with special characters are URL-encoded in the lookup path", () => {
  const { requests } = submitForm({ email: "a+b@example.com" });

  assert.ok(find(requests, "GET", "/subscribers/a%2Bb%40example.com"));
});

test("phone not found but email matches a contact without a mobile number updates it and adds the phone", () => {
  const emailOnlyContact = { id: 5, email: EMAIL, mobile_number: null, lists: [] };
  const { requests } = submitForm({
    phone: PHONE,
    email: EMAIL,
    overrides: { [`GET /subscribers/${ENCODED_EMAIL}`]: [200, { data: emailOnlyContact }] },
  });

  const put = find(requests, "PUT", `/subscribers/${ENCODED_EMAIL}`);
  assert.equal(put.body.mobile_number, PHONE);
  assert.equal(writes(requests).length, 1);
  assert.deepEqual(tagRequest(requests).body, { emails: [EMAIL] });
  assert.equal(textRequests(requests).length, 0);
});

test("phone not found and email matches a contact with a different mobile number creates a new contact", () => {
  const otherPerson = { id: 5, email: EMAIL, mobile_number: "+15559999999", lists: [] };
  const { requests } = submitForm({
    phone: PHONE,
    email: EMAIL,
    overrides: { [`GET /subscribers/${ENCODED_EMAIL}`]: [200, { data: otherPerson }] },
  });

  const post = find(requests, "POST", "/subscribers");
  assert.equal(post.body.mobile_number, PHONE);
  assert.equal(post.body.email, EMAIL);
  assert.equal(writes(requests).length, 1);
  assert.deepEqual(tagRequest(requests).body, { mobile_numbers: [PHONE] });
  assert.equal(textRequests(requests).length, 1);
});

test("opted-out email-only signup logs a warning and skips tagging without throwing", () => {
  const { requests, logs } = submitForm({
    email: EMAIL,
    overrides: { "POST /subscribers": [422, { message: "The email address is opted out" }] },
  });

  assert.ok(logs.warn.length > 0);
  assert.equal(requests.some((r) => r.route.startsWith("/tags")), false);
  assert.equal(textRequests(requests).length, 0);
});

test("existing phone signup is still patched by id and tagged by mobile number", () => {
  const existing = { id: 99, first: "Jane", last: "Doe", mobile_number: PHONE, email: null, lists: [{ id: 1 }] };
  const { requests } = submitForm({
    phone: PHONE,
    email: EMAIL,
    interests: "Church",
    overrides: { [`GET /subscribers?mobile_number=${encodeURIComponent(PHONE)}`]: [200, { data: [existing] }] },
  });

  const patch = find(requests, "PATCH", "/subscribers/99");
  assert.deepEqual(patch.body.lists, [1, 338088]);
  assert.equal(patch.body.email, EMAIL);
  assert.equal(requests.some((r) => r.route.startsWith(`/subscribers/${ENCODED_EMAIL}`)), false);
  assert.deepEqual(tagRequest(requests).body, { mobile_numbers: [PHONE] });
  assert.equal(textRequests(requests).length, 0);
});

test("new phone-only signup is created, tagged by mobile number, and sent a welcome text", () => {
  const { requests } = submitForm({ phone: PHONE, interests: "Fun Events" });

  const post = find(requests, "POST", "/subscribers");
  assert.equal(post.body.mobile_number, PHONE);
  assert.equal("email" in post.body, false);
  assert.deepEqual(tagRequest(requests).body, { mobile_numbers: [PHONE] });
  assert.equal(textRequests(requests)[0].body.to, PHONE);
});

test("malformed email lookup response is treated as not found and the contact is created", () => {
  const { requests } = submitForm({
    email: EMAIL,
    overrides: { [`GET /subscribers/${ENCODED_EMAIL}`]: [200, "<html>bad gateway</html>"] },
  });

  assert.ok(find(requests, "POST", "/subscribers"));
});

test("failed phone lookup does not fall back to guessing by email", () => {
  const emailOnlyContact = { id: 5, email: EMAIL, mobile_number: null, lists: [] };
  const { requests } = submitForm({
    phone: PHONE,
    email: EMAIL,
    overrides: {
      [`GET /subscribers?mobile_number=${encodeURIComponent(PHONE)}`]: [500, { message: "oops" }],
      [`GET /subscribers/${ENCODED_EMAIL}`]: [200, { data: emailOnlyContact }],
    },
  });

  assert.equal(requests.some((r) => r.route.startsWith(`/subscribers/${ENCODED_EMAIL}`)), false);
  assert.ok(find(requests, "POST", "/subscribers"));
});

test("submission with neither phone nor email makes no requests", () => {
  const { requests } = submitForm({});

  assert.deepEqual(requests, []);
});
