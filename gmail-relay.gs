/**
 * BRP-AMS Gmail Relay — Google Apps Script
 * ==========================================
 * Deploys as a Web App that accepts POST requests with { to, subject, html }
 * and sends the email via Gmail.
 *
 * SETUP (one-time, ~3 minutes):
 * 1. Go to https://script.google.com
 * 2. Create New Project → paste this entire file
 * 3. Click "Deploy" → "New deployment"
 *    - Type: Web app
 *    - Execute as: Me (your Gmail account)
 *    - Who has access: Anyone
 * 4. Click "Deploy" → copy the Web App URL
 * 5. Paste the URL in Render env var: GMAIL_RELAY_URL=<your-url>
 *    AND in ams-backend/.env: GMAIL_RELAY_URL=<your-url>
 */

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const { to, subject, html } = data;

    if (!to || !subject || !html) {
      return ContentService
        .createTextOutput(JSON.stringify({ success: false, error: 'Missing to/subject/html' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    GmailApp.sendEmail(to, subject, '', { htmlBody: html });

    return ContentService
      .createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Test function — run this inside Apps Script editor to verify it works
function testEmail() {
  const result = doPost({
    postData: {
      contents: JSON.stringify({
        to: 'tenders@raminfo.com',
        subject: '[BRP AMS] Relay Test',
        html: '<h2>Gmail Relay Working!</h2><p>Your email relay is configured correctly.</p>'
      })
    }
  });
  Logger.log(result.getContent());
}
