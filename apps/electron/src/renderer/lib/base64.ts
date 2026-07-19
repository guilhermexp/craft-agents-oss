const BASE64_CHUNK_SIZE = 0x8000

/** Encode bytes without spreading an arbitrarily large array onto the JS call stack. */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE))
  }
  return btoa(binary)
}
