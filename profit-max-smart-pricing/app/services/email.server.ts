// ---------------------------------------------------------------------------
// Email service stub
//
// Logs the email to the console for now. Replace the body of sendEmail with
// a real email provider integration (e.g. Resend, SendGrid, Postmark) when
// ready to send real emails.
// ---------------------------------------------------------------------------

export async function sendEmail({
  to,
  subject,
  body,
}: {
  to: string;
  subject: string;
  body: string;
}): Promise<void> {
  console.log("[PricePilot] sendEmail (stub):", { to, subject, body });
}
