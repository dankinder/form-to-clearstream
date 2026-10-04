/*
 * form-to-clearstream
 * ====================
 * Google Apps Script bound to a Google Form (via its response Spreadsheet) that pushes each new
 * form submission into Clearstream as a subscriber, tags them by which sheet/event they signed up
 * from, and sends a welcome text to brand-new subscribers.
 *
 * HOW IT WORKS
 * ------------
 * 1. A Google Form writes each submission as a new row into a response Spreadsheet.
 * 2. An "On form submit" trigger (see SETUP below) calls onFormSubmit(e) for every new row.
 * 3. The script reads the submitted fields (first/last name, email, phone, interests) by matching
 *    column headers against the keywords in FIELD_KEYWORDS below — this makes it tolerant of exact
 *    question wording changes in the form.
 * 4. If a phone number was given, it looks up the subscriber in Clearstream by mobile number. If
 *    found, it updates (PATCH) their info and merges list subscriptions; otherwise it creates
 *    (POST) a new subscriber.
 * 5. The sheet name (e.g. "8.22 Detroit Outing") is used to find-or-create a Clearstream tag
 *    (e.g. "Signup: 8.22 Detroit Outing") and apply it to the subscriber, so you can tell which
 *    event/form each signup came from.
 * 6. Brand-new subscribers (with a phone number) are sent a one-time welcome SMS.
 *
 * WHAT YOU NEED TO POPULATE
 * --------------------------
 * Edit the CONFIG block directly below this comment:
 *   - CLEARSTREAM_API_KEY: left as the placeholder "__CLEARSTREAM_API_KEY__" in this file — never
 *     paste a real key here. Instead, put it in env/production.env (see below) and let deploy.sh
 *     substitute it in at deploy time.
 *   - CLEARSTREAM_BASE_URL: usually fine to leave as-is.
 *   - INTEREST_LIST_MAPPING: maps the text of each form checkbox/option to a Clearstream List ID.
 *     Update the keys to match your form's interest options, and the values to your List IDs
 *     (Clearstream dashboard → Lists → open a list → the ID is in the URL).
 *   - FIELD_KEYWORDS: lowercase substrings used to find the right form column for each piece of
 *     info. Update these if your form's question wording doesn't contain these words.
 *   - WELCOME_TEXT_MESSAGE: the SMS sent to new subscribers. Update the group/organization name.
 *   - SIGNUP_TAG_PREFIX: prefix used when building the per-sheet tag name in Clearstream.
 *
 * SETUP
 * -----
 * 1. Create env/production.env with a single line: CLEARSTREAM_API_KEY=<your real key>
 *    (Clearstream dashboard → Settings → API). This file is gitignored and never committed.
 * 2. Fill in the rest of the CONFIG block below with your own values (see above).
 * 3. Run ./deploy.sh — it substitutes your real API key into Code.gs and copies the result to
 *    your clipboard. Nothing with the real key touches disk outside of env/production.env.
 * 4. Open your Google Form's response Spreadsheet → Extensions → Apps Script, and paste the
 *    clipboard contents in as Code.gs.
 * 5. In the Apps Script editor, go to Triggers (clock icon) → Add Trigger:
 *      - Choose which function to run: onFormSubmit
 *      - Select event source: From spreadsheet
 *      - Select event type: On form submit
 * 6. Submit a test response through the form and check Executions (in Apps Script) for logs to
 *    confirm it reached Clearstream as expected.
 */

// ======================= CONFIG — fill these in for your own form/account =======================

// Clearstream API credentials and base URL (Clearstream dashboard → Settings → API).
// CLEARSTREAM_API_KEY is left as a placeholder here so the real key never gets committed to git —
// deploy.sh substitutes in the real value (from env/production.env) before pasting into Apps Script.
const CLEARSTREAM_API_KEY = "__CLEARSTREAM_API_KEY__";
const CLEARSTREAM_BASE_URL = "https://api.getclearstream.com/v1";

// Maps form interest option text (case-insensitive "contains" match) to Clearstream List IDs.
const INTEREST_LIST_MAPPING = {
  "Bible Discussion": 329652,
  "Workshops": 333208,
  "Fun Events": 357670,
  "Church": 338088
};

// Lowercase substrings used to find each field's column, regardless of the form's exact wording.
const FIELD_KEYWORDS = {
  interests: "contacted about",
  firstName: "first name",
  lastName: "last name",
  email: "email",
  phone: "phone"
};

// One-time SMS sent to brand-new subscribers (only if a phone number was provided).
const WELCOME_TEXT_MESSAGE =
  "Welcome to the Michigan International Student Ministry text group, we'll send you updates from this number!\n\nReply STOP to opt out";

// Prefix used to build the per-sheet signup tag, e.g. "Signup: 8.22 Detroit Outing".
const SIGNUP_TAG_PREFIX = "Signup: ";

// ===================================================================================================

function onFormSubmit(e) {
  console.log("Script triggered. Raw namedValues:", JSON.stringify(e.namedValues));

  const namedValues = e.namedValues;

  // The sheet name is used to tag the signup source (e.g. "8.22 Detroit Outing" → "Signup: 8.22 Detroit Outing")
  const sheetName = e.range.getSheet().getName();
  const signupTagName = SIGNUP_TAG_PREFIX + sheetName;
  console.log("Sheet name:", sheetName, "→ Tag name:", signupTagName);

  // 1. Helper function: case-insensitive check that skips empty fields
  function getFieldValueByContains(substring) {
    const search = substring.toLowerCase();
    const headers = Object.keys(namedValues);
    
    for (const header of headers) {
      if (header.toLowerCase().includes(search)) {
        for (const val of namedValues[header]) {
          const cleanVal = val ? val.trim() : "";
          if (cleanVal.length > 0) {
            console.log(`Matched header for '${substring}': Found in column '${header}' with value '${cleanVal}'`);
            return cleanVal; 
          }
        }
      }
    }
    console.log(`Warning: Could not find any populated column matching '${substring}'`);
    return ""; 
  }

  // 2. Extract interests and map to list IDs (if any were selected)
  const interestsRaw = getFieldValueByContains(FIELD_KEYWORDS.interests);
  const selectedInterests = interestsRaw ? interestsRaw.split(",").map(s => s.trim()) : [];
  console.log("Parsed selected interests array:", selectedInterests);

  // 3. Map form string values to Clearstream List IDs (Case-insensitive Contains)
  const newListIds = [];
  
  selectedInterests.forEach(interest => {
    const interestLower = interest.toLowerCase();
    let matched = false;
    
    for (const [keyword, listId] of Object.entries(INTEREST_LIST_MAPPING)) {
      if (interestLower.includes(keyword.toLowerCase())) {
        if (!newListIds.includes(listId)) { // Prevent duplicate IDs
          newListIds.push(listId);
        }
        matched = true;
        console.log(`Matched list! Form interest '${interest}' contains '${keyword}'. Added ID: ${listId}`);
      }
    }
    
    if (!matched) {
      console.log(`Notice: Form interest '${interest}' did not contain any keyword from INTEREST_LIST_MAPPING.`);
    }
  });
  
  console.log("Mapped List IDs to add:", newListIds);

  // 4. Extract User Info
  const firstName = getFieldValueByContains(FIELD_KEYWORDS.firstName);
  const lastName = getFieldValueByContains(FIELD_KEYWORDS.lastName);
  const email = getFieldValueByContains(FIELD_KEYWORDS.email);

  const phone = getFieldValueByContains(FIELD_KEYWORDS.phone);
  
  if (!phone && !email) {
    console.log("EXITING EARLY: Both Phone and Email are missing. Cannot create a subscriber.");
    return;
  }

  // 5. Prepare Clearstream API Configuration
  const apiHeaders = {
    "X-Api-Key": CLEARSTREAM_API_KEY,
    "Content-Type": "application/json"
  };

  try {
    let isNewSubscriber = true;
    let existingSubscriber = null;

    // 6. Check if subscriber already exists (ONLY if phone is provided)
    if (phone) {
      console.log(`Making GET request to check subscriber by phone: ${phone}`);
      const searchResponse = UrlFetchApp.fetch(`${CLEARSTREAM_BASE_URL}/subscribers?mobile_number=${encodeURIComponent(phone)}`, {
        method: "get",
        headers: apiHeaders,
        muteHttpExceptions: true
      });
      
      console.log(`Search API Response Code: ${searchResponse.getResponseCode()}`);
      console.log(`Search API Response Body: ${searchResponse.getContentText()}`);
      
      const searchResult = JSON.parse(searchResponse.getContentText());

      if (searchResponse.getResponseCode() === 200 && searchResult.data && searchResult.data.length > 0) {
        isNewSubscriber = false;
        existingSubscriber = searchResult.data[0];
      }
    } else {
      console.log(`No phone number provided. Skipping GET request search and proceeding directly to creation via email.`);
    }

    // 7. Execute PATCH (update) or POST (create)
    if (!isNewSubscriber && existingSubscriber) {
      const subscriberId = existingSubscriber.id;
      console.log(`Subscriber exists (ID: ${subscriberId}). Preparing PATCH request.`);
      
      const existingListIds = existingSubscriber.lists ? existingSubscriber.lists.map(list => list.id) : [];
      const combinedListIds = [...new Set([...existingListIds, ...newListIds])];

      const updatePayload = {
        "first": firstName || existingSubscriber.first, 
        "last": lastName || existingSubscriber.last,
      };

      // Only include lists in the update if there are IDs to set
      if (combinedListIds.length > 0) {
        updatePayload.lists = combinedListIds;
      }
      
      if (email || existingSubscriber.email) {
        updatePayload.email = email || existingSubscriber.email;
      }
      if (phone && !existingSubscriber.mobile_number) {
          updatePayload.mobile_number = phone;
      }

      console.log(`PATCH Payload:`, JSON.stringify(updatePayload));

      const patchResponse = UrlFetchApp.fetch(`${CLEARSTREAM_BASE_URL}/subscribers/${subscriberId}`, {
        method: "patch", 
        headers: apiHeaders,
        payload: JSON.stringify(updatePayload),
        muteHttpExceptions: true 
      });

      console.log(`PATCH Response Code: ${patchResponse.getResponseCode()}`);
      console.log(`PATCH Response Body: ${patchResponse.getContentText()}`);

    } else {
      console.log(`New subscriber (or email-only). Preparing POST request.`);
      const subscriberPayload = {
        "first": firstName,
        "last": lastName,
        "double_optin": false,
        "overwrite_attributes": true
      };

      // Only include lists if the person selected any interests
      if (newListIds.length > 0) {
        subscriberPayload.lists = newListIds;
      }
      
      if (phone) {
        subscriberPayload.mobile_number = phone;
      }
      if (email) {
        subscriberPayload.email = email;
      }
      
      console.log(`POST Payload:`, JSON.stringify(subscriberPayload));
      
      const postResponse = UrlFetchApp.fetch(`${CLEARSTREAM_BASE_URL}/subscribers`, {
        method: "post",
        headers: apiHeaders,
        payload: JSON.stringify(subscriberPayload),
        muteHttpExceptions: true
      });
      
      console.log(`POST Response Code: ${postResponse.getResponseCode()}`);
      console.log(`POST Response Body: ${postResponse.getContentText()}`);
    }

    // 8. Apply signup tag based on sheet name (only if phone number is available,
    //    since the Clearstream tag API requires a mobile number to identify the subscriber)
    if (phone) {
      const tagId = findOrCreateTag(CLEARSTREAM_BASE_URL, apiHeaders, signupTagName);
      if (tagId) {
        console.log(`Applying tag ID ${tagId} ("${signupTagName}") to ${phone}`);
        const tagResponse = UrlFetchApp.fetch(`${CLEARSTREAM_BASE_URL}/tags/${tagId}/subscribers`, {
          method: "post",
          headers: apiHeaders,
          payload: JSON.stringify({ "mobile_numbers": [phone] }),
          muteHttpExceptions: true
        });
        console.log(`Tag Apply Response Code: ${tagResponse.getResponseCode()}`);
        console.log(`Tag Apply Response Body: ${tagResponse.getContentText()}`);
      }
    } else {
      console.log("No phone number — skipping tag application.");
    }

    // 9. Send welcome text to new subscribers only
    if (phone && isNewSubscriber) {
      const textPayload = {
        "to": phone,
        "text_body": WELCOME_TEXT_MESSAGE,
        "use_default_header": true
      };
      
      console.log(`Sending Welcome Text Payload:`, JSON.stringify(textPayload));
      
      const textResponse = UrlFetchApp.fetch(`${CLEARSTREAM_BASE_URL}/texts`, {
        method: "post",
        headers: apiHeaders,
        payload: JSON.stringify(textPayload),
        muteHttpExceptions: true
      });
      
      console.log(`Text Response Code: ${textResponse.getResponseCode()}`);
      console.log(`Text Response Body: ${textResponse.getContentText()}`);
    } else {
      console.log("No welcome text sent (no phone number, or returning subscriber).");
    }
    
    console.log("Script completed successfully.");

  } catch (error) {
    console.error("Caught Exception in API blocks:", error.toString());
  }
}

// findOrCreateTag looks up a tag by name in Clearstream, creating it if it doesn't exist yet.
// Returns the tag ID, or null if the lookup/creation fails.
function findOrCreateTag(baseUrl, apiHeaders, tagName) {
  console.log(`Looking up tag: "${tagName}"`);

  const searchResponse = UrlFetchApp.fetch(
    `${baseUrl}/tags?filter[name]=${encodeURIComponent(tagName)}`,
    { method: "get", headers: apiHeaders, muteHttpExceptions: true }
  );
  console.log(`Tag search response (${searchResponse.getResponseCode()}):`, searchResponse.getContentText());

  if (searchResponse.getResponseCode() === 200) {
    const result = JSON.parse(searchResponse.getContentText());
    if (Array.isArray(result.data) && result.data.length > 0) {
      const existingTag = result.data.find(t => t.name === tagName);
      if (existingTag) {
        console.log(`Found existing tag ID: ${existingTag.id}`);
        return existingTag.id;
      }
    }
  }

  // Tag not found — create it
  console.log(`Tag not found. Creating new tag: "${tagName}"`);
  const createResponse = UrlFetchApp.fetch(`${baseUrl}/tags`, {
    method: "post",
    headers: apiHeaders,
    payload: JSON.stringify({ "name": tagName }),
    muteHttpExceptions: true
  });
  console.log(`Tag create response (${createResponse.getResponseCode()}):`, createResponse.getContentText());

  if (createResponse.getResponseCode() === 200 || createResponse.getResponseCode() === 201) {
    const created = JSON.parse(createResponse.getContentText());
    if (created.data && created.data.id) {
      console.log(`Created new tag ID: ${created.data.id}`);
      return created.data.id;
    }
  }

  console.error(`Failed to find or create tag "${tagName}"`);
  return null;
}
