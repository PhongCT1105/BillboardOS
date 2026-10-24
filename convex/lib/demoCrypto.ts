/**
 * At-rest encryption for the hosted demo agents' plaintext agent keys
 * (ADR 0006). AES-256-GCM with a key derived from INTERNAL_API_SECRET
 * (SHA-256 of the secret and a purpose label). Web Crypto only.
 */

const PURPOSE = "billboardos:demo-agents:v1";

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function aesKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 16) throw new Error("INTERNAL_API_SECRET (16+ chars) is required to store demo agent keys");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${PURPOSE}:${secret}`));
  return await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(secret: string, plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(PURPOSE) },
    await aesKey(secret),
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: b64(new Uint8Array(data)), iv: b64(iv) };
}

export async function decryptSecret(secret: string, ciphertext: string, iv: string): Promise<string> {
  const data = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(iv), additionalData: new TextEncoder().encode(PURPOSE) },
    await aesKey(secret),
    unb64(ciphertext),
  );
  return new TextDecoder().decode(data);
}
