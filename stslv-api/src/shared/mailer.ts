import { env, type MailTransport } from "../config/env";

// The one place the API sends email from. Callers build a message and hand it
// over; how it is delivered is decided by MAIL_TRANSPORT (see config/env.ts).
// Adding a real provider means adding one transport here: nothing else changes.

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text. May contain a single-use link, so it is never logged except by the "log" transport. */
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Messages "sent" during the automated tests. Empty unless MAIL_TRANSPORT=memory. */
export const testOutbox: MailMessage[] = [];

const transports: Record<MailTransport, Mailer> = {
  // Email is not configured. Only the fact that a message was dropped is recorded:
  // not the recipient, and never the body.
  none: {
    async send(message) {
      console.warn(`Email not sent (MAIL_TRANSPORT=none): "${message.subject}".`);
    },
  },
  // Local development only. config/env.ts refuses this transport in production.
  log: {
    async send(message) {
      console.log(
        [
          "----- Development email (MAIL_TRANSPORT=log, never used in production) -----",
          `To: ${message.to}`,
          `Subject: ${message.subject}`,
          "",
          message.text,
          "-----------------------------------------------------------------------------",
        ].join("\n")
      );
    },
  },
  memory: {
    async send(message) {
      testOutbox.push(message);
    },
  },
};

export function createMailer(transport: MailTransport): Mailer {
  return transports[transport];
}

export const mailer: Mailer = createMailer(env.mailTransport);

/**
 * Sends without making the caller wait, so a public response takes the same
 * time whether or not a message goes out. A failure is logged without the
 * message content.
 */
export function sendInBackground(message: MailMessage): void {
  mailer.send(message).catch((error: unknown) => {
    console.error(`Email "${message.subject}" could not be sent: ${error instanceof Error ? error.message : "Unknown error"}`);
  });
}
