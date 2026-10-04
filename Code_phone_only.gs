function onFormSubmitPhoneOnly(e) {
  console.log("Script triggered. Raw namedValues:", JSON.stringify(e.namedValues));

  const namedValues = e.namedValues;

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

  // 2. Extract values using the substring search
  const interestsRaw = getFieldValueByContains("contacted about");
  
  if (!interestsRaw) {
    console.log("EXITING EARLY: 'contacted about' was empty or column not found.");
    return;
  }

  const selectedInterests = interestsRaw.split(",").map(s => s.trim());
  console.log("Parsed selected interests array:", selectedInterests);

  // 3. Map form string values to Clearstream List IDs (Case-insensitive Contains)
  const listMapping = {
    "Bible Discussion": 329652,
    "Workshops": 333208,
    "Fun Events": 357670,
    "Church": 338088
  };
  
  const newListIds = [];
  
  selectedInterests.forEach(interest => {
    const interestLower = interest.toLowerCase();
    let matched = false;
    
    for (const [keyword, listId] of Object.entries(listMapping)) {
      if (interestLower.includes(keyword.toLowerCase())) {
        if (!newListIds.includes(listId)) { // Prevent duplicate IDs
          newListIds.push(listId);
        }
        matched = true;
        console.log(`Matched list! Form interest '${interest}' contains '${keyword}'. Added ID: ${listId}`);
      }
    }
    
    if (!matched) {
      console.log(`Notice: Form interest '${interest}' did not contain any keyword from listMapping.`);
    }
  });
  
  console.log("Mapped List IDs to add:", newListIds);

  if (newListIds.length === 0) {
    console.log("EXITING EARLY: None of the selected interests matched a Clearstream List ID.");
    return; 
  }

  // 4. Extract User Info
  const firstName = getFieldValueByContains("first name"); 
  const lastName = getFieldValueByContains("last name"); 
  const email = getFieldValueByContains("email"); 
  
  const phone = getFieldValueByContains("phone"); 
  
  if (!phone) {
    console.log("EXITING EARLY: Phone number was missing or column not found.");
    return;
  }

  // 5. Prepare Clearstream API Configuration
  // apiKey is a placeholder — never commit a real key here. Run ./deploy.sh to substitute in the
  // real value (from env/production.env) before pasting into Apps Script.
  const apiKey = "__CLEARSTREAM_API_KEY__";
  const baseUrl = "https://api.getclearstream.com/v1";
  const apiHeaders = {
    "X-Api-Key": apiKey,
    "Content-Type": "application/json"
  };

  try {
    // 6. Check if subscriber already exists
    console.log(`Making GET request to check subscriber: ${phone}`);
    const searchResponse = UrlFetchApp.fetch(`${baseUrl}/subscribers?mobile_number=${encodeURIComponent(phone)}`, {
      method: "get",
      headers: apiHeaders,
      muteHttpExceptions: true
    });
    
    console.log(`Search API Response Code: ${searchResponse.getResponseCode()}`);
    console.log(`Search API Response Body: ${searchResponse.getContentText()}`);
    
    const searchResult = JSON.parse(searchResponse.getContentText());
    let isNewSubscriber = true;

    if (searchResponse.getResponseCode() === 200 && searchResult.data && searchResult.data.length > 0) {
      isNewSubscriber = false;
      const existingSubscriber = searchResult.data[0];
      const subscriberId = existingSubscriber.id;
      console.log(`Subscriber exists (ID: ${subscriberId}). Preparing PATCH request.`);
      
      const existingListIds = existingSubscriber.lists ? existingSubscriber.lists.map(list => list.id) : [];
      const combinedListIds = [...new Set([...existingListIds, ...newListIds])];

      const updatePayload = {
        "first": firstName || existingSubscriber.first, 
        "last": lastName || existingSubscriber.last,
        "lists": combinedListIds
      };
      
      if (email || existingSubscriber.email) {
        updatePayload.email = email || existingSubscriber.email;
      }

      console.log(`PATCH Payload:`, JSON.stringify(updatePayload));

      const patchResponse = UrlFetchApp.fetch(`${baseUrl}/subscribers/${encodeURIComponent(phone)}`, {
        method: "patch", 
        headers: apiHeaders,
        payload: JSON.stringify(updatePayload),
        muteHttpExceptions: true 
      });

      console.log(`PATCH Response Code: ${patchResponse.getResponseCode()}`);
      console.log(`PATCH Response Body: ${patchResponse.getContentText()}`);

    } else {
      console.log(`New subscriber. Preparing POST request.`);
      const subscriberPayload = {
        "mobile_number": phone,
        "first": firstName,
        "last": lastName,
        "lists": newListIds,
        "double_optin": false,
        "overwrite_attributes": true
      };
      
      if (email) {
        subscriberPayload.email = email;
      }
      
      console.log(`POST Payload:`, JSON.stringify(subscriberPayload));
      
      const postResponse = UrlFetchApp.fetch(`${baseUrl}/subscribers`, {
        method: "post",
        headers: apiHeaders,
        payload: JSON.stringify(subscriberPayload),
        muteHttpExceptions: true
      });
      
      console.log(`POST Response Code: ${postResponse.getResponseCode()}`);
      console.log(`POST Response Body: ${postResponse.getContentText()}`);
    }

    // 7. Send Context-Aware Message
    let messageBody = isNewSubscriber 
      ? `Welcome to the Michigan International Student Ministry text group, we'll send you updates from this number!`
      : `We've updated your list preferences based on what you're interested in!`;
    messageBody += "\n\nReply STOP to opt out";

    const textPayload = {
      "to": phone,
      "text_body": messageBody,
      "use_default_header": true
    };
    
    console.log(`Sending Welcome Text Payload:`, JSON.stringify(textPayload));
    
    const textResponse = UrlFetchApp.fetch(`${baseUrl}/texts`, {
      method: "post",
      headers: apiHeaders,
      payload: JSON.stringify(textPayload),
      muteHttpExceptions: true
    });
    
    console.log(`Text Response Code: ${textResponse.getResponseCode()}`);
    console.log(`Text Response Body: ${textResponse.getContentText()}`);
    
    console.log("Script completed successfully.");

  } catch (error) {
    console.error("Caught Exception in API blocks:", error.toString());
  }
}
