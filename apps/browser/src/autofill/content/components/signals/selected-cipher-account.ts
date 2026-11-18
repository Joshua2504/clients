import { signal } from "@lit-labs/signals";

/** The account that owns the cipher in `selectedCipher`. A cipher id alone does not name one. */
export const selectedCipherAccount = signal<string | null>(null);
