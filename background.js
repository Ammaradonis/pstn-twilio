let uiTabId = null;
let over = false;

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('🎯 Extension installed');
});

function fetchWithTimeout(resource, options = {}, timeout = 12000) {
  return Promise.race([
    fetch(resource, options),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Fetch timed out')), timeout)),
  ]);
}

function isPlausibleName(cand) {
  if (!cand) return false;
  const c = cand.trim();
  // Must be exactly two (or three w/ middle initial) capitalized tokens
  if (!/^[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+$/.test(c)) return false;
  // Reject known template placeholders and non-name words
  const banned =
    /\b(first|last|firstname|lastname|the|husband|wife|team|owner|founder|doctor|doctors|dr|dds|dmd|md|ops|tsdc|company|name|lorem|ipsum)\b/i;
  if (banned.test(c)) return false;
  // Reject the specific dummy full-names
  if (/^(john|jane)\s+(doe|smith)$/i.test(c)) return false;
  // Reject name-glued-to-verb
  if (
    /\b(started|runs|opened|created|joined|leads|owns|founded|built|began|loves|offers|brings|serves|treats)\b/i.test(
      c,
    )
  )
    return false;
  return true;
}

function extractOwnerName(html, email) {
  // Best-effort owner/founder name. Returns "" when unsure. This is a HINT, not a guarantee.
  try {
    // Strip tags to plain-ish text for proximity matching
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ');

    // Require a full First Last (both capitalized), optional middle initial.
    const nameToken = '([A-Z][a-z]+(?:\\s+[A-Z]\\.?)?\\s+[A-Z][a-z]+)';

    // Only accept a name when it sits DIRECTLY beside an explicit role word, with the role
    // as a label (role: Name) or an explicit "owned/founded by Name", or "Name, Owner".
    // The trailing-role pattern requires a comma so "Josanne started ..." cannot match.
    const rolePatterns = [
      new RegExp(
        '(?:owner|founder|co-?founder|proprietor|owned by|founded by)\\s*[:\\-–]\\s*' + nameToken,
        'i',
      ),
      new RegExp('(?:owned|founded)\\s+by\\s+' + nameToken, 'i'),
      new RegExp(nameToken + '\\s*,\\s*(?:owner|founder|co-?founder|proprietor)\\b', 'i'),
    ];
    for (const re of rolePatterns) {
      const m = text.match(re);
      if (m && m[1]) {
        const cand = m[1].trim();
        if (isPlausibleName(cand)) return cand;
      }
    }

    // Pattern 2: derive from a personal-looking email prefix (john.smith@, johnsmith@)
    if (email) {
      const prefix = email.split('@')[0].toLowerCase();
      // skip role/generic/ops inboxes
      const generic =
        /^(info|contact|hello|admin|office|sales|support|team|mail|help|service|services|booking|appointments|frontdesk|reception|ops|operations|care|billing|insurance|newpatient|newpatients|smile|grin|hi|hey|dental|dentist|marketing|webreporting|reporting)$/;
      const parts = prefix.includes('.')
        ? prefix.split('.')
        : prefix.includes('_')
          ? prefix.split('_')
          : null;
      if (
        parts &&
        parts.length === 2 &&
        !generic.test(parts[0]) &&
        !generic.test(parts[1]) &&
        /^[a-z]{2,}$/.test(parts[0]) &&
        /^[a-z]{2,}$/.test(parts[1])
      ) {
        const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
        const cand = cap(parts[0]) + ' ' + cap(parts[1]);
        if (isPlausibleName(cand)) return cand;
      }
    }
    return '';
  } catch {
    return '';
  }
}

function isAclk(url) {
  return /google\.[a-z.]+\/aclk/i.test(url || '');
}

function siteDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function pickEmail(matches, siteUrl) {
  if (!matches || !matches.length) return '';
  // Reject noise, placeholders, template dummies, and asset filenames
  const bad =
    /(noreply|no-reply|donotreply|sentry|wixpress|@wordpress|@sentry|\.png$|\.jpg$|\.jpeg$|\.gif$|\.webp$)/i;
  const placeholder =
    /^(email|youremail|your-email|name|firstname|lastname|first\.last|firstname\.lastname|user|username|test|sample|demo)@|@(domain|example|yourdomain|yoursite|email|test|sample|company|dentaloffice|yourcompany)\.[a-z]+$/i;
  let good = matches.filter((m) => !bad.test(m) && !placeholder.test(m));
  if (!good.length) return '';

  // Strongly prefer an email whose domain matches the business's own website domain.
  // This rejects web-designer footer credits like info@stagheaddesigns.com on a nakedmd.com site.
  const dom = siteDomain(siteUrl);
  if (dom) {
    const sameDomain = good.filter((m) => {
      const ed = m.split('@')[1]?.toLowerCase() || '';
      return ed === dom || ed.endsWith('.' + dom) || dom.endsWith('.' + ed);
    });
    if (sameDomain.length) {
      good = sameDomain;
    } else {
      // No email on the business's own domain. Drop obvious web-agency / designer / platform
      // credits so we never return the site builder's inbox instead of the business's.
      const agency =
        /(design|designs|studio|studios|agency|media|marketing|webdev|websites?|creative|digital|hosting|squarespace|wix|godaddy|shopify|glossgenius|gargle|webreporting|reporting)\./i;
      const nonAgency = good.filter((m) => !agency.test(m.split('@')[1] || ''));
      // If dropping agencies leaves nothing, return "" (no email beats the wrong email).
      good = nonAgency;
    }
  }
  if (!good.length) return '';

  // Among the remaining, prefer real business inboxes
  const preferred = good.find((m) =>
    /^(info|contact|hello|office|admin|sales|owner|frontdesk|booking|clientcare|care|appointments|hi)@/i.test(
      m,
    ),
  );
  return preferred || good[0] || '';
}

async function fetchText(url) {
  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return '';
    return await response.text();
  } catch {
    return '';
  }
}

function candidatePages(baseUrl) {
  const pages = [baseUrl];
  try {
    const u = new URL(baseUrl);
    const root = `${u.protocol}//${u.host}`;
    for (const p of ['/contact', '/contact-us', '/about', '/about-us']) {
      pages.push(root + p);
    }
  } catch {
    /* baseUrl not parseable, just use it */
  }
  return pages;
}

async function scrapeEmailFromWebsite(url) {
  // Google ad-click redirect links are not real sites. Skip them.
  if (!url || isAclk(url)) {
    return { email: '', ownerName: '', skipped: isAclk(url) ? 'aclk' : 'no-url' };
  }

  const emailRegex =
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.(?!jpg|jpeg|png|webp|gif|svg|pdf)([a-zA-Z]{2,})/g;

  let email = '';
  let ownerName = '';

  // Try homepage first, then contact/about pages, stopping once we have an email.
  for (const page of candidatePages(url)) {
    const text = await fetchText(page);
    if (!text) continue;

    if (!email) {
      const matches = text.match(emailRegex);
      email = pickEmail(matches, url);
    }
    if (!ownerName) {
      ownerName = extractOwnerName(text, email);
    }
    if (email && ownerName) break; // got both, done early
  }

  return { email, ownerName };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'fetchHTML') {
    fetch(msg.url)
      .then((res) => res.text())
      .then((html) => sendResponse({ html }))
      .catch((err) => sendResponse({ error: err.toString() }));
    return true; // keep channel open for async
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.action === 'resetAndReturn') {
    console.log('START OVER MESSAGE RECIEVED');
    // Clear saved leads
    chrome.storage.local.clear(() => {
      console.log('🧹 Leads reset from storage');
    });

    // Close the Google Maps tab
    if (sender.tab?.id) {
      chrome.tabs.remove(sender.tab.id);
    }

    // Return to popup.html tab (UI tab)
    if (uiTabId !== null) {
      chrome.tabs.update(uiTabId, {
        active: true,
        url: chrome.runtime.getURL('popup.html'),
      });
    } else {
      // Fallback: open new UI tab
      chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
    }
  }

  if (message.action === 'registerUITab') {
    if (sender.tab?.id) {
      uiTabId = sender.tab.id;
      console.log('✅ UI tab registered:', uiTabId);
    }
  }

  if (message.action === 'openMaps') {
    chrome.tabs.create({ url: message.url }, (tab) => {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['maps.js'],
      });
    });
  }

  if (message.action === 'doneCollecting') {
    console.log("✅ Received 'doneCollecting'");
    if (uiTabId !== null) {
      chrome.tabs.update(uiTabId, { active: true }, () => {
        chrome.tabs.sendMessage(uiTabId, { action: 'showSpreadsheet' });
      });
    } else {
      // Fallback: open new UI tab and register it once it's ready
      chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') }, (tab) => {
        uiTabId = tab.id; // ✅ Set uiTabId so we don’t open more than one
        // Delay sending message until content script loads
        setTimeout(() => {
          chrome.tabs.sendMessage(uiTabId, { action: 'showSpreadsheet' });
        }, 1500);
      });
    }
  }

  if (message.action === 'reset') {
    over = true;
    console.log('setting it to true');
    chrome.storage.local.clear(() => {
      console.log('🧹 Storage cleared');
    });

    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((tab) => {
        if (tab.url?.includes('google.com/maps')) {
          chrome.tabs.remove(tab.id);
        }
      });
    });

    if (uiTabId !== null) {
      chrome.tabs.update(uiTabId, { url: chrome.runtime.getURL('popup.html') });
    }
  }

  if (message.action === 'addEmails') {
    console.log('🔍 Starting email scraping...');
    over = false;
    chrome.storage.local.get('leads', async ({ leads }) => {
      const updatedLeads = [];

      for (const [index, lead] of leads.entries()) {
        console.log(over);

        if (!lead.website) {
          lead.email = lead.email || '';
        } else {
          const result = await scrapeEmailFromWebsite(lead.website);
          lead.email = result.email;
          if (result.ownerName && !lead.ownerName) lead.ownerName = result.ownerName;
          updatedLeads.push(lead);
        }
        if (over) {
          console.warn('❌ Process cancelled');
          return;
        }
        // ✅ Always update progress — even on timeout or skip
        chrome.runtime.sendMessage({
          action: 'updateProgress',
          current: index + 1,
          total: leads.length,
          label: 'Hunting emails',
        });
      }

      console.log('checked all leads');
      console.log(leads);

      chrome.storage.local.set({ leads: updatedLeads }, () => {
        if (uiTabId !== null) {
          chrome.tabs.sendMessage(uiTabId, { action: 'showSpreadsheet', leads: leads });
        }
      });
      //chrome.tabs.sendMessage(uiTabId, { action: "showSpreadsheet", leads: leads });
      console.log('✅ All emails checked and saved');
    });
  }
});
