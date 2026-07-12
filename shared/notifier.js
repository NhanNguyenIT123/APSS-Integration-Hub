/**
 * APSS Integration Hub — Notification System Helper
 * 
 * Handles email notifications for new RFQs.
 */

const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
let appConfig = {};
try {
  appConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch (e) {
  console.warn("Could not load config.json:", e.message);
}

/**
 * Sends an email notification using APSS Outlook SMTP or local fallback settings.
 * 
 * @param {Array} newRfqs List of newly discovered RFQs
 * @param {string} portal Name of the portal (e.g. 'POSCO e-Pro', 'PTTEP FlashBuy')
 */
async function sendRfqEmailNotification(newRfqs, portal) {
  if (!newRfqs || newRfqs.length === 0) return;

  console.log(`✉️ Preparing email notification for ${newRfqs.length} new RFQ(s) from ${portal}...`);

  // Define target emails
  const testRecipient = appConfig.testRecipient;
  
  if (!testRecipient) {
    console.warn("⚠️ No testRecipient defined in config.json. Email notification skipped.");
    return;
  }
  
  // ---------------------------------------------------------
  // Setup Nodemailer transporter using provided credentials
  // ---------------------------------------------------------
  const transporter = nodemailer.createTransport({
    host: appConfig.smtpHost || 'smtp.office365.com',
    port: parseInt(appConfig.smtpPort) || 587,
    secure: appConfig.smtpSecure === 'true', // TLS
    auth: {
      user: appConfig.emailUser,
      pass: appConfig.emailPass
    },
    tls: {
      ciphers: 'SSLv3',
      rejectUnauthorized: false
    }
  });

  let rfqListHtml = '';
  newRfqs.forEach((rfq, idx) => {
    rfqListHtml += `
      <tr style="border-bottom: 1px solid #dddddd;">
        <td style="padding: 12px; font-weight: bold; color: #1f2937;">${idx + 1}</td>
        <td style="padding: 12px; color: #3b82f6; font-weight: bold;">
          <a href="${rfq.detail_url || '#'}" style="text-decoration: none; color: #3b82f6;">${rfq.rfq_no}</a>
        </td>
        <td style="padding: 12px; color: #4b5563;">${rfq.subject || 'No Description'}</td>
        <td style="padding: 12px; color: #4b5563;">${rfq.drafter || 'Unknown'}</td>
        <td style="padding: 12px; color: #e11d48; font-weight: bold;">${rfq.close_date || 'N/A'}</td>
        <td style="padding: 12px; color: #10b981; font-weight: bold;">${rfq.items?.length || 0}</td>
      </tr>
    `;
  });

  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>New RFQ Notification</title>
    </head>
    <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 20px; background-color: #f3f4f6;">
      <div style="max-width: 800px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05); border: 1px solid #e5e7eb;">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); padding: 30px; text-align: center;">
          <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 700; letter-spacing: 0.5px;">APSS INTEGRATION HUB</h1>
          <p style="color: #bfdbfe; margin: 5px 0 0 0; font-size: 14px;">Real-time RFQ Notification Alert</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 30px;">
          <h2 style="color: #111827; margin-top: 0; font-size: 18px;">Hello Nick,</h2>
          <p style="color: #4b5563; font-size: 15px; line-height: 1.6;">
            The APSS Scraper has completed a live run and detected <strong>${newRfqs.length} new active RFQ(s)</strong> on the <strong>${portal}</strong> portal. These items have been successfully loaded into the integration database and are ready for preview in Business Central.
          </p>
          
          <!-- Table -->
          <div style="margin: 25px 0; overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 14px;">
              <thead>
                <tr style="background-color: #f9fafb; border-bottom: 2px solid #e5e7eb;">
                  <th style="padding: 12px; color: #374151; font-weight: 600;">No.</th>
                  <th style="padding: 12px; color: #374151; font-weight: 600;">RFQ No.</th>
                  <th style="padding: 12px; color: #374151; font-weight: 600;">Subject Description</th>
                  <th style="padding: 12px; color: #374151; font-weight: 600;">Drafter</th>
                  <th style="padding: 12px; color: #374151; font-weight: 600;">Close Date</th>
                  <th style="padding: 12px; color: #374151; font-weight: 600;">Items</th>
                </tr>
              </thead>
              <tbody>
                ${rfqListHtml}
              </tbody>
            </table>
          </div>
          
          <div style="text-align: center; margin: 30px 0 10px 0;">
            <a href="http://localhost:3000" style="background-color: #1e3a8a; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 14px; display: inline-block; box-shadow: 0 2px 4px rgba(30,58,138,0.2);">
              Open Integration Hub Dashboard
            </a>
          </div>
        </div>
        
        <!-- Footer -->
        <div style="background-color: #f9fafb; padding: 20px; text-align: center; border-top: 1px solid #e5e7eb; font-size: 12px; color: #9ca3af;">
          <p style="margin: 0 0 5px 0;">Asia Pacific Solutions Supply Pte Ltd.</p>
          <p style="margin: 0;">3 Gambas Crescent #06-10 Nordcom I, Singapore 757088</p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    const info = await transporter.sendMail({
      from: '"APSS Integration Hub" <nick.nguyen@apss.com>',
      to: testRecipient,
      subject: `[APSS Hub Alert] ${newRfqs.length} New RFQ(s) Discovered from ${portal}`,
      html: emailHtml
    });
    console.log(`✉️ Email notification sent successfully! MessageId: ${info.messageId}`);
  } catch (err) {
    // If Office 365 SMTP fails (e.g. requires 2FA or blocks local connection), fall back to direct logger/Ethereal
    console.error(`⚠️ SMTP configuration failed to send email: ${err.message}`);
    console.log('🔄 Falling back to mock Ethereal mail server for demonstration...');
    try {
      const testAccount = await nodemailer.createTestAccount();
      const etherealTransporter = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass
        }
      });
      const info = await etherealTransporter.sendMail({
        from: '"APSS Integration Hub" <nick.nguyen@apss.com>',
        to: testRecipient,
        subject: `[Demo Alert] ${newRfqs.length} New RFQ(s) from ${portal}`,
        html: emailHtml
      });
      console.log(`✉️ Ethereal Demo Email Sent! URL: ${nodemailer.getTestMessageUrl(info)}`);
    } catch (fallbackErr) {
      console.error(`❌ Failed to send fallback email: ${fallbackErr.message}`);
    }
  }
}

module.exports = { sendRfqEmailNotification };
