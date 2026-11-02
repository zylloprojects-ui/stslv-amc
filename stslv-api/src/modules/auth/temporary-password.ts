import { randomInt } from "node:crypto";

/** How long a temporary password can be used to sign in and choose a new one. */
export const TEMPORARY_PASSWORD_MINUTES = 15;

// Letters and digits that cannot be mistaken for one another when read aloud or
// copied by hand: no 0/O/o, 1/l/I, 5/S/s.
const ALPHABET = "ABCDEFGHJKLMNPQRTUVWXYZabcdefghijkmnpqrtuvwxyz2346789";
const GROUPS = 4;
const GROUP_LENGTH = 4;

/**
 * A random temporary password such as "Kp7r-Xw2m-Tq9a-Hd4e": 16 characters from
 * a 53-character alphabet (about 92 bits), picked with the operating system's
 * cryptographic generator. randomInt is unbiased, so every character is equally likely.
 */
export function generateTemporaryPassword(): string {
  const groups: string[] = [];

  for (let group = 0; group < GROUPS; group += 1) {
    let text = "";

    for (let i = 0; i < GROUP_LENGTH; i += 1) {
      text += ALPHABET[randomInt(ALPHABET.length)];
    }
    groups.push(text);
  }

  return groups.join("-");
}
