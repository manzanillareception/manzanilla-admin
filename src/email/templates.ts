const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface WelcomeInput {
  hotelName: string;
  loginEmail: string;
  password: string;
  loginUrl: string;
  supportEmail: string;
}

export function renderWelcome(i: WelcomeInput): { subject: string; text: string; html: string } {
  const subject = `Your Manzanilla login for ${i.hotelName}`;
  const text = [
    `Welcome to Manzanilla, ${i.hotelName}.`,
    "",
    `Email: ${i.loginEmail}`,
    `Password: ${i.password}`,
    "",
    "1. Connect the tablet to hotel Wi-Fi.",
    "2. Open the Manzanilla app and sign in with the email and password above.",
    "3. Your team will approve the tablet; this can take a short while.",
    "",
    "You can keep this password or change it any time. Forgot it? Use Forgot password on the sign-in page.",
    `Questions: reply to this email or write to ${i.supportEmail}.`,
  ].join("\n");
  const html =
    `<p>Welcome to Manzanilla, ${esc(i.hotelName)}.</p>` +
    `<p>Email: <b>${esc(i.loginEmail)}</b><br>Password: <b style="font-family:monospace">${esc(i.password)}</b></p>` +
    `<ol><li>Connect the tablet to hotel Wi-Fi.</li><li>Open the Manzanilla app and sign in with the details above.</li>` +
    `<li>Your team will approve the tablet; this can take a short while.</li></ol>` +
    `<p>You can keep this password or change it any time. Forgot it? Use Forgot password on the sign-in page.</p>` +
    `<p>Questions: reply to this email or write to ${esc(i.supportEmail)}.</p>`;
  return { subject, text, html };
}

/** Guide without any password, for use after the retry deadline. */
export function renderGuideOnly(i: Omit<WelcomeInput, "password">) {
  const subject = `Manzanilla sign-in guide for ${i.hotelName}`;
  const text = [
    `Hello ${i.hotelName},`,
    `Your sign-in email is ${i.loginEmail}.`,
    "Use Forgot password on the sign-in page to set a password.",
    `Questions: reply to this email or write to ${i.supportEmail}.`,
  ].join("\n");
  return { subject, text, html: `<p>${esc(text).replace(/\n/g, "<br>")}</p>` };
}

export interface AlertInput {
  incidentId: string;
  severity: "critical" | "warning";
  kind: string;
  hotelName: string;
  deviceLabel: string;
  dashboardUrl: string;
}

/** Server-owned content only; no device-supplied free text. */
export function renderAlert(i: AlertInput) {
  const subject = `[${i.severity}] ${i.kind} - ${i.hotelName}`;
  const text = [
    `Incident ${i.incidentId}`,
    `Hotel: ${i.hotelName}`,
    `Device: ${i.deviceLabel}`,
    `Type: ${i.kind}`,
    `Open: ${i.dashboardUrl}`,
    "Delivery of this email is not acknowledgement. Acknowledge in the dashboard.",
  ].join("\n");
  return { subject, text, html: `<pre>${esc(text)}</pre>` };
}
